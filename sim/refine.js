'use strict';
// Team-specific tuning and validation. Given one team of six, re-tune each
// member's set *inside that team* against a gauntlet of strong meta teams
// (coordinate descent, paired comparisons on identical battles), then measure
// the original vs the tuned team on a fresh, larger gauntlet.

const S = require('./sets');
const {mulberry32, hash, seedFrom, clean, setKey, isFailed} = require('./util');

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** results.json set description -> PokemonSet the simulator understands. */
function toPokemonSet(entry, desc) {
	const evs = Object.fromEntries(STAT_KEYS.map(k => [k, desc.statPoints[k] || 0]));
	return {
		name: entry.species, species: entry.species, item: desc.item || '', ability: desc.ability,
		nature: desc.nature, evs, ivs: Object.fromEntries(STAT_KEYS.map(k => [k, 31])), moves: desc.moves.slice(),
		level: 50, spread: 'custom', archetype: desc.archetype || 'custom',
	};
}

/** PokemonSet -> results.json style description (what the UI renders). */
function describe(set) {
	return {
		item: set.item, ability: set.ability, nature: set.nature, moves: set.moves,
		statPoints: Object.fromEntries(Object.entries(set.evs).filter(([, v]) => v > 0)),
	};
}

function rosterEntry(e) {
	return {id: e.id, species: e.species, megaItem: e.megaItem, battleSpecies: e.mega || e.species};
}

/** Meta gauntlet: opponent teams drawn from strong entries (weighted by rating), Item Clause respected. */
function makeGauntlet(results, rng, count) {
	const {entries} = results;
	const w = entries.map(e => Math.exp((e.rating - 1500) / 120));
	const total = w.reduce((a, b) => a + b, 0);
	const draw = () => {
		let r = rng() * total;
		for (let i = 0; i < entries.length; i++) if ((r -= w[i]) <= 0) return i;
		return entries.length - 1;
	};
	const teams = [];
	for (let t = 0; t < count; t++) {
		const species = new Set(), items = new Set(), members = [], sets = [];
		let guard = 0;
		while (members.length < 6 && guard++ < 500) {
			const i = draw(), e = entries[i];
			if (species.has(e.species)) continue;
			const options = [e.set, ...e.alts];
			const desc = options.find(s => !s.item || !items.has(s.item));
			if (!desc) continue;
			species.add(e.species); items.add(desc.item);
			members.push(i); sets.push(clean(toPokemonSet(e, desc)));
		}
		teams.push({members, sets});
	}
	return teams;
}

/**
 * Battle our team against every gauntlet team (each from both sides), returning per-game results.
 * Each game: {win: 0|0.5|1, ourPicks: number[], oppIndex, oppPicks: number[]}.
 */
