'use strict';
// Analysis engine: how good is each option at one decision, judged without peeking at hidden information.
//
// For a decision of side `viewer`:
//   1. draw D determinizations of the opponent (its unseen sets and back Pokémon, from sim/belief.js);
//   2. in each, play every (my option, their option) pair to the end of the game K times, with fresh dice
//      and an agent piloting both sides afterwards ("rollouts"), sharing dice across cells to cut noise;
//   3. solve the Bayesian simultaneous-move game (sim/nash.js): I pick one strategy without knowing which
//      determinization is real, the opponent knows its own sets and best-responds.
// Each option's value is its win probability against the opponent's equilibrium replies. The gap to the
// best option is how much win probability choosing it costs.
//
// The work is split into jobs that run in sim/pool.js workers (runJob); analyzeTurnSync runs them inline.

const path = require('path');
const {Battle, PRNG} = require('pokemon-showdown');
const {playOut} = require('./battle');
const {setPrior, determinize} = require('./belief');
const {solveBayes} = require('./nash');
const {mulberry32, hash} = require('./util');

const DEFAULT_RESULTS = path.join(__dirname, '..', 'web', 'data', 'results.json');
const noop = () => {};

const priors = new Map();
function priorFor(resultsPath = DEFAULT_RESULTS) {
	if (!priors.has(resultsPath)) priors.set(resultsPath, setPrior(require(resultsPath)));
	return priors.get(resultsPath);
}

/** The choices open to `side` right now: [{choice, label}] (empty when it has nothing to decide). */
function legalChoices(side, {megaOptional = false} = {}) {
	const req = side.activeRequest;
	if (!req || req.wait || req.teamPreview) return [];
	const out = [];
	const bench = () => side.pokemon.forEach((p, i) => {
		if (!p.fainted && !p.isActive) out.push({choice: `switch ${i + 1}`, label: `Switch to ${p.species.name}`});
	});
	if (req.forceSwitch) {
		bench();
		return out;
	}
	const active = req.active[0];
	const mega = active.canMegaEvo;
	active.moves.forEach((m, i) => {
		if (m.disabled || (m.pp !== undefined && m.pp <= 0)) return;
		if (mega) out.push({choice: `move ${i + 1} mega`, label: `${m.move} + Mega`});
		if (!mega || megaOptional) out.push({choice: `move ${i + 1}`, label: m.move});
	});
	if (!out.length) out.push({choice: 'default', label: 'Struggle'});
	if (!active.trapped) bench();
	return out;
}

const pending = side => side.activeRequest && !side.activeRequest.wait && !side.isChoiceDone();

/**
 * One worker job: build determinization `dSeed` of the viewer's opponent, then for each of `rows`, play
 * every opponent option K times to the end. Returns {cols: [label], sums: rows x cols (viewer wins)}.
 */
function runJob(job) {
	const {state, log, viewer, rows, dSeed, K, policy, resultsPath, omniscient} = job;
	const real = Battle.fromJSON(state);
	real.log = log;
	// omniscient: analyse the real position, opponent's sets included (a diagnostic, not fair play)
	const d = omniscient ? real : determinize(real, viewer, priorFor(resultsPath), mulberry32(dSeed), state);
	if (!omniscient) real.destroy();
	const dState = d.toJSON();
	dState.log = [];
	const foe = d.sides[1 - viewer];
	const cols = pending(foe) ? legalChoices(foe) : [{choice: null, label: '(waits)'}];
	d.destroy();
	const agents = [policy, policy];
	const sums = rows.map(() => new Array(cols.length).fill(0));
	for (let k = 0; k < K; k++) {
		const dice = [dSeed & 0xffff, (dSeed >>> 16) & 0xffff, k & 0xffff, 0x51];
		rows.forEach((row, i) => cols.forEach((col, j) => {
			const c = Battle.fromJSON(dState);
			c.log = []; // fromJSON reuses state.log, so clones would share (and overflow) one array
			c.send = noop;
			c.prng = new PRNG(dice); // the same dice for every cell: paired comparisons
			const me = c.sides[viewer], them = c.sides[1 - viewer];
			if (!c.choose(me.id, row)) c.choose(me.id, 'default');
			if (col.choice !== null && pending(them) && !c.choose(them.id, col.choice)) c.choose(them.id, 'default');
			playOut(c, agents);
			const w = c.winner === me.name ? 1 : c.winner === them.name ? 0 : 0.5;
			sums[i][j] += w;
			c.destroy();
		}));
	}
	return {cols: cols.map(c => c.label), sums};
}

