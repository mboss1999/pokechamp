'use strict';
// Team-preview benchmark: how much win rate does a preview policy (which three to bring) give up?
//
//   collect   for N team pairs (ladder field and Team Builder teams), play every one of the 20 x 20 trio pairings
//             (lead = the trio's best member by the preview heuristic) with the strong pilot, `games` mirrored games
//             per cell, stored as two independent halves; also store the pilot's pairwise matchup scores (6 x 6)
//   evaluate  offline, for each policy (a distribution over a side's 20 trios computed from the matchup scores):
//             regret = equilibrium value - value of the policy against the opponent's equilibrium mix, with the
//             equilibrium fitted on one half of the games and the policy scored on the other (no winner's curse);
//             averaged over pairs and both sides. The equilibrium itself scores ~0 by construction only on its own
//             half; on the other half it shows the noise floor.
//
//   node sim/preview-bench.js collect --pairs 30 --games 8 --pool lambda --out out/preview-bench/data.json
//   node sim/preview-bench.js evaluate --data out/preview-bench/data.json

const fs = require('fs');
const path = require('path');
const {Battle} = require('pokemon-showdown');
const {FORMAT_ID} = require('./format');
const {matchupScore} = require('./agent');
const {mulberry32, hash, seedFrom, isFailed, clean} = require('./util');
const {solve} = require('./nash');

const argv = process.argv.slice(2);
const MODE = argv[0];
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

const TRIOS = [];
for (let i = 0; i < 6; i++) for (let j = i + 1; j < 6; j++) for (let k = j + 1; k < 6; k++) TRIOS.push([i, j, k]);

/** 6 x 6 matchup scores of A's members against B's (the preview heuristic's own numbers). */
function scores(A, B) {
	const b = new Battle({formatid: FORMAT_ID, seed: [1, 2, 3, 4], send: () => {}});
	b.setPlayer('p1', {name: 'A', team: A});
	b.setPlayer('p2', {name: 'B', team: B});
	const m = b.p1.pokemon.map(p => b.p2.pokemon.map(f => matchupScore(b, p, f)));
	const r = b.p2.pokemon.map(p => b.p1.pokemon.map(f => matchupScore(b, p, f)));
	b.destroy();
	return {ab: m, ba: r};
}
const ordered = (team, trio, s) => trio.slice().sort((x, y) => s[y].reduce((a, v) => a + v, 0) - s[x].reduce((a, v) => a + v, 0)).map(i => team[i]);

async function collect() {
	const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
	const {Field} = require('./field');
	const {builderTeams, teamSets} = require('./team-search');
	const replayTeams = require('./team-bench-lib').realTeams(path.resolve(arg('replays', 'out/team-bench/replays')), results, arg('chaos'), 1250).map(t => t.team);
	const field = new Field({results, ingame: arg('ingame'), chaos: arg('chaos'), replayTeams, replayShare: 0.5});
	const rng = mulberry32(hash('preview-bench') + Number(arg('salt', 0)));
	const builders = (await builderTeams(results, 10)).map(t => teamSets(results, t));
	const N = Number(arg('pairs', 30)), G = Number(arg('games', 8));
	const pairs = Array.from({length: N}, (_, k) => [k % 3 === 0 ? builders[k % builders.length] : field.sample(rng), field.sample(rng)]);
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 700))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
	const AGENT = arg('agent', 'rollout4all');
	const out = {agent: AGENT, games: G, pairs: []};
	const t0 = Date.now();
	await Promise.all(pairs.map(async ([A, B], p) => {
		const s = scores(A, B);
		const jobs = [], meta = [];
		TRIOS.forEach((ta, i) => TRIOS.forEach((tb, j) => {
			const a = ordered(A, ta, s.ab), b = ordered(B, tb, s.ba);
			for (let g = 0; g < G; g++) {
				const flip = g % 2 === 1;
				jobs.push({a: flip ? b : a, b: flip ? a : b, seed: seedFrom(rng), agents: [AGENT, AGENT]});
				meta.push({i, j, flip, half: Math.floor(g / 2) % 2});
			}
		}));
		const res = await pool.run(jobs, 4);
		const cell = () => TRIOS.map(() => TRIOS.map(() => ({w: 0, g: 0})));
		const halves = [cell(), cell()];
		res.forEach((r, k) => {
			if (isFailed(r)) return;
			const {i, j, flip, half} = meta[k];
			const c = halves[half][i][j];
			c.w += r === null ? 0.5 : (r === (flip ? 1 : 0) ? 1 : 0); c.g++;
		});
		out.pairs[p] = {A: A.map(clean), B: B.map(clean), scores: s, halves: halves.map(h => h.map(row => row.map(c => [c.w, c.g])))};
		console.log(`pair ${p}: done [${((Date.now() - t0) / 1000).toFixed(0)}s, ${pool.battles} battles]`);
	}));
	fs.mkdirSync(path.dirname(path.resolve(arg('out', 'out/preview-bench/data.json'))), {recursive: true});
	fs.writeFileSync(path.resolve(arg('out', 'out/preview-bench/data.json')), JSON.stringify(out));
	console.log(`done: ${pool.battles} battles; failed ${pool.failed || 0}`);
	pool.close();
}

