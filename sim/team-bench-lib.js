'use strict';
// Real teams from Showdown replays (team preview + what the replay reveals; the rest from the ladder's modal
// sets). Used by sim/team-bench.js and as part of the real-field model (sim/field.js via sim/team-search.js).

const fs = require('fs');
const path = require('path');
const F = require('./format');
const {dex, toID} = F;
const {clean} = require('./util');
const {toPokemonSet} = require('./refine');
const {loadLadder} = require('./ladderstats');

/**
 * @param {string} dir replay .log files
 * @param {object} results results.json (roster and fallback sets)
 * @param {string} chaos Showdown chaos JSON (modal sets)
 * @param {number} minRating only sides with at least this ladder rating
 * @returns {{label, rating, team: PokemonSet[6]}[]}
 */
function realTeams(dir, results, chaos, minRating = 1250) {
	const entries = results.entries;
	const ladder = loadLadder(path.resolve(chaos), entries);
	const ladderBy = new Map(ladder.list.filter(x => !x.problems).map(x => [toID(x.name), x]));
	const entryBy = new Map(entries.map(e => [toID(e.mega || e.species), e]));
	const MIN_RATING = minRating;
	/** One real team from a replay side: [{species (battle forme), moves:Set, item}] */
	function parseReplay(text) {
		const lines = text.split('\n');
		const sides = {p1: {rating: 0, team: [], nick: new Map()}, p2: {rating: 0, team: [], nick: new Map()}};
		for (const l of lines) {
			const p = l.split('|');
			if (p[1] === 'player' && sides[p[2]] && p[5]) sides[p[2]].rating = Number(p[5]) || 0;
			if (p[1] === 'poke' && sides[p[2]]) sides[p[2]].team.push({species: p[3].split(',')[0], moves: new Set(), item: null});
			const who = p[2] && /^p[12]a: /.test(p[2]) ? p[2].slice(0, 2) : null;
			if (!who) continue;
			const nick = p[2].slice(5);
			const side = sides[who];
			if (p[1] === 'switch' || p[1] === 'drag' || p[1] === 'detailschange') {
				const sp = p[3].split(',')[0];
				const base = dex.species.get(sp).baseSpecies;
				let m = side.team.find(t => t.species === sp || dex.species.get(t.species).baseSpecies === base);
				if (m) {
					if (p[1] === 'detailschange') m.species = sp; // Mega Evolution
					side.nick.set(nick, m);
				}
			}
			const m = side.nick.get(nick);
			if (!m) continue;
			if (p[1] === 'move' && !l.includes('[from]')) m.moves.add(toID(p[3]));
			if ((p[1] === '-enditem' || p[1] === '-item') && !l.includes('[from] move:')) m.item = m.item || p[3];
		}
		return Object.values(sides).filter(s => s.rating >= MIN_RATING && s.team.length === 6);
	}

	/** A PokemonSet for one real team member, or null. */
	function realSet(m, usedItems) {
		const x = ladderBy.get(toID(m.species));
		const e = entryBy.get(toID(m.species));
		if (!e) return null;
		const base = x ? x.set : clean(toPokemonSet(e, e.set));
		const learn = new Set(F.learnableMoves(dex.species.get(e.species)).map(mv => mv.id));
		const moves = [...m.moves].filter(id => learn.has(id)).slice(0, 4);
		const fill = x ? Object.keys(x.moveShare) : base.moves.map(toID);
		for (const id of fill) if (moves.length < 4 && !moves.includes(toID(id))) moves.push(toID(id));
		const set = {...base, moves: moves.map(id => dex.moves.get(id).name)};
		if (e.megaItem) set.item = e.megaItem;
		else if (m.item && dex.items.get(m.item).exists) set.item = dex.items.get(m.item).name;
		if (usedItems.has(set.item)) {
			const alt = x && Object.keys(x.itemShare).map(i => dex.items.get(i)).find(i => i.exists && !usedItems.has(i.name) && !i.megaStone);
			set.item = alt ? alt.name : '';
		}
		if (F.validateSet(JSON.parse(JSON.stringify(set)))) return x && !usedItems.has(x.set.item) ? clean(x.set) : null;
		return clean(set);
	}

	function teamsIn(dir) {
		const out = [], seen = new Set();
		for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.log'))) {
			for (const side of parseReplay(fs.readFileSync(path.join(dir, f), 'utf8'))) {
				const used = new Set();
				const team = [];
				// Megas first so their stones are placed before items are deduplicated
				for (const m of side.team.slice().sort((a, b) => (/-Mega/.test(b.species) ? 1 : 0) - (/-Mega/.test(a.species) ? 1 : 0))) {
					const s = realSet(m, used);
					if (!s) break;
					used.add(s.item);
					team.push(s);
				}
				if (team.length !== 6 || F.validateTeam(team)) continue;
				const key = team.map(s => s.species + (s.item.endsWith('ite') ? '*' : '')).sort().join();
				if (seen.has(key)) continue;
				seen.add(key);
				out.push({label: `${f.replace('.log', '')} (${side.rating})`, rating: side.rating, team});
			}
		}
		return out;
	}
	return teamsIn(dir);
}

module.exports = {realTeams};
