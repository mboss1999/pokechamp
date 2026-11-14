'use strict';
// Hidden information. In Champions ranked you see the opponent's six species at team preview and nothing
// else: not their sets, not which three they brought. This module reads what a player has actually seen
// from the battle log, keeps a belief over each opposing Pokémon's set (from the simulated meta), and
// builds "determinized" copies of a battle in which the opponent's unseen details are re-drawn from that
// belief. Searching over such copies lets an agent or a reviewer reason without peeking.

const {Battle} = require('pokemon-showdown');
const {toPokemonSet} = require('./refine');
const {clean, setKey} = require('./util');

const toID = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// Within one roster entry: the best set is most likely, its alternatives less so.
const ALT_WEIGHTS = [1, 0.5, 0.35, 0.25];

/**
 * Prior over sets for each species, from results.json: weight(entry) ∝ exp((rating - 1500) / temperature),
 * so Mega and non-Mega options of a species compete by strength, then ALT_WEIGHTS within the entry.
 * @returns Map<speciesId, [{set: PokemonSet, w}]>
 */
function setPrior(results, temperature = 120) {
	const prior = new Map();
	for (const e of results.entries) {
		const ew = Math.exp((e.rating - 1500) / temperature);
		const list = prior.get(toID(e.species)) || [];
		[e.set, ...e.alts].forEach((d, k) => {
			const set = clean(toPokemonSet(e, d));
			list.push({set, key: setKey(set), w: ew * (ALT_WEIGHTS[k] ?? 0.2)});
		});
		prior.set(toID(e.species), list);
	}
	return prior;
}

/** Ident "p2a: Name" -> {side: 0|1, name} */
function parseIdent(ident) {
	const m = /^p([12])[a-z]?: (.+)$/.exec(ident || '');
	return m ? {side: Number(m[1]) - 1, name: m[2]} : null;
}

/**
 * What a player has seen of each side, from the public half of the battle log.
 * @returns [{preview: speciesName[], mons: Map<name, {species, moves: Set<id>, item, itemGone, ability, mega}>}] per side
 */
function observe(log) {
	const seen = [0, 1].map(() => ({preview: [], mons: new Map()}));
	const mon = (side, name) => {
		const s = seen[side].mons;
		if (!s.has(name)) s.set(name, {species: null, moves: new Set(), item: null, itemGone: false, ability: null, mega: false});
		return s.get(name);
	};
	let skipNext = false;
	for (const line of log) {
		if (skipNext) { skipNext = false; continue; } // |split| is followed by the private line, then the public one
		if (line.startsWith('|split|')) { skipNext = true; continue; }
		const parts = line.split('|');
		const tag = parts[1];
		if (tag === 'poke') {
			seen[Number(parts[2][1]) - 1].preview.push(parts[3].split(',')[0]);
			continue;
		}
		const who = parseIdent(parts[2]);
		if (who) {
			const m = mon(who.side, who.name);
			if (tag === 'switch' || tag === 'drag' || tag === 'replace') m.species = m.species || parts[3].split(',')[0];
			else if (tag === 'detailschange') m.species = m.species || parts[3].split(',')[0];
			else if (tag === 'move' && !line.includes('[from]')) m.moves.add(toID(parts[3]));
			else if (tag === '-mega') { m.mega = true; m.item = m.item || parts[4]; }
			else if (tag === '-enditem') { m.item = m.item || parts[3]; m.itemGone = true; }
			else if (tag === '-item' && !line.includes('[from]')) m.item = m.item || parts[3];
			else if (tag === '-ability') m.ability = m.ability || parts[3];
		}
		// "[from] ability: X" / "[from] item: X" credit the [of] Pokémon when given, else the line's subject
		const from = /\[from\] (ability|item): ([^|]+)/.exec(line);
		if (from) {
			const of = /\[of\] ([^|]+)/.exec(line);
			const owner = parseIdent(of ? of[1] : parts[2]);
			if (owner) {
				const m = mon(owner.side, owner.name);
				if (from[1] === 'ability') m.ability = m.ability || from[2];
				else if (!/\[from\] item: .*\[of\]/.test(line) || of) m.item = m.item || from[2];
			}
		}
	}
	return seen;
}

/** Sets from `options` consistent with what was seen of one Pokémon. */
function consistent(options, obs) {
	if (!obs) return options;
	return options.filter(({set}) => {
		const ids = set.moves.map(toID);
		for (const mv of obs.moves) if (!ids.includes(mv)) return false;
		if (obs.item && toID(set.item) !== toID(obs.item)) return false;
		if (obs.ability && toID(set.ability) !== toID(obs.ability)) return false;
		return true;
	});
}

function weightedPick(list, rng) {
	const total = list.reduce((t, x) => t + x.w, 0);
	let r = rng() * total;
	for (const x of list) if ((r -= x.w) <= 0) return x;
	return list[list.length - 1];
}

/**
 * When nothing in the prior explains what was seen (an off-meta set), patch the likeliest set: swap in
 * the revealed moves, item and ability. Keeps the analysis running instead of failing.
 */
function patchSet(options, obs, dex) {
	const base = JSON.parse(JSON.stringify(options[0].set));
	const moves = base.moves.slice();
	for (const mv of obs.moves) {
		if (moves.map(toID).includes(mv)) continue;
		const name = dex.moves.get(mv).name;
		const k = moves.findIndex(m => !obs.moves.has(toID(m)));
		if (k >= 0) moves[k] = name; else if (moves.length < 4) moves.push(name);
	}
	base.moves = moves;
	if (obs.item) base.item = obs.item;
	if (obs.ability) base.ability = obs.ability;
	return {set: base, key: setKey(base), w: 1};
}