// ---- policies: (s = my 6x6 matchup scores against them, r = theirs against me) -> distribution over TRIOS ----
const softmax = (v, t) => { const m = Math.max(...v); const e = v.map(x => Math.exp((x - m) / t)); const z = e.reduce((a, b) => a + b, 0); return e.map(x => x / z); };
const trioScore = s => TRIOS.map(t => t.reduce((a, i) => a + s[i].reduce((x, y) => x + y, 0), 0));
/** Heuristic value of my trio T against their trio U: my best answer to each of theirs, and theirs to each of mine. */
function heuristicGame(s, r, kind) {
	return TRIOS.map(T => TRIOS.map(U => {
		if (kind === 'sum') return T.reduce((a, t) => a + U.reduce((x, u) => x + s[t][u], 0), 0) / 9;
		const mine = U.reduce((a, u) => a + Math.max(...T.map(t => s[t][u])), 0) / 3; // my best answer to each of theirs
		const theirs = T.reduce((a, t) => a + Math.max(...U.map(u => r[u][t])), 0) / 3; // their best answer to each of mine
		if (kind === 'answers') return mine - theirs;
		// lead matchup weighted in: the first member of each trio (by summed score) faces the other's first
		const lead = (tr, sc) => tr.slice().sort((x, y) => sc[y].reduce((a, v) => a + v, 0) - sc[x].reduce((a, v) => a + v, 0))[0];
		return mine - theirs + 0.5 * (s[lead(T, s)][lead(U, r)]);
	}));
}
const POLICIES = {
	fixed: (s) => { const v = trioScore(s); const b = v.indexOf(Math.max(...v)); return TRIOS.map((_, i) => i === b ? 1 : 0); },
	'softmax T=0.5': s => softmax(trioScore(s), 0.5),
	'softmax T=1': s => softmax(trioScore(s), 1),
	'softmax T=2': s => softmax(trioScore(s), 2),
	uniform: () => TRIOS.map(() => 1 / 20),
	'softmax T=0.05': s => softmax(trioScore(s), 0.05),
	'softmax T=0.1': s => softmax(trioScore(s), 0.1),
	'softmax T=0.2': s => softmax(trioScore(s), 0.2),
	'game: sum': (s, r) => solve(heuristicGame(s, r, 'sum'), {iters: 3000}).x,
	'game: answers': (s, r) => solve(heuristicGame(s, r, 'answers'), {iters: 3000}).x,
	'game: answers+lead': (s, r) => solve(heuristicGame(s, r, 'answers+lead'), {iters: 3000}).x,
};

/**
 * The pipeline's 1v1 matrix (strong pilot, HP margin; results.json matchups) as pairwise scores centred on 0, for a
 * pair of teams. A set is matched to its roster entry by species and Mega Stone (field sets differ in detail).
 */
