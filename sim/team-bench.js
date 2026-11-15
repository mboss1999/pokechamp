'use strict';
// Team-level benchmark: are the Team Builder's teams as strong as the teams strong ladder players actually bring?
//
// Field: real teams from Showdown replays of the format (team preview gives the 6 species; Mega Evolution, moves
// and items are filled in from what the replay reveals, the rest from the ladder's modal set, sim/ladderstats.js).
// Only the side of each replay whose ladder rating is at least --min-rating is used.
//
// Every team (ours and the real ones) plays a round robin against the real teams, both sides piloted by the same AI
// (bring 6, pick 3), sides swapped every other game. A real team scores ~50% against its own field by symmetry,
// so our teams' score against it says how they compare with a typical strong ladder team, and the real teams' spread
// says how far above typical they are.
//
//   curl replays: https://replay.pokemonshowdown.com/search.json?user=<id>&format=<format>, then <id>.log
//   node sim/team-bench.js --replays dir --stats chaos.json --agent rollout4all --games 2 --pool lambda
//   --results other/results.json benchmarks the teams built from other simulation results.

const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const F = require('./format');
const {dex, toID} = F;
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');
const {toPokemonSet} = require('./refine');
const {loadLadder} = require('./ladderstats');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const RESULTS_PATH = path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json')));
const RESULTS = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const AGENT = arg('agent', 'heuristic2');
const GAMES = Number(arg('games', 2));
const MIN_RATING = Number(arg('min-rating', 1250));
const OUT = path.resolve(arg('out', `out/team-bench/${AGENT}.json`));
// --no-rr skips the real teams' own round robin (their percentiles), which is most of the battles
const NO_RR = argv.includes('--no-rr');
const entries = RESULTS.entries;

async function main() {
	const real = require('./team-bench-lib').realTeams(path.resolve(arg('replays')), RESULTS, arg('stats'), MIN_RATING);
	const {buildTeams, assignSets, makeScorer} = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'team.js')).href);
	const all = new Set(entries.map(e => e.species)); // the whole roster as the collection
	const ours = buildTeams(RESULTS, all, {scorer: makeScorer(RESULTS), teams: Number(arg('teams', 5)), includeMegas: true})
		.filter(t => t.members.length === 6)
		.map((t, k) => ({label: `builder #${k + 1}`, ours: true,
			team: assignSets(RESULTS, t.members).map(m => clean(toPokemonSet(m.entry, m.set)))}));
	console.log(`${real.length} real teams (rating >= ${MIN_RATING}), ${ours.length} builder teams`);
	for (const t of ours) console.log(`  ${t.label}: ${t.team.map(s => s.species + (s.item.match(/ite( [XYZ])?$/) ? '-Mega' : '')).join(', ')}`);
	if (argv.includes('--print')) {
		for (const t of real.slice(0, 10)) console.log(`  ${t.label}: ${t.team.map(s => `${s.species}@${s.item}`).join(', ')}`);
		return;
	}
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 500))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();

	const teams = [...ours, ...real];
	const rng = mulberry32(hash('team-bench') + Number(arg('salt', 0)));
	const jobs = [], meta = [];
	// every team against every real team (a real team doesn't play itself)
	for (let i = 0; i < teams.length; i++) {
		for (let j = ours.length; j < teams.length; j++) {
			if (i === j || (i >= ours.length && j < i)) continue; // real pairs once
			if (NO_RR && i >= ours.length) continue; // --no-rr: only our teams against the real ones
			for (let g = 0; g < GAMES; g++) {
				const flip = g % 2 === 1;
				jobs.push({a: flip ? teams[j].team : teams[i].team, b: flip ? teams[i].team : teams[j].team,
					seed: seedFrom(rng), agents: [AGENT, AGENT]});
				meta.push({i, j, flip});
			}
		}
	}
	const t0 = Date.now();
	console.log(`${jobs.length} battles with ${AGENT}`);
	const res = await pool.run(jobs, AGENT.startsWith('rollout') ? 2 : 8);
	const score = teams.map(() => ({w: 0, g: 0}));
	res.forEach((r, k) => {
		if (isFailed(r)) return;
		const {i, j, flip} = meta[k];
		const iWon = r === null ? 0.5 : (r === (flip ? 1 : 0) ? 1 : 0);
		score[i].w += iWon; score[i].g++;
		if (j >= ours.length && i >= ours.length) { score[j].w += 1 - iWon; score[j].g++; }
	});
	const rate = s => s.w / (s.g || 1);
	const realRates = real.map((t, k) => rate(score[ours.length + k])).sort((a, b) => a - b);
	const pct = x => NO_RR ? null : realRates.filter(r => r < x).length / realRates.length;
	const report = {agent: AGENT, games: GAMES, results: RESULTS.meta.generatedAt, realTeams: real.length, minRating: MIN_RATING,
		ours: ours.map((t, k) => ({label: t.label, team: t.team, winRate: +rate(score[k]).toFixed(4), games: score[k].g,
			se: +Math.sqrt(rate(score[k]) * (1 - rate(score[k])) / (score[k].g || 1)).toFixed(4), percentile: pct(rate(score[k]))})),
		real: real.map((t, k) => ({label: t.label, species: t.team.map(s => s.species), winRate: +rate(score[ours.length + k]).toFixed(4), games: score[ours.length + k].g})),
		realQuantiles: NO_RR ? null : [0.1, 0.25, 0.5, 0.75, 0.9].map(q => +realRates[Math.floor(q * (realRates.length - 1))].toFixed(3)),
		failed: pool.failed || 0};
	fs.mkdirSync(path.dirname(OUT), {recursive: true});
	fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
	for (const o of report.ours) console.log(`${o.label}: ${(100 * o.winRate).toFixed(1)}% ± ${(100 * o.se).toFixed(1)} vs real teams (${o.games} games)` +
		(o.percentile === null ? '' : `, percentile ${(100 * o.percentile).toFixed(0)} among real teams`));
	if (report.realQuantiles) console.log(`real teams' win rate quantiles (10/25/50/75/90%): ${report.realQuantiles.map(x => (100 * x).toFixed(1)).join(' / ')}`);
	console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s; failed ${pool.failed || 0}`);
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
