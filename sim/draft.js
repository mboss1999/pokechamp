'use strict';
// Team preview solver: which three to bring and which to lead, against an opponent seen only by species.
//
// Each side has 60 options (6 leads x 10 pairs for the back). Cell (i, j) of the payoff matrix is my win
// probability when I play option i and they play option j, estimated by full battles in which the
// opponent's sets are drawn from the meta belief (sim/belief.js) and an agent pilots both sides.
// Sample s uses the same opponent sets and dice in every cell, so cells are compared on equal terms.
// The game is solved for its equilibrium (sim/nash.js); an option's value is its win probability against
// the opponent's equilibrium mix, and its loss is the gap to the best option.
//
// Simulating all 3,600 cells thoroughly is wasteful, so sampling is adaptive:
//   screen  every cell, a few samples
//   refine  more samples where it matters: my best rows x their most dangerous columns
//   grade   every one of my options against the columns the opponent actually plays at equilibrium,
//           so any pick (yours included) gets an accurate value

const fs = require('fs');
const path = require('path');
const {Battle} = require('pokemon-showdown');
const {FORMAT_ID} = require('./format');
const {playOut} = require('./battle');
const {drawTeam} = require('./belief');
const {priorFor, DEFAULT_RESULTS} = require('./engine');
const {solve} = require('./nash');
const {mulberry32, hash, isFailed} = require('./util');

/** All 60 (lead, back pair) options for a team of six, as 0-based slot triples [lead, b1, b2]. */
function options(n = 6) {
	const out = [];
	for (let lead = 0; lead < n; lead++) {
		const rest = [...Array(n).keys()].filter(k => k !== lead);
		for (let a = 0; a < rest.length; a++) for (let b = a + 1; b < rest.length; b++) out.push([lead, rest[a], rest[b]]);
	}
	return out;
}

/** Team preview choice string: the three brought first, lead first; the rest after. */
function previewChoice(opt, n = 6) {
	const order = [...opt, ...[...Array(n).keys()].filter(k => !opt.includes(k))];
	return 'team ' + order.map(k => k + 1).join('');
}

const sampleSeed = (base, s) => (base + Math.imul(s + 1, 0x9e3779b1)) >>> 0;

/** Worker job: one of my options against several of theirs, over the given sample indices. */
function runJob(job) {
	const {mine, theirSpecies, row, cols, samples, base, policy, resultsPath} = job;
	const prior = priorFor(resultsPath && fs.existsSync(resultsPath) ? resultsPath : DEFAULT_RESULTS);
	const OPTS = options(mine.length);
	const outs = cols.map(() => []);
	for (const s of samples) {
		const seed = sampleSeed(base, s);
		const theirs = drawTeam(prior, theirSpecies, mulberry32(seed));
		const dice = [seed & 0xffff, seed >>> 16, s & 0xffff, 0x7d];
		cols.forEach((col, c) => {
			const b = new Battle({formatid: FORMAT_ID, seed: dice, send: () => {}});
			b.setPlayer('p1', {name: 'A', team: mine});
			b.setPlayer('p2', {name: 'B', team: theirs});
			b.choose('p1', previewChoice(OPTS[row], mine.length));
			b.choose('p2', previewChoice(OPTS[col], theirs.length));
			playOut(b, [policy, policy]);
			outs[c].push(b.winner === 'A' ? 1 : b.winner === 'B' ? 0 : 0.5);
			b.destroy();
		});
	}
	return {outs}; // outs[c][i]: result of sample samples[i] against cols[c]
}

/**
 * @param pool          sim/pool Pool
 * @param mine          my six PokemonSets (known to me)
 * @param theirSpecies  their six species names (all I see at preview)
 * @param opts          {screen, refine, grade: samples per cell at each stage; refineRows, refineCols;
 *                       policy; resultsPath; salt; onProgress(fraction)}
 */
/**
 * The sampled payoff matrix of one preview matchup. Every cell draws samples 0, 1, 2, ... in order, and
 * sample s means the same opponent sets and dice everywhere, so any two cells can be compared pairwise.
 */