function oneVsOne(results, A, B) {
	const {dex} = require('./format');
	const ids = results.matchups.ids, N = ids.length;
	const K = results.meta.matchupBattlesPerPair || 8;
	const bin = Buffer.from(results.matchups.data, 'base64').toString('binary');
	const idx = new Map(ids.map((id, i) => [id, i]));
	const byKey = new Map(results.entries.map(e => [`${e.species}|${e.megaItem || ''}`, e.id]));
	const entryIdx = st => idx.get(byKey.get(`${st.species}|${dex.items.get(st.item).megaStone ? st.item : ''}`) || byKey.get(`${st.species}|`));
	const ia = A.map(entryIdx), ib = B.map(entryIdx);
	const v = (i, j) => (i === undefined || j === undefined) ? 0 : ((bin.charCodeAt(i * N + j) / 255 * K + 1) / (K + 2)) - 0.5;
	return {ab: ia.map(i => ib.map(j => v(i, j))), ba: ib.map(j => ia.map(i => v(j, i)))};
}

function evaluate() {
	const data = JSON.parse(fs.readFileSync(path.resolve(arg('data', 'out/preview-bench/data.json')), 'utf8'));
	const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
	for (const p of data.pairs) p.oneVsOne = oneVsOne(results, p.A, p.B);
	const rate = h => h.map(row => row.map(([w, g]) => g ? w / g : 0.5));
	const regrets = Object.fromEntries([...Object.keys(POLICIES), 'equilibrium (other half)'].map(k => [k, []]));
	for (const p of data.pairs) {
		for (const fit of [0, 1]) {
			const Mfit = rate(p.halves[fit]), Mev = rate(p.halves[1 - fit]);
			const eq = solve(Mfit, {iters: 6000, tol: 1e-5});
			// both sides: A uses rows; B is the transposed game
			for (const side of [0, 1]) {
				const Mf = side ? Mfit[0].map((_, j) => Mfit.map(row => 1 - row[j])) : Mfit;
				const Me = side ? Mev[0].map((_, j) => Mev.map(row => 1 - row[j])) : Mev;
				const e = side ? solve(Mf, {iters: 6000, tol: 1e-5}) : eq;
				const s = side ? p.scores.ba : p.scores.ab, r = side ? p.scores.ab : p.scores.ba;
				// the opponent plays its equilibrium (fitted half); value on the evaluation half
				const val = x => x.reduce((a, xi, i) => a + xi * e.y.reduce((b, yj, j) => b + yj * Me[i][j], 0), 0);
				const v0 = val(e.x);
				const best = Math.max(...Me.map((_, i) => e.y.reduce((b, yj, j) => b + yj * Me[i][j], 0)));
				for (const [name, f] of Object.entries(POLICIES)) regrets[name].push(best - val(f(s, r)));
				const o = side ? p.oneVsOne.ba : p.oneVsOne.ab, q = side ? p.oneVsOne.ab : p.oneVsOne.ba;
				for (const [name, f] of Object.entries(POLICIES)) {
					if (name === 'uniform') continue;
					(regrets['1v1 ' + name] ||= []).push(best - val(f(o, q)));
				}
				regrets['equilibrium (other half)'].push(best - v0);
			}
		}
	}
	const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
	const se = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1) / a.length); };
	const pd = (a, b) => { const d = regrets[a].map((x, i) => x - regrets[b][i]); return `${(100 * mean(d)).toFixed(1)} ± ${(100 * se(d)).toFixed(1)}`; };
	if (regrets['1v1 fixed']) console.log(`paired: fixed - 1v1 fixed = ${pd('fixed', '1v1 fixed')}; 1v1 fixed - equilibrium = ${pd('1v1 fixed', 'equilibrium (other half)')}`);
	console.log(`regret against the opponent's equilibrium (points of win rate below the best reply), ${data.pairs.length} pairs, both sides, split halves`);
	for (const [k, v] of Object.entries(regrets).sort((a, b) => mean(a[1]) - mean(b[1]))) console.log(`  ${k.padEnd(26)} ${(100 * mean(v)).toFixed(1)} ± ${(100 * se(v)).toFixed(1)}`);
}

if (MODE === 'collect') collect().catch(e => { console.error(e); process.exit(1); });
else if (MODE === 'evaluate') evaluate();
else console.log('usage: node sim/preview-bench.js collect|evaluate [options]');
