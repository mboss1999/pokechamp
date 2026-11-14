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
	const prior = priorFor(resultsPath);
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
	constructor(pool, mine, theirSpecies, {policy = 'heuristic', resultsPath = DEFAULT_RESULTS, salt = 0} = {}) {
		Object.assign(this, {pool, mine, theirSpecies, policy, resultsPath});
		this.OPTS = options(mine.length);
		this.M = this.OPTS.length;
		this.base = hash(`${mine.map(s => s.species).join(',')}|${theirSpecies.join(',')}|${salt}|${policy}`);
		this.outs = Array.from({length: this.M}, () => Array.from({length: this.M}, () => [])); // outs[r][c][s]
		this.battles = 0;
		this.failed = 0; // battles in jobs that could not be run (kept as NaN, never scored)
	}

	/** Give each cell of rows x cols `n` more samples. */
	async sample(rows, cols, n, onProgress) {
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
				// split big jobs so all cores stay busy
				const per = Math.max(1, Math.floor(240 / n));
				for (let x = 0; x < cs.length; x += per) {
					const part = cs.slice(x, x + per);
					jobs.push({type: 'draft', mine: this.mine, theirSpecies: this.theirSpecies, row: r, cols: part,
						samples: Array.from({length: n}, (_, i) => k + i), base: this.base, policy: this.policy, resultsPath: this.resultsPath});
					meta.push({r, cs: part});
				}
			}
		}
		const res = await this.pool.run(jobs, 1, x => {
			this.battles += meta[x].cs.length * n;
			if (onProgress) onProgress(this.battles);
		});
		res.forEach((out, x) => {
			const {r, cs} = meta[x];
			// a failed job leaves NaN holes, keeping sample indices aligned; they are skipped, not scored
			if (isFailed(out)) this.failed += cs.length * n;
			cs.forEach((c, i) => this.outs[r][c].push(...(isFailed(out) ? new Array(n).fill(NaN) : out.outs[i])));
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
	report() {
		const {OPTS, M, mine, theirSpecies} = this;
		const A = this.matrix();
		const eq = solve(A);
		const all = [...Array(M).keys()];
		const best = eq.rowVals.indexOf(Math.max(...eq.rowVals));
		const varOf = all => {
			const xs = all.filter(Number.isFinite);
			if (xs.length < 2) return 0.25;
			const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
			return xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1);
		};
		const valid = o => o.filter(Number.isFinite).length;
		const se = i => Math.sqrt(all.reduce((s, j) => s + (eq.y[j] ? eq.y[j] ** 2 * varOf(this.outs[i][j]) / Math.max(1, valid(this.outs[i][j])) : 0), 0));
		const lossSe = i => i === best ? 0 : Math.sqrt(all.reduce((s, j) => {
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
			theirMix: all.filter(j => eq.y[j] > 0.01).map(j => ({
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

module.exports = {options, previewChoice, runJob, DraftMatrix, solveDraft};