// Pokémon fields the simulator derives from the set (stats, moves, item, ability). A determinized copy
// drops them so the constructor rebuilds them from the drawn set; everything observable is kept.
const STAT_FIELDS = ['moveSlots', 'baseMoveSlots', 'baseStoredStats', 'storedStats', 'speed', 'maxhp', 'baseMaxhp', 'hp'];
const ITEM_FIELDS = ['item', 'itemState', 'lastItem', 'canMegaEvo'];
const ABILITY_FIELDS = ['ability', 'baseAbility', 'abilityState'];

/**
 * A copy of `battle` as `viewer` (side index) could imagine it: the other side's unseen sets, and which
 * unseen species fill its unrevealed slots, are drawn from `prior` and the log. Choice strings for the
 * viewer's side mean the same thing in the copy; the other side's switch slots may not.
 * @param state optional battle.toJSON() to reuse
 */
function determinize(battle, viewer, prior, rng, state = null) {
	state = state ? JSON.parse(JSON.stringify(state)) : battle.toJSON();
	state.log = [];
	const foeIdx = 1 - viewer;
	const seen = observe(battle.log)[foeIdx];
	const foeState = state.sides[foeIdx];
	const real = battle.sides[foeIdx].pokemon;
	const dex = battle.dex;

	const revealedNames = new Set([...seen.mons.entries()].filter(([, m]) => m.species).map(([n]) => n));
	const revealedSpecies = new Set([...seen.mons.values()].filter(m => m.species).map(m => toID(dex.species.get(m.species).baseSpecies)));
	// species the unrevealed slots could be: previewed, not yet seen in battle
	const pool = (seen.preview.length ? seen.preview : real.map(p => p.set.species))
		.filter(sp => !revealedSpecies.has(toID(dex.species.get(sp).baseSpecies)));

	const usedItems = new Set();
	const order = real.map((p, i) => i).sort((a, b) => Number(revealedNames.has(real[b].name)) - Number(revealedNames.has(real[a].name)));
	const fixups = [];
	for (const i of order) {
		const p = real[i];
		const ps = foeState.pokemon[i];
		const revealed = revealedNames.has(p.name);
		let species, obs = null;
		if (revealed) {
			obs = seen.mons.get(p.name);
			species = p.set.species; // seen, so the real one
		} else {
			const k = Math.floor(rng() * pool.length);
			species = pool.splice(k, 1)[0] || p.set.species;
		}
		let options = prior.get(toID(species)) || prior.get(toID(dex.species.get(species).baseSpecies)) || [];
		let fits = consistent(options, obs).filter(o => !o.set.item || !usedItems.has(o.set.item) || (obs && obs.item));
		if (!fits.length) fits = options.length ? [patchSet(options, obs || {moves: new Set()}, dex)] : [{set: p.set, w: 1}];
		const drawn = weightedPick(fits, rng).set;
		if (drawn.item) usedItems.add(drawn.item);
		const set = {...JSON.parse(JSON.stringify(drawn)), name: revealed ? p.set.name : drawn.species};

		if (!revealed) {
			// never seen: a fresh, untouched Pokémon of the drawn species
			const position = ps.position;
			for (const key of Object.keys(ps)) delete ps[key];
			ps.position = position;
			ps.set = set;
			continue;
		}
		ps.set = set;
		const frac = p.hp / p.maxhp;
		for (const f of STAT_FIELDS) delete ps[f];
		if (!obs.item) for (const f of ITEM_FIELDS) delete ps[f];
		if (!obs.ability) for (const f of ABILITY_FIELDS) delete ps[f];
		fixups.push({i, frac, fainted: p.fainted, ppUsed: new Map(p.moveSlots.map(s => [s.id, s.maxpp - s.pp]))});
	}
	const clone = Battle.fromJSON(state);
	for (const {i, frac, fainted, ppUsed} of fixups) {
		const p = clone.sides[foeIdx].pokemon[i];
		// stats for the current forme (e.g. after Mega Evolution), from the drawn spread
		const stats = clone.spreadModify(p.species.baseStats, p.set);
		p.baseStoredStats = stats;
		for (const s of ['atk', 'def', 'spa', 'spd', 'spe']) p.storedStats[s] = stats[s];
		p.speed = p.storedStats.spe;
		p.hp = fainted ? 0 : Math.max(1, Math.round(frac * p.maxhp));
		for (const slot of p.moveSlots) if (ppUsed.has(slot.id)) slot.pp = Math.max(0, slot.maxpp - ppUsed.get(slot.id));
	}
	return clone;
}

/** Draw full sets for a team known only by species (team preview), respecting Item Clause. */
function drawTeam(prior, species, rng) {
	const used = new Set();
	return species.map(sp => {
		const options = prior.get(toID(sp));
		if (!options) throw new Error(`No simulated sets for ${sp}`);
		const free = options.filter(o => !o.set.item || !used.has(o.set.item));
		const drawn = weightedPick(free.length ? free : options, rng).set;
		if (drawn.item) used.add(drawn.item);
		return JSON.parse(JSON.stringify(drawn));
	});
}

module.exports = {setPrior, observe, consistent, determinize, drawTeam, toID};
