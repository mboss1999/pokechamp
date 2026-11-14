'use strict';
// Head-to-head test between two agents. Each pair of meta teams is played twice
// with the agents swapped (same seed), so team strength cancels out and only
// piloting skill shows.
//
// Usage: node sim/compare.js [--pairs 300] [--a lookahead] [--b heuristic]

const path = require('path');
const {Pool} = require('./pool');
const {toPokemonSet} = require('./refine');
const {mulberry32, seedFrom, clean, isFailed} = require('./util');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const PAIRS = Number(arg('pairs', 300));
const A = arg('a', 'lookahead'), B = arg('b', 'heuristic');
const results = require(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))));

function metaTeam(rng) {
	const {entries} = results;
	const w = entries.map(e => Math.exp((e.rating - 1500) / 120));
	const total = w.reduce((x, y) => x + y, 0);
	const species = new Set(), items = new Set(), team = [];
	while (team.length < 6) {
		let r = rng() * total, i = 0;
		while ((r -= w[i]) > 0 && i < entries.length - 1) i++;
		const e = entries[i];
		if (species.has(e.species)) continue;
		const desc = [e.set, ...e.alts].find(s => !s.item || !items.has(s.item));
		if (!desc) continue;
		species.add(e.species); items.add(desc.item);
		team.push(clean(toPokemonSet(e, desc)));
	}
	return team;
}

(async () => {
	const rng = mulberry32(20261022);
	const jobs = [];
	for (let p = 0; p < PAIRS; p++) {
		const t1 = metaTeam(rng), t2 = metaTeam(rng), seed = seedFrom(rng);
		jobs.push({a: t1, b: t2, seed, agents: [A, B]}); // agent A pilots t1
		jobs.push({a: t1, b: t2, seed, agents: [B, A]}); // agent A pilots t2
	}
	const pool = new Pool();
	const t0 = Date.now();
	const res = await pool.run(jobs, 2);
	pool.close();
	if (pool.failed || pool.workerFailures) {
		console.log(`WARNING: ${pool.failed} battles failed (${pool.errors} crashed, ${pool.workerFailures} worker failures); their pairs are left out:`, pool.errorSamples);
	}
	let score = 0, games = 0, errors = 0, failedPairs = 0, bothSame = 0;
	const pairScores = [];
	for (let p = 0; p < PAIRS; p++) {
		const r1 = res[2 * p], r2 = res[2 * p + 1];
		// a failed game drops its pair, since the mirrored game alone would let team strength back in
		if (isFailed(r1) || isFailed(r2)) { failedPairs++; continue; }
		if (r1 === null && r2 === null) { errors++; continue; }
		const s1 = r1 === 0 ? 1 : r1 === 1 ? 0 : 0.5; // A on side 0
		const s2 = r2 === 1 ? 1 : r2 === 0 ? 0 : 0.5; // A on side 1
		score += s1 + s2; games += 2;
		pairScores.push((s1 + s2) / 2);
		if (s1 === s2) bothSame++;
	}
	const p = score / games;
	const m = pairScores.reduce((x, y) => x + y, 0) / pairScores.length;
	const sd = Math.sqrt(pairScores.reduce((x, y) => x + (y - m) ** 2, 0) / pairScores.length);
	const se = sd / Math.sqrt(pairScores.length);
	console.log(`${A} vs ${B}: ${(100 * p).toFixed(1)}% ± ${(196 * se).toFixed(1)} (95% CI) over ${games} games`);
	console.log(`pairs where ${A} won/lost both sides: ${bothSame} of ${pairScores.length}; pairs drawn both games: ${errors}; pairs failed: ${failedPairs}`);
	console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s, ${(1000 * games / (Date.now() - t0)).toFixed(1)} battles/s`);
})();