async function playGauntlet(pool, team, gauntlet, seeds) {
	const jobs = [];
	const meta = [];
	gauntlet.forEach((opp, g) => {
		for (let k = 0; k < seeds[g].length; k++) {
			const flip = k % 2 === 1;
			jobs.push({a: flip ? opp.sets : team, b: flip ? team : opp.sets, seed: seeds[g][k], picks: true});
			meta.push({g, flip});
		}
	});
	const res = await pool.run(jobs, 8);
	return res.map((r, x) => {
		const {g, flip} = meta[x];
		const ours = flip ? 1 : 0;
		// a failed battle has no result: NaN, skipped by every statistic below (a drawn battle scores 0.5)
		if (isFailed(r)) return {win: NaN, failed: true, ourPicks: [], oppIndex: g, oppPicks: []};
		const win = r.w === null ? 0.5 : (r.w === ours ? 1 : 0);
		return {win, ourPicks: r.picks[ours] || [], oppIndex: g, oppPicks: r.picks[1 - ours] || []};
	});
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function pairedDiff(a, b) {
	const d = a.map((x, i) => x - b[i]).filter(Number.isFinite);
	const m = mean(d);
	const sd = Math.sqrt(mean(d.map(x => (x - m) ** 2)));
	return {diff: m, se: sd / Math.sqrt(d.length || 1)};
}

function seedsFor(rng, teams, perTeam) {
	return teams.map(() => Array.from({length: perTeam}, () => seedFrom(rng)));
}

/** Describe what changed between two sets, for the UI. */
function changes(before, after) {
	const out = [];
	if (before.item !== after.item) out.push(`Item: ${before.item || 'none'} → ${after.item || 'none'}`);
	if (before.ability !== after.ability) out.push(`Ability: ${before.ability} → ${after.ability}`);
	if (before.nature !== after.nature || JSON.stringify(before.evs) !== JSON.stringify(after.evs)) {
		const sp = s => STAT_KEYS.filter(k => s.evs[k]).map(k => `${s.evs[k]} ${k}`).join('/');
		out.push(`Spread: ${before.nature} ${sp(before)} → ${after.nature} ${sp(after)}`);
	}
	const removed = before.moves.filter(m => !after.moves.includes(m));
	const added = after.moves.filter(m => !before.moves.includes(m));
	if (removed.length || added.length) out.push(`Moves: ${removed.join(', ')} → ${added.join(', ')}`);
	return out;
}

/**
 * @param pool      sim/pool Pool
 * @param results   web/data/results.json contents
 * @param team      [{entryId, set}] where set is a results.json set description
 * @param opts      {budget: 'quick'|'normal'|'thorough', onProgress(fraction, message)}
 */
async function refineTeam(pool, results, team, opts = {}) {
	const progress = opts.onProgress || (() => {});
	const scale = {quick: 0.5, normal: 1, thorough: 2.5}[opts.budget || 'normal'] || 1;
	const byId = new Map(results.entries.map((e, i) => [e.id, i]));
	const members = team.map(t => {
		const idx = byId.get(t.entryId);
		if (idx === undefined) throw new Error(`Unknown entry ${t.entryId}`);
		const e = results.entries[idx];
		const set = toPokemonSet(e, t.set || e.set);
		set.key = setKey(set);
		return {idx, e, entry: rosterEntry(e), original: set, current: set};
	});
	if (members.length < 3) throw new Error('Need at least 3 Pokémon to battle');

	// Three independent batches of battles against strong meta teams:
	//   screen   cheap first look at every candidate set
	//   confirm  bigger, separate sample for the two best; a change is only accepted if it wins here
	//   validate fresh sample comparing the original and final teams (what we report)
	const rng = mulberry32(hash(members.map(m => m.e.id).join(',')));
	const batch = (teams, perTeam) => {
		const gauntlet = makeGauntlet(results, rng, Math.round(teams * scale));
		return {gauntlet, seeds: seedsFor(rng, gauntlet, perTeam), size: Math.round(teams * scale) * perTeam};
	};
	const screen = batch(30, 6), confirm = batch(100, 6), validate = batch(125, 8);
	const CANDIDATES = 7, FINALISTS = 2;
	const rounds = scale >= 2 ? 2 : 1;

	const totalBattles = screen.size + confirm.size +
		rounds * members.length * (CANDIDATES * screen.size + FINALISTS * confirm.size) + 2 * validate.size;
	let done = 0;
	const tick = (n, msg) => { done += n; progress(Math.min(0.99, done / totalBattles), msg); };
	const teamWith = (mi, set) => members.map((o, j) => clean(j === mi ? set : o.current));
	const wins = games => games.map(g => g.win);

	progress(0, 'Measuring your team as built…');
	let [baseScreen, baseConfirm] = await Promise.all([
		playGauntlet(pool, teamWith(-1), screen.gauntlet, screen.seeds).then(wins),
		playGauntlet(pool, teamWith(-1), confirm.gauntlet, confirm.seeds).then(wins),
	]);
	tick(screen.size + confirm.size, 'Baseline measured');

	for (let round = 0; round < rounds; round++) {
		let changed = false;
		for (let mi = 0; mi < members.length; mi++) {
			const m = members[mi];
			const label = `Tuning ${m.e.mega || m.e.species}${rounds > 1 ? ` (round ${round + 1})` : ''}`;
			const otherItems = new Set(members.filter((_, j) => j !== mi).map(o => o.current.item).filter(Boolean));
			const precomputed = [m.e.set, ...m.e.alts].map(d => {
				const s = toPokemonSet(m.e, d); s.key = setKey(s); return s;
			});
			const nbrs = S.neighbours(m.entry, m.current, rng).map(s => { s.key = setKey(s); return s; });
			const seen = new Set([m.current.key]);
			const cands = [];
			for (const s of [...precomputed, ...nbrs]) {
				if (seen.has(s.key) || (s.item && otherItems.has(s.item))) continue;
				seen.add(s.key);
				cands.push(s);
				if (cands.length >= CANDIDATES) break;
			}
			// screen all candidates in parallel
			const screened = await Promise.all(cands.map(c =>
				playGauntlet(pool, teamWith(mi, c), screen.gauntlet, screen.seeds).then(wins)));
			tick(CANDIDATES * screen.size, label);
			const finalists = cands.map((c, i) => ({c, res: screened[i], d: pairedDiff(screened[i], baseScreen).diff}))
				.filter(f => f.d > 0).sort((a, b) => b.d - a.d).slice(0, FINALISTS);
			// confirm the best on a separate, larger sample
			const confirmed = await Promise.all(finalists.map(f =>
				playGauntlet(pool, teamWith(mi, f.c), confirm.gauntlet, confirm.seeds).then(wins)));
			tick(FINALISTS * confirm.size, label);
			let best = null;
			finalists.forEach((f, i) => {
				const stat = pairedDiff(confirmed[i], baseConfirm);
				// one-sided 95%: only accept changes that hold up on battles they weren't selected on
				if (stat.diff > 1.645 * stat.se && (!best || stat.diff > best.stat.diff)) {
					best = {f, conf: confirmed[i], stat};
				}
			});
			if (best) {
				m.current = best.f.c;
				baseScreen = best.f.res;
				baseConfirm = best.conf;
				changed = true;
			}
		}
		if (!changed) {
			tick(members.length * (CANDIDATES * screen.size + FINALISTS * confirm.size) * (rounds - round - 1), '');
			break;
		}
	}

	progress(done / totalBattles, 'Validating original vs tuned team on fresh battles…');
	const anyChange = members.some(m => m.current !== m.original);
	const before = await playGauntlet(pool, members.map(m => clean(m.original)), validate.gauntlet, validate.seeds);
	const after = anyChange ? await playGauntlet(pool, teamWith(-1), validate.gauntlet, validate.seeds) : before;
	tick(2 * validate.size, 'Validated');

	const diff = pairedDiff(wins(after), wins(before));
	// Never hand back a team that validates worse than what you started with.
	const kept = anyChange && diff.diff <= 0;
	if (kept) for (const m of members) m.current = m.original;
	const final = (kept ? before : after).filter(g => !g.failed);

	const summarize = games => {
		const w = wins(games).filter(Number.isFinite);
		const p = mean(w);
		return {winRate: +p.toFixed(4), games: w.length, ci95: +(1.96 * Math.sqrt(p * (1 - p) / w.length)).toFixed(4)};
	};
	// Who we bring and lead with, and which meta Pokémon beat us most when the opponent brought them.
	const bringRate = members.map((_, i) => final.filter(g => g.ourPicks.includes(i)).length / final.length);
	const leadRate = members.map((_, i) => final.filter(g => g.ourPicks[0] === i).length / final.length);
	const vs = new Map();
	for (const g of final) {
		const opp = validate.gauntlet[g.oppIndex];
		for (const k of g.oppPicks) {
			const idx = opp.members[k];
			if (idx === undefined) continue;
			const s = vs.get(idx) || {games: 0, wins: 0};
			s.games++; s.wins += g.win;
			vs.set(idx, s);
		}
	}
	const minGames = Math.max(30, Math.round(validate.size / 30));
	const threats = [...vs.entries()].filter(([, s]) => s.games >= minGames)
		.map(([idx, s]) => ({entryId: results.entries[idx].id, games: s.games, winRate: +(s.wins / s.games).toFixed(3)}))
		.sort((a, b) => a.winRate - b.winRate);

	progress(1, 'Done');
	return {
		before: summarize(before),
		after: summarize(final),
		improvement: {diff: kept ? 0 : +diff.diff.toFixed(4), se: +diff.se.toFixed(4)},
		revertedTuning: kept,
		members: members.map((m, i) => ({
			entryId: m.e.id,
			original: describe(m.original),
			refined: describe(m.current),
			changes: changes(m.original, m.current),
			bringRate: +bringRate[i].toFixed(3),
			leadRate: +leadRate[i].toFixed(3),
		})),
		threats: threats.slice(0, 8),
		battles: done,
	};
}

module.exports = {refineTeam, toPokemonSet};