class DraftMatrix {
	constructor(pool, mine, theirSpecies, {policy = 'heuristic2', resultsPath = DEFAULT_RESULTS, salt = 0, jobBattles} = {}) {
		// battles per worker job: big for the fast AI (less overhead), small for slow AIs so every core stays busy.
		// On Lambda (pool.remote) a job is one invocation, so it must also stay well inside the time limit.
		jobBattles = jobBattles || (pool.remote ? (policy.startsWith('rollout') ? 4 : 48) : (policy.startsWith('rollout') ? 12 : 240));
		// the default results file is sent as no path: a path on this machine means nothing on Lambda (whose bundle has
		// its own copy of web/data/results.json), and every battle there failed on it
		if (path.resolve(resultsPath) === path.resolve(DEFAULT_RESULTS)) resultsPath = undefined;
		Object.assign(this, {pool, mine, theirSpecies, policy, resultsPath, jobBattles});
		this.OPTS = options(mine.length);
		this.M = this.OPTS.length;
		this.base = hash(`${mine.map(s => s.species).join(',')}|${theirSpecies.join(',')}|${salt}|${policy}`);
		this.outs = Array.from({length: this.M}, () => Array.from({length: this.M}, () => [])); // outs[r][c][s]
		this.battles = 0;
		this.failed = 0; // battles in jobs that could not be run (kept as NaN, never scored)
	}

	/** Give each cell of rows x cols `n` more samples. */
	async sample(rows, cols, n, onProgress, priority = 0) {
		const jobs = [], meta = [];
		for (const r of rows) {
			// columns at the same sample index share a job
			const groups = new Map();
			for (const c of cols) {
				const k = this.outs[r][c].length;
				if (!groups.has(k)) groups.set(k, []);
				groups.get(k).push(c);
			}
			for (const [k, cs] of groups) {
				// split big jobs so all cores stay busy: by samples first, then by columns. Sample chunks go in
				// increasing order, so each cell's results are appended in sample order.
				const sc = Math.max(1, Math.min(n, this.jobBattles));
				const per = Math.max(1, Math.floor(this.jobBattles / sc));
				for (let s0 = 0; s0 < n; s0 += sc) {
					const samples = Array.from({length: Math.min(sc, n - s0)}, (_, i) => k + s0 + i);
					for (let x = 0; x < cs.length; x += per) {
						const part = cs.slice(x, x + per);
						jobs.push({type: 'draft', mine: this.mine, theirSpecies: this.theirSpecies, row: r, cols: part,
							samples, base: this.base, policy: this.policy, resultsPath: this.resultsPath});
						meta.push({r, cs: part, n: samples.length});
					}
				}
			}
		}
		// count each job once, whether its results arrived one by one or as a replayed block (sim/checkpoint.js)
		const counted = new Set();
		const count = x => { if (!counted.has(x)) { counted.add(x); this.battles += meta[x].cs.length * meta[x].n; } };
		const res = await this.pool.run(jobs, 1, (x, r) => {
			const n = Array.isArray(r) && r.length > 1 ? r.length : 1; // a replayed block reports all its jobs at once
			for (let k = x; k < x + n && k < jobs.length; k++) count(k);
			if (onProgress) onProgress(this.battles);
		}, priority);
		jobs.forEach((_, x) => count(x));
		res.forEach((out, x) => {
			const {r, cs, n: m} = meta[x];
			// a failed job leaves NaN holes, keeping sample indices aligned; they are skipped, not scored
			if (isFailed(out)) this.failed += cs.length * m;
			cs.forEach((c, i) => this.outs[r][c].push(...(isFailed(out) ? new Array(m).fill(NaN) : out.outs[i])));
		});
	}

	matrix() {
		return this.outs.map(row => row.map(o => {
			const ok = o.filter(Number.isFinite);
			return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : 0.5;
		}));
	}

