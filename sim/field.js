'use strict';
// A model of the real opponent field: the teams strong players bring on the Champions ranked ladder.
//
// Sources (each optional):
//   ingame   Pokémon Champions in-game ranked Singles battle data from Pokemon Champions Battle Data
//            (https://championsbattledata.com/, fan-made; credit them when sharing). Per species: the ladder's rank
//            order (no usage %), top-10 moves / items / natures / stat points / teammates, Megas merged into the base
//            species. Download with `node sim/field.js --download out/field/ingame-<date>`.
//   chaos    Showdown usage stats for the same format (sim/ladderstats.js): usage % and form-level sets (a Mega's
//            moves and spreads separately from its base form's, natures joint with stat points).
//   replays  Real teams from Showdown replays of top players (sim/team-bench.js parses them).
//
// Synthetic teams: species by in-game rank (weighted by the Showdown usage curve at that rank, since the in-game data
// has no percentages), Mega form by the in-game share of each Mega Stone, teammates pulled toward the in-game
// teammate lists, and each set sampled from the form's Showdown distributions (4 moves by usage without replacement,
// a joint nature + stat-point spread, an item), so the field has the ladder's variety rather than one modal set each.
// Item Clause and Species Clause hold; at most a few Mega Stones per team, as on the ladder.

const fs = require('fs');
const path = require('path');
const https = require('https');
const F = require('./format');
const {dex, toID} = F;
const {clean} = require('./util');
const {toPokemonSet} = require('./refine');
const {loadLadder, STAT_KEYS} = require('./ladderstats');

const pct = s => Number(String(s).replace('%', '')) / 100 || 0;
const pickW = (rng, items, w) => {
	const tot = w.reduce((a, b) => a + b, 0);
	if (!(tot > 0)) return items[Math.floor(rng() * items.length)];
	let r = rng() * tot;
	for (let i = 0; i < items.length; i++) if ((r -= w[i]) <= 0) return items[i];
	return items[items.length - 1];
};

function loadIngame(dir) {
	const rankings = JSON.parse(fs.readFileSync(path.join(dir, 'rankings-singles.json'), 'utf8')).rankings;
	const out = [];
	for (const r of rankings) {
		const f = path.join(dir, `${r.showdownId}.json`);
		if (!fs.existsSync(f)) continue;
		const rows = JSON.parse(fs.readFileSync(f, 'utf8')).rows || [];
		const cat = c => rows.filter(x => x.category === c).sort((a, b) => a.rank - b.rank);
		out.push({position: r.position, id: r.showdownId, name: r.battleName,
			moves: cat('move').map(x => [x.name, pct(x.percentage)]),
			items: cat('held_item').map(x => [x.name, pct(x.percentage)]),
			natures: cat('stat_alignment').map(x => [x.name, pct(x.percentage)]),
			points: cat('stat_points').map(x => [{hp: +x.hp_points || 0, atk: +x.attack_points || 0, def: +x.defense_points || 0,
				spa: +x.sp_atk_points || 0, spd: +x.sp_def_points || 0, spe: +x.speed_points || 0}, pct(x.percentage)]),
			abilities: cat('ability').map(x => [x.name, pct(x.percentage)]),
			teammates: cat('teammate').map(x => x.name)});
	}
	return out;
}

