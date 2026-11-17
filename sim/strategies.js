'use strict';
// Package the team-level results for the app's "Strongest teams" tab (web/data/strategies.json):
//   ladder       best teams against the real ladder field (sim/team-search.js --field ladder, then refineTeam against
//                the same field), with their strong-pilot win rates against it
//   equilibrium  the double-oracle mix (sim/double-oracle.js): the theoretically strongest teams and their weights
//
//   node sim/strategies.js --ladder out/team-search/ladder.json [--tuned out/team-search/ladder-tuned.json] \
//     --equilibrium out/double-oracle/run.json --field-info "in-game Season 8 data 2026-11-15, ..."

const fs = require('fs');
const path = require('path');
const {dex} = require('./format');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const read = f => f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')) : null;
const RESULTS = read(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json')));
const byKey = new Map(RESULTS.entries.map(e => [`${e.species}|${e.megaItem || ''}`, e]));
const entryOf = set => byKey.get(`${set.species}|${dex.items.get(set.item).megaStone ? set.item : ''}`) || byKey.get(`${set.species}|`);
const desc = set => ({item: set.item, ability: set.ability, nature: set.nature, moves: set.moves,
	statPoints: Object.fromEntries(Object.entries(set.evs).filter(([, v]) => v > 0))});
const member = set => ({entryId: entryOf(set).id, set: desc(set)});

const out = {generatedAt: new Date().toISOString(), results: RESULTS.meta.generatedAt};

const ladder = read(arg('ladder'));
if (ladder) {
	const tuned = read(arg('tuned')); // [{team index, refine result}] from the tuning step
	// --preview: sim/preview-check.js output; its team-preview-game values (both sides choose their three by
	// equilibrium) are the reported win rates, and teams are ranked by them
	const preview = read(arg('preview'));
	const pv = new Map((preview ? preview.teams : []).map(r => [r.team, r]));
	if (preview) {
		ladder.teams = ladder.teams.filter(t => pv.has(t.team));
		for (const t of ladder.teams) { const r = pv.get(t.team); t.previewWinRate = r.preview; t.previewSe = r.previewSe; }
	}
	const score = t => t.previewWinRate ?? t.winRate;
	const teams = ladder.teams.slice().sort((a, b) => score(b) - score(a));
	const seen = new Set();
	out.ladder = {fieldInfo: arg('field-info', ''), battles: ladder.battles, teams: []};
	for (const t of teams) {
		const key = t.sets.map(s => s.species).sort().join();
		if (seen.has(key)) continue;
		seen.add(key);
		const tune = tuned && tuned.find(x => x.key === key);
		const r = tune && tune.result;
		out.ladder.teams.push({
			kind: t.kind,
			winRate: t.previewWinRate ?? (r ? r.after.winRate : t.winRate),
			se: t.previewSe ?? (r ? +(r.after.ci95 / 1.96).toFixed(4) : t.se),
			measure: t.previewWinRate !== undefined ? 'preview game' : 'battles',
			members: t.sets.map((s, i) => r && !r.revertedTuning ? {entryId: r.members[i].entryId, set: r.members[i].refined, changes: r.members[i].changes,
				bringRate: r.members[i].bringRate, leadRate: r.members[i].leadRate} : member(s)),
			threats: r ? r.threats : [],
		});
		if (out.ladder.teams.length >= Number(arg('top', 5))) break;
	}
}

const eq = read(arg('equilibrium'));
if (eq) {
	out.equilibrium = {converged: !!eq.converged, reason: eq.reason || '', eps: eq.eps, population: eq.population.length,
		teams: eq.population.map((p, i) => ({weight: p.weight, label: p.label, members: p.sets.map(member),
			// average win rate against the other teams in the mix
			vsMix: +eq.population.reduce((a, q, j) => a + q.weight * eq.matrix[i][j], 0).toFixed(4)}))
			.filter(t => t.weight > 0.01).sort((a, b) => b.weight - a.weight)};
}

const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'web', 'data', 'strategies.json')));
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(`wrote ${OUT}: ${out.ladder ? out.ladder.teams.length : 0} ladder teams, ${out.equilibrium ? out.equilibrium.teams.length : 0} equilibrium teams`);