	/**
	 * Solve and describe every option. lossSe pairs each option with the best one sample by sample (same
	 * opponent sets and dice), which is much tighter than comparing two independent estimates.
	 */
	report({rows, cols, extraRows = []} = {}) {
		const {OPTS, M, mine, theirSpecies} = this;
		const full = this.matrix();
		const all0 = [...Array(M).keys()];
		rows = rows || all0;
		cols = cols || all0;
		// Solve the game restricted to rows x cols, then map it back to full-size vectors (zeros outside).
		// extraRows are valued against the opponent's equilibrium mix but take no part in the solve.
		const sub = solve(rows.map(r => cols.map(c => full[r][c])));
		const eq = {value: sub.value, gap: sub.gap, x: new Array(M).fill(0), y: new Array(M).fill(0),
			rowVals: new Array(M).fill(NaN), colVals: new Array(M).fill(NaN)};
		rows.forEach((r, i) => { eq.x[r] = sub.x[i]; });
		cols.forEach((c, j) => { eq.y[c] = sub.y[j]; eq.colVals[c] = sub.colVals[j]; });
		for (const r of [...rows, ...extraRows]) eq.rowVals[r] = cols.reduce((t, c) => t + full[r][c] * eq.y[c], 0);
		const A = full;
		const all = [...rows, ...extraRows.filter(r => !rows.includes(r))];
		const best = rows.reduce((b, r) => eq.rowVals[r] > eq.rowVals[b] ? r : b, rows[0]);
		const varOf = all => {
			const xs = all.filter(Number.isFinite);
			if (xs.length < 2) return 0.25;
			const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
			return xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
		};
		const valid = o => o.filter(Number.isFinite).length;
		const se = i => Math.sqrt(cols.reduce((s, j) => s + (eq.y[j] ? eq.y[j] ** 2 * varOf(this.outs[i][j]) / Math.max(1, valid(this.outs[i][j])) : 0), 0));
		const lossSe = i => i === best ? 0 : Math.sqrt(cols.reduce((s, j) => {
			if (!eq.y[j]) return s;
			const a = this.outs[best][j], b = this.outs[i][j], n = Math.min(a.length, b.length);
			const d = Array.from({length: n}, (_, k) => a[k] - b[k]).filter(Number.isFinite);
			return s + eq.y[j] ** 2 * varOf(d) / Math.max(1, d.length);
		}, 0));
		const names = (team, opt) => opt.map(k => team[k]);
		return {
			value: eq.value, gap: eq.gap, battles: this.battles, failed: this.failed,
			options: all.map(i => ({
				index: i, option: OPTS[i], lead: mine[OPTS[i][0]].species, back: [mine[OPTS[i][1]].species, mine[OPTS[i][2]].species],
				value: eq.rowVals[i], se: se(i), loss: eq.rowVals[best] - eq.rowVals[i], lossSe: lossSe(i), mix: eq.x[i],
			})).sort((a, b) => b.value - a.value),
			theirMix: cols.filter(j => eq.y[j] > 0.01).map(j => ({
				index: j, option: OPTS[j], lead: theirSpecies[OPTS[j][0]], back: names(theirSpecies, OPTS[j]).slice(1), p: eq.y[j],
			})).sort((a, b) => b.p - a.p),
			eq,
		};
	}
}

/**
 * Adaptive solve (see the top of this file).
 * @param opts {screen, refine, grade: samples per cell at each stage; refineRows, refineCols; policy;
 *              resultsPath; salt; onProgress(battles)}
 */