class Field {
	/**
	 * @param {object} o
	 * @param {object} o.results  results.json (roster entries; fallback sets)
	 * @param {string} [o.ingame] directory from --download
	 * @param {string} [o.chaos]  Showdown chaos JSON
	 * @param {object[][]} [o.replayTeams] real teams (PokemonSet[6]) to mix in
	 * @param {number} [o.replayShare] fraction of sampled teams that are replay teams (default 0.5 when given)
	 */
	constructor({results, ingame, chaos, replayTeams = [], replayShare = 0.5}) {
		this.results = results;
		this.entries = results.entries;
		this.replayTeams = replayTeams;
		this.replayShare = replayTeams.length ? replayShare : 0;
		this.ladder = chaos ? loadLadder(chaos, this.entries) : {list: []};
		this.formStats = new Map(this.ladder.list.map(x => [toID(x.name), x]));
		const usageCurve = this.ladder.list.map(x => x.usage).sort((a, b) => b - a);
		const baseEntry = new Map(this.entries.filter(e => !e.megaItem).map(e => [toID(e.species), e]));
		if (ingame) {
			this.species = loadIngame(ingame).map(s => ({...s, entry: baseEntry.get(toID(s.name)) || baseEntry.get(s.id)}))
				.filter(s => s.entry);
			// no usage % in the in-game data: weight rank k like Showdown's k-th most used Pokémon
			this.species.forEach((s, k) => { s.w = usageCurve[k] ?? usageCurve[usageCurve.length - 1] ?? 1 / (k + 1); });
		} else {
			// Showdown only: base species weighted by the summed usage of their forms
			const by = new Map();
			for (const x of this.ladder.list) {
				const id = toID(x.entry.species);
				const s = by.get(id) || {name: x.entry.species, entry: baseEntry.get(id), w: 0, teammates: [], items: [], moves: []};
				s.w += x.usage;
				if (x.entry.megaItem) s.items.push([x.entry.megaItem, x.usage]);
				by.set(id, s);
			}
			for (const s of by.values()) s.items = s.items.map(([i, u]) => [i, u / s.w]);
			this.species = [...by.values()].filter(s => s.entry).sort((a, b) => b.w - a.w);
		}
		this.byName = new Map(this.species.map(s => [toID(s.name), s]));
		this.megaEntries = new Map(this.entries.filter(e => e.megaItem).map(e => [e.megaItem, e]));
	}

	/** One set for species record `s`, given items already on the team. */
	sampleSet(rng, s, usedItems, allowMega) {
		// Mega form by the in-game share of each Mega Stone
		const stones = s.items.filter(([i]) => this.megaEntries.has(i) && this.megaEntries.get(i).species === s.entry.species && !usedItems.has(i));
		const megaShare = stones.reduce((a, [, p]) => a + p, 0);
		let entry = s.entry;
		if (allowMega && stones.length && rng() < megaShare) entry = this.megaEntries.get(pickW(rng, stones.map(x => x[0]), stones.map(x => x[1])));
		const form = this.formStats.get(toID(entry.mega || entry.species));
		const species = dex.species.get(entry.species);
		const learn = new Set(F.learnableMoves(species).map(m => m.id));
		let set;
		if (form && !form.problems) {
			set = JSON.parse(JSON.stringify(form.set));
			// 4 moves by usage, without replacement
			const pool = Object.entries(form.moveShare).filter(([k]) => learn.has(k)).slice(0, 10);
			const moves = [];
			while (moves.length < 4 && pool.length) {
				const k = pickW(rng, pool.map(p => p[0]), pool.map(p => p[1]));
				moves.push(dex.moves.get(k).name);
				pool.splice(pool.findIndex(p => p[0] === k), 1);
			}
			if (moves.length >= Math.min(4, set.moves.length)) set.moves = moves;
			const spreads = Object.entries(form.spreadShare || {}).slice(0, 8);
			if (spreads.length) {
				const [nature, pts] = pickW(rng, spreads.map(x => x[0]), spreads.map(x => x[1])).split(':');
				set.nature = nature;
				set.evs = Object.fromEntries(STAT_KEYS.map((k, i) => [k, Number(pts.split('/')[i]) || 0]));
			}
			if (!entry.megaItem) {
				const items = Object.entries(form.itemShare).map(([k, v]) => [dex.items.get(k), v])
					.filter(([i]) => i.exists && !i.megaStone && !usedItems.has(i.name)).slice(0, 8);
				set.item = items.length ? pickW(rng, items.map(x => x[0].name), items.map(x => x[1])) : '';
			}
		} else if (s.moves && s.moves.length) {
			// in-game marginals only (no Showdown data for this form)
			const moves = s.moves.filter(([m]) => learn.has(toID(m))).slice(0, 4).map(([m]) => m);
			const nature = s.natures && s.natures[0] ? s.natures[0][0] : 'Serious';
			const evs = s.points && s.points[0] ? s.points[0][0] : {hp: 32, atk: 0, def: 32, spa: 0, spd: 2, spe: 0};
			const item = entry.megaItem || ((s.items.find(([i]) => dex.items.get(i).exists && !dex.items.get(i).megaStone && !usedItems.has(i)) || [''])[0]);
			const ability = entry.megaItem ? entry.set.ability : (s.abilities && s.abilities[0] ? s.abilities[0][0] : entry.set.ability);
			set = {name: species.name, species: species.name, item, ability, nature, evs,
				ivs: Object.fromEntries(STAT_KEYS.map(k => [k, 31])), moves, level: 50};
		} else {
			set = clean(toPokemonSet(entry, entry.set));
		}
		if (entry.megaItem) set.item = entry.megaItem;
		if (usedItems.has(set.item)) set.item = '';
		if (F.validateSet(JSON.parse(JSON.stringify(set)))) {
			const fb = clean(toPokemonSet(entry, entry.set));
			if (usedItems.has(fb.item)) fb.item = '';
			return F.validateSet(JSON.parse(JSON.stringify(fb))) ? null : fb;
		}
		return clean(set);
	}

