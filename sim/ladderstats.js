'use strict';
// Showdown ladder usage statistics ("chaos" JSON, https://www.smogon.com/stats/<month>/chaos/<format>-<cutoff>.json)
// mapped onto our roster: each used Pokémon's modal set (4 most used moves, most used item, nature + stat points)
// and the moves strong players use on it. Used by the ladder benchmark (sim/ladder-bench.js) and to seed the set
// search (sim/pipeline.js --ladder-stats), so the search always tries what the ladder plays.

const fs = require('fs');
const F = require('./format');
const {dex, toID} = F;

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const share = (obj, total) => Object.entries(obj).map(([k, v]) => [k, v / total]).sort((a, b) => b[1] - a[1]);

/**
 * @param {string} statsPath chaos JSON
 * @param {object[]} entries results.json entries (or pipeline roster entries with id/species/mega/megaItem)
 * @param {object} [o] o.abilityOf(entry): base-form ability for a Mega (the stats list the Mega's own ability)
 * @returns {{info, list: object[]}} list sorted by usage: {name, entry, usage, set, problems?, moveShare, itemShare,
 *   spreadShare ('Nature:hp/atk/def/spa/spd/spe' -> share)}
 */
function loadLadder(statsPath, entries, o = {}) {
	const stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
	const byBattleName = new Map(entries.map(e => [toID(e.mega || e.battleSpecies || e.species), e]));
	const list = [];
	for (const [name, d] of Object.entries(stats.data).sort((a, b) => b[1].usage - a[1].usage)) {
		const entry = byBattleName.get(toID(name));
		if (!entry) continue;
		const total = Object.values(d.Abilities).reduce((a, b) => a + b, 0) || 1;
		const species = dex.species.get(entry.species);
		const learn = new Set(F.learnableMoves(species).map(m => m.id));
		const moveShare = Object.fromEntries(share(d.Moves, total).filter(([k]) => k && learn.has(k)));
		const moves = Object.keys(moveShare).slice(0, 4).map(k => dex.moves.get(k).name);
		if (!moves.length) continue;
		const [spreadKey] = share(d.Spreads, total)[0] || ['Serious:0/0/0/0/0/0'];
		const [nature, pts] = spreadKey.split(':');
		const evs = Object.fromEntries(STAT_KEYS.map((k, i) => [k, Number(pts.split('/')[i]) || 0]));
		const isMega = !!(entry.mega || entry.megaItem);
		const ability = isMega
			? (o.abilityOf ? o.abilityOf(entry) : (entry.set ? entry.set.ability : Object.values(species.abilities)[0]))
			: dex.abilities.get(share(d.Abilities, total)[0][0]).name;
		const itemShare = Object.fromEntries(share(d.Items, total));
		const topItem = Object.keys(itemShare).find(k => dex.items.get(k).exists);
		const item = entry.megaItem || (topItem ? dex.items.get(topItem).name : '');
		const set = {name: species.name, species: species.name, item, ability, nature, evs,
			ivs: Object.fromEntries(STAT_KEYS.map(k => [k, 31])), moves, level: 50};
		const problems = F.validateSet(JSON.parse(JSON.stringify(set)));
		const spreadShare = Object.fromEntries(share(d.Spreads, total));
		list.push({name, entry, usage: d.usage, set, problems: problems || null, moveShare, itemShare, spreadShare});
	}
	return {info: stats.info, list};
}

/** Moves used on at least `min` of an entry's ladder sets, by entry id. */
function ladderMoves(ladder, min = 0.1) {
	const out = new Map();
	for (const x of ladder.list) out.set(x.entry.id, Object.entries(x.moveShare).filter(([, v]) => v >= min).map(([k]) => k));
	return out;
}

module.exports = {loadLadder, ladderMoves, STAT_KEYS};