async function solveDraft(pool, mine, theirSpecies, opts = {}) {
	const {screen = 4, refine = 16, grade = 48, refineRows = 16, refineCols = 16} = opts;
	const dm = new DraftMatrix(pool, mine, theirSpecies, opts);
	const all = [...Array(dm.M).keys()];
	const top = (vals, k, keep = []) => [...new Set([...keep, ...all.slice().sort((a, b) => vals(b) - vals(a)).slice(0, k)])];

	await dm.sample(all, all, screen, opts.onProgress);
	let eq = solve(dm.matrix());
	const rowsR = top(i => eq.rowVals[i], refineRows, all.filter(i => eq.x[i] > 0.01));
	const colsR = top(j => -eq.colVals[j], refineCols, all.filter(j => eq.y[j] > 0.01));
	await dm.sample(rowsR, colsR, refine, opts.onProgress);
	eq = solve(dm.matrix());
	await dm.sample(all, all.filter(j => eq.y[j] > 0.01), grade, opts.onProgress);
	return {...dm.report(), matrix: dm};
}

/**
 * Strong-AI analysis at a fraction of the cost. A strong pilot (rollout4all) is ~60x slower than the heuristic,
 * and filling all 3,600 cells with it costs ~40k slow battles. But the heuristic, though biased, is a good
 * filter for my own options: in the convergence benchmark the strong AI's best pick was always tied with one
 * of the heuristic's top 10. It is not a good filter for the opponent's replies, so those are probed by the strong AI.
 *
 *   1. screen   the heuristic plays every cell (cheap), then refines the contested corner
 *   2. corner   the strong AI plays my `rows` best options (by the heuristic) against their `cols` most
 *               dangerous replies, `strong` samples per cell
 *   3. expand   double oracle: solve the strong corner; the strong AI probes every other reply against my
 *               equilibrium mix (`probe` samples), and the most dangerous join the corner, up to `rounds` times
 *   4. grade    my corner options against the opponent's equilibrium replies, topped up to `grade` samples
 *
 * Returns the strong report for the corner rows (other options are not valued; gradeOption adds one).
 */
class StrongDraft {
	constructor(pool, mine, theirSpecies, opts = {}) {
		this.opts = {screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48, probe: 4, addCols: 4, rounds: 2,
			margin: 0.04, policy: 'rollout4all', ...opts};
		const {resultsPath = DEFAULT_RESULTS, salt = 0} = this.opts;
		this.h = new DraftMatrix(pool, mine, theirSpecies, {policy: 'heuristic2', resultsPath, salt});
		this.s = new DraftMatrix(pool, mine, theirSpecies, {policy: this.opts.policy, resultsPath, salt});
		this.extraRows = [];
		this.progress = 0; // battles, weighted: one strong battle counts as STRONG_COST heuristic ones
	}

	get battles() { return this.h.battles + this.s.battles; }
	get failed() { return this.h.failed + this.s.failed; }

	async run(onProgress) {
		const {screen, refine, rows, cols, strong, grade, probe, addCols, rounds, margin} = this.opts;
		const {h, s} = this;
		const all = [...Array(h.M).keys()];
		const top = (vals, k, keep = []) => [...new Set([...keep, ...all.slice().sort((a, b) => vals(b) - vals(a)).slice(0, k)])];
		const report = () => onProgress && onProgress(h.battles + STRONG_COST * s.battles);

		// 1. heuristic screen and refine
		await h.sample(all, all, screen, report);
		let eqH = solve(h.matrix());
		await h.sample(top(i => eqH.rowVals[i], 16, all.filter(i => eqH.x[i] > 0.01)),
			top(j => -eqH.colVals[j], 16, all.filter(j => eqH.y[j] > 0.01)), refine, report);
		const H = h.matrix();
		eqH = solve(H);

		// 2. strong corner
		const R = top(i => eqH.rowVals[i], rows, all.filter(i => eqH.x[i] > 0.01));
		const C = top(j => -eqH.colVals[j], cols, all.filter(j => eqH.y[j] > 0.01));
		await s.sample(R, C, strong, report);

		// 3. double oracle on columns. The heuristic is a poor guide to the opponent's best replies (the strong
		// AI's equilibrium replies were often far down the heuristic's list), so the strong AI screens every
		// reply against my current mix with a few battles, and the most dangerous join the corner.
		for (let round = 0; round < rounds; round++) {
			const sr = s.report({rows: R, cols: C});
			const supp = R.filter(r => sr.eq.x[r] > 0.01);
			const rest = all.filter(j => !C.includes(j));
			await s.sample(supp, rest.filter(j => s.outs[supp[0]][j].length < probe), probe, report);
			const S = s.matrix();
			const w = supp.reduce((t, r) => t + sr.eq.x[r], 0);
			const vsMix = j => supp.reduce((t, r) => t + sr.eq.x[r] * S[r][j], 0) / w;
			const fresh = rest.filter(j => vsMix(j) < sr.value + margin).sort((a, b) => vsMix(a) - vsMix(b)).slice(0, addCols);
			if (!fresh.length) break;
			await s.sample(R, fresh, strong, report);
			C.push(...fresh);
		}

		// 4. grade against the equilibrium replies
		const support = s.report({rows: R, cols: C}).theirMix.map(t => t.index);
		await s.sample(R, support, Math.max(0, grade - strong), report);
		this.R = R;
		this.C = C;
		return this.report();
	}