	/** A synthetic ladder team: species by rank weight, pulled toward the members' in-game teammates. */
	syntheticTeam(rng) {
		for (let attempt = 0; attempt < 20; attempt++) {
			const team = [], species = new Set(), items = new Set();
			let megas = 0;
			for (let guard = 0; team.length < 6 && guard < 200; guard++) {
				const cands = this.species.filter(s => !species.has(s.entry.species));
				const w = cands.map(s => s.w * (1 + 3 * team.filter(t => t._rec && t._rec.teammates.includes(s.name)).length));
				const s = pickW(rng, cands, w);
				const set = this.sampleSet(rng, s, items, megas < 2);
				if (!set) { species.add(s.entry.species); continue; }
				species.add(s.entry.species); items.add(set.item);
				if (dex.items.get(set.item).megaStone) megas++;
				Object.defineProperty(set, '_rec', {value: s, enumerable: false});
				team.push(set);
			}
			if (team.length === 6 && !F.validateTeam(team.map(clean))) return team.map(clean);
		}
		throw new Error('could not sample a valid field team');
	}

	/** A field team: a real replay team with probability replayShare, else a synthetic one. */
	sample(rng) {
		if (this.replayTeams.length && rng() < this.replayShare) return this.replayTeams[Math.floor(rng() * this.replayTeams.length)];
		return this.syntheticTeam(rng);
	}
}

function get(url) {
	return new Promise((resolve, reject) => https.get(url, {headers: {'user-agent': 'pokechamp-team-builder'}}, res => {
		let b = '';
		res.on('data', d => { b += d; });
		res.on('end', () => res.statusCode === 200 ? resolve(b) : reject(new Error(`${url}: HTTP ${res.statusCode}`)));
	}).on('error', reject));
}

/** Download the current in-game Singles data (one request at a time). */
async function download(dir) {
	fs.mkdirSync(dir, {recursive: true});
	const API = 'https://championsbattledata.com/api';
	const rank = await get(`${API}/rankings?format=Singles`);
	fs.writeFileSync(path.join(dir, 'rankings-singles.json'), rank);
	for (const r of JSON.parse(rank).rankings) {
		const f = path.join(dir, `${r.showdownId}.json`);
		if (fs.existsSync(f)) continue;
		fs.writeFileSync(f, await get(`${API}/battle/Singles/${r.showdownId}`));
		await new Promise(res => setTimeout(res, 300));
	}
	console.log(`saved ${JSON.parse(rank).rankings.length} species to ${dir}`);
}

module.exports = {Field, loadIngame, download};

if (require.main === module) {
	const argv = process.argv.slice(2);
	const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
	if (arg('download')) download(arg('download')).catch(e => { console.error(e); process.exit(1); });
	else {
		const {mulberry32} = require('./util');
		const results = require(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))));
		const field = new Field({results, ingame: arg('ingame'), chaos: arg('chaos')});
		const rng = mulberry32(Number(arg('seed', 1)));
		const n = Number(arg('n', 5));
		for (let k = 0; k < n; k++) console.log(field.syntheticTeam(rng).map(s => `${s.species}@${s.item} [${s.moves.join('/')}] ${s.nature}`).join('\n  '), '\n');
		// species frequency check
		const count = new Map();
		for (let k = 0; k < 2000; k++) for (const s of field.syntheticTeam(rng)) count.set(s.species + (dex.items.get(s.item).megaStone ? '-Mega' : ''), (count.get(s.species + (dex.items.get(s.item).megaStone ? '-Mega' : '')) || 0) + 1);
		console.log([...count].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} ${(v / 20).toFixed(0)}%`).join(', '));
	}
}
