'use strict';
// The value of one team against another as the team-preview game it really is: each side chooses which three to
// bring (and which leads), both at once, so the right payoff is the equilibrium of that choice, not the result of
// one fixed pick. The pilots pick deterministically at preview, which let counter-teams win 90-100% of games
// against a team whose one pick they were built to beat (sim/double-oracle.js, 2026-11-16).
//
//   1. screen  all 20 x 20 trio pairings (lead = the trio's best member by the preview heuristic), fast pilot,
//              `screenGames` paired games per cell; solve that matrix game
//   2. decide  each side's `keep` most relevant trios (equilibrium weight, then value against the other side's
//              mix) play each other with the strong pilot, `strongGames` per cell; solve: the value is A's
//              equilibrium win probability
//
// A 3-member team skips preview and leads with its first member (sim/battle.js), which is how a trio is forced.

const {Battle} = require('pokemon-showdown');
const {FORMAT_ID} = require('./format');
const {matchupScore} = require('./agent');
const {seedFrom, isFailed} = require('./util');
const {solve} = require('./nash');

/** The 20 trios of `mine` against `theirs`, each ordered best-first by the preview heuristic. */
function trios(mine, theirs) {
	const b = new Battle({formatid: FORMAT_ID, seed: [1, 2, 3, 4], send: () => {}});
	b.setPlayer('p1', {name: 'A', team: mine});
	b.setPlayer('p2', {name: 'B', team: theirs});
	const score = b.p1.pokemon.map(p => b.p2.pokemon.reduce((t, f) => t + matchupScore(b, p, f), 0));
	b.destroy();
	const out = [];
	for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) for (let k = j + 1; k < mine.length; k++) {
		const m = [i, j, k].sort((x, y) => score[y] - score[x]);
		out.push({members: m, sets: m.map(x => mine[x]), score: score[i] + score[j] + score[k]});
	}
	return out;
}

/** Paired win matrix of A's options against B's options (A's win probability per cell). */
async function cellMatrix(pool, optsA, optsB, games, agent, rng) {
	const jobs = [], meta = [];
	for (let i = 0; i < optsA.length; i++) for (let j = 0; j < optsB.length; j++) {
		for (let g = 0; g < games; g++) {
			const seed = seedFrom(rng), flip = g % 2 === 1;
			jobs.push({a: flip ? optsB[j].sets : optsA[i].sets, b: flip ? optsA[i].sets : optsB[j].sets, seed, agents: [agent, agent]});
			meta.push({i, j, flip});
		}
	}
	const res = await pool.run(jobs, agent.startsWith('rollout') ? 4 : 24);
	const w = optsA.map(() => optsB.map(() => ({w: 0, g: 0})));
	res.forEach((r, k) => {
		if (isFailed(r)) return;
		const {i, j, flip} = meta[k];
		const win = r === null ? 0.5 : (r === (flip ? 1 : 0) ? 1 : 0);
		w[i][j].w += win; w[i][j].g++;
	});
	return {M: w.map(row => row.map(c => c.g ? c.w / c.g : 0.5)), battles: jobs.length};
}

/**
 * @returns {value, screenValue, keepA, keepB, xA, yB, battles: {fast, strong}}
 */
async function previewValue(pool, teamA, teamB, rng, {fast = 'heuristic2', strong = 'rollout4all', screenGames = 4, strongGames = 12, keep = 6} = {}) {
	const A = trios(teamA, teamB), B = trios(teamB, teamA);
	const scr = await cellMatrix(pool, A, B, screenGames, fast, rng);
	const s = solve(scr.M, {iters: 6000, tol: 1e-4});
	// relevance: equilibrium weight first, then how well the option does against the other side's mix
	const rowVal = A.map((_, i) => B.reduce((t, _b, j) => t + s.y[j] * scr.M[i][j], 0));
	const colVal = B.map((_, j) => A.reduce((t, _a, i) => t + s.x[i] * (1 - scr.M[i][j]), 0));
	const rank = (w, v) => w.map((x, i) => i).sort((p, q) => (w[q] - w[p]) || (v[q] - v[p])).slice(0, keep);
	const ka = rank(s.x, rowVal), kb = rank(s.y, colVal);
	const st = await cellMatrix(pool, ka.map(i => A[i]), kb.map(j => B[j]), strongGames, strong, rng);
	const r = solve(st.M, {iters: 8000, tol: 1e-4});
	return {value: r.value, screenValue: s.value, keepA: ka.map(i => A[i].members), keepB: kb.map(j => B[j].members),
		xA: r.x, yB: r.y, battles: {fast: scr.battles, strong: st.battles}};
}

module.exports = {previewValue, trios};