	/** Value one more of my options (for instance the player's own pick) against the equilibrium replies. */
	async gradeOption(index, onProgress) {
		return this.gradeOptions([index], this.opts.grade, onProgress, 1);
	}

	/**
	 * Value several of my options against the equilibrium replies, with `samples` strong battles per cell (the drill
	 * bank grades every option this way, so any pick gets a verdict). priority 1: someone is waiting on it.
	 */
	async gradeOptions(indices, samples = this.opts.grade, onProgress, priority = 0) {
		const todo = indices.filter(i => !this.R.includes(i) && !this.extraRows.includes(i));
		if (!todo.length) return this.report();
		const support = this.report().theirMix.map(t => t.index);
		await this.s.sample(todo, support, samples, onProgress && (() => onProgress(this.h.battles + STRONG_COST * this.s.battles)), priority);
		this.extraRows.push(...todo);
		return this.report();
	}

	report() {
		const r = this.s.report({rows: this.R, cols: this.C, extraRows: this.extraRows});
		return {...r, battles: this.battles, failed: this.failed, strongBattles: this.s.battles, corner: [this.R.length, this.C.length]};
	}
}

// rough cost of one rollout4all battle in heuristic2 battles, for progress bars
const STRONG_COST = 150; // measured 2026-11-15 (draft cells, this Mac): heuristic2 ~5 ms, rollout4all ~0.73 s of wall time per battle

/** Expected weighted battle count of a StrongDraft run (for progress bars). */
function strongDraftCost(opts = {}) {
	const o = {screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48, probe: 4, addCols: 4, rounds: 2, ...opts};
	const heur = 3600 * o.screen + 256 * o.refine;
	// corner, then each round: ~3 support rows probe ~50 replies, and the new replies join the corner
	const strong = o.rows * o.cols * o.strong + o.rounds * (3 * 50 * o.probe + o.rows * o.addCols * o.strong) +
		o.rows * 4 * Math.max(0, o.grade - o.strong);
	return heur + STRONG_COST * strong;
}

async function solveDraftStrong(pool, mine, theirSpecies, opts = {}) {
	const sd = new StrongDraft(pool, mine, theirSpecies, opts);
	const r = await sd.run(opts.onProgress);
	return {...r, matrix: sd.s, solver: sd};
}

/** The client-facing form of a draft analysis (web/serve.cjs and the drill bank, sim/draft-bank.js). */
function draftResult(r, budget, mine, theirs) {
	const A = r.matrix.matrix();
	return {
		value: r.value, battles: r.battles, strongBattles: r.strongBattles || 0, budget, strong: !!r.strongBattles,
		mine: mine.map(s => s.species), theirs,
		options: r.options.map(o => ({...o, vsTheirs: r.theirMix.map(t => A[o.index][t.index])})),
		theirMix: r.theirMix,
	};
}

module.exports = {draftResult, options, previewChoice, runJob, DraftMatrix, solveDraft, StrongDraft, solveDraftStrong, strongDraftCost, STRONG_COST};