function makeJobs(battle, viewer, rows, {D = 8, K = 8, policy = 'heuristic', resultsPath = DEFAULT_RESULTS, salt = 0, omniscient = false} = {}) {
	const state = battle.toJSON();
	const log = state.log.slice();
	state.log = [];
	const base = hash(`${battle.turn}|${viewer}|${salt}|${log.length}`);
	const dSeeds = Array.from({length: D}, (_, d) => (base + d * 0x9e3779b1) >>> 0);
	const jobs = [];
	for (const dSeed of dSeeds) {
		for (const row of rows) jobs.push({type: 'turn', state, log, viewer, rows: [row.choice], dSeed, K, policy, resultsPath, omniscient});
	}
	return {jobs, D, K, rows};
}

/** Combine job results into the Bayesian game, solve it, and report every option. */
function summarize({jobs, D, K, rows}, results) {
	const m = rows.length;
	const As = [], colLabels = [];
	for (let d = 0; d < D; d++) {
		const part = results.slice(d * m, (d + 1) * m);
		if (part.some(r => !r || r.failed)) continue; // a failed job drops that determinization
		colLabels.push(part[0].cols);
		As.push(part.map(r => r.sums[0].map(s => s / K)));
	}
	if (!As.length) throw new Error('every analysis job failed');
	const eq = solveBayes(As);
	// per-determinization value of each row against that determinization's equilibrium reply
	const perD = As.map((A, d) => A.map(row => row.reduce((s, a, j) => s + a * eq.ys[d][j], 0)));
	const Dn = As.length;
	const best = eq.rowVals.indexOf(Math.max(...eq.rowVals));
	const sd = xs => {
		const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
		return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / Math.max(1, xs.length - 1));
	};
	const options = rows.map((r, i) => ({
		choice: r.choice, label: r.label,
		value: eq.rowVals[i],
		se: sd(perD.map(v => v[i])) / Math.sqrt(Dn),
		loss: eq.rowVals[best] - eq.rowVals[i],
		lossSe: i === best ? 0 : sd(perD.map(v => v[best] - v[i])) / Math.sqrt(Dn),
		mix: eq.x[i],
	}));
	// what the opponent tends to do, pooled over determinizations by label
	const reply = new Map();
	eq.ys.forEach((y, d) => y.forEach((p, j) => reply.set(colLabels[d][j], (reply.get(colLabels[d][j]) || 0) + p / Dn)));
	return {
		value: eq.value, gap: eq.gap, determinizations: Dn, droppedDeterminizations: D - Dn, rolloutsPerCell: K,
		options: options.sort((a, b) => b.value - a.value),
		replies: [...reply.entries()].map(([label, p]) => ({label, p})).filter(r => r.p > 0.01).sort((a, b) => b.p - a.p),
	};
}

/** Analyse `viewer`'s pending decision using the worker pool. */
async function analyzeTurn(pool, battle, viewer, opts = {}) {
	const rows = opts.rows || legalChoices(battle.sides[viewer], opts);
	if (!rows.length) return null;
	const plan = makeJobs(battle, viewer, rows, opts);
	const results = await pool.run(plan.jobs, 1);
	return summarize(plan, results);
}

/** Same, inline on this thread (for use as an agent inside a worker). */
function analyzeTurnSync(battle, viewer, opts = {}) {
	const rows = opts.rows || legalChoices(battle.sides[viewer], opts);
	if (!rows.length) return null;
	const plan = makeJobs(battle, viewer, rows, opts);
	return summarize(plan, plan.jobs.map(j => {
		try { return runJob(j); } catch (e) { if (process.env.DEBUG_ENGINE) console.error(e); return null; }
	}));
}

/**
 * Agent wrapper: play a strategy from the engine's equilibrium (sampled, so it isn't predictable).
 * Team preview still uses the heuristic; sim/draft.js solves that separately.
 */
function engineAgent(opts) {
	const H = require('./agent');
	return (battle, side) => {
		const req = side.activeRequest;
		if (!req || req.wait) return null;
		if (req.teamPreview) return H.decide(battle, side);
		const viewer = battle.sides.indexOf(side);
		const rows = legalChoices(side);
		if (rows.length === 1) return rows[0].choice;
		let res;
		try { res = analyzeTurnSync(battle, viewer, {...opts, rows}); } catch (e) { return H.decide(battle, side); }
		const rng = mulberry32(hash(`${battle.turn}|${viewer}|${battle.log.length}|${opts.salt || 0}`));
		let r = rng();
		for (const o of res.options) if ((r -= o.mix) <= 0) return o.choice;
		return res.options[0].choice;
	};
}

module.exports = {legalChoices, runJob, analyzeTurn, analyzeTurnSync, engineAgent, priorFor, DEFAULT_RESULTS};
