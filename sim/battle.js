'use strict';
// Runs one battle between two teams, each piloted by an agent.

const {Battle} = require('pokemon-showdown');
const {FORMAT_ID} = require('./format');
const {decide} = require('./agent');
const {decideLookahead} = require('./lookahead');

const AGENTS = {
	heuristic: decide,
	lookahead: (b, s) => decideLookahead(b, s, {rollout: 0}),
	rollout2: (b, s) => decideLookahead(b, s, {rollout: 2}),
	rollout4: (b, s) => decideLookahead(b, s, {rollout: 4}),
	rollout4wide: (b, s) => decideLookahead(b, s, {rollout: 4, mySwitches: 2, theirMoves: 3}),
	// v2 tactical rules (sim/agent.js tacticalValue). rollout4all also simulates every one of its moves, not
	// just the heuristic's top 3, so a move the heuristic underrates still gets judged by its outcome.
	heuristic2: (b, s) => decide(b, s, {v2: true}),
	rollout4v2: (b, s) => decideLookahead(b, s, {rollout: 4, v2: true}),
	rollout4all: (b, s) => decideLookahead(b, s, {rollout: 4, v2: true, myMoves: 4, theirMoves: 3}),
	// deeper and wider: 8 heuristic turns after each option and 2 switch options (setup and stall wars pay off late)
	rollout8all: (b, s) => decideLookahead(b, s, {rollout: 8, v2: true, myMoves: 4, theirMoves: 3, mySwitches: 2}),
	rollout16all: (b, s) => decideLookahead(b, s, {rollout: 16, v2: true, myMoves: 4, theirMoves: 4, mySwitches: 2}),
	// doubles (FORMAT=gen9championsvgc2026regmc; sim/dagent.js)
	dheuristic: (b, s) => require('./dagent').decideDoubles(b, s),
	dgreedy: (b, s) => require('./dagent').decideGreedy(b, s),
};
// Analysis-engine agents (sim/engine.js), named mc<determinizations>x<rollouts per cell>. Hidden-info aware.
// mcfull* see the opponent's sets (like the other AIs); a diagnostic for the cost of hidden information.
for (const [D, K] of [[2, 2], [4, 4], [8, 8]]) {
	let agent = null, full = null;
	AGENTS[`mc${D}x${K}`] = (b, s) => (agent ||= require('./engine').engineAgent({D, K}))(b, s);
	AGENTS[`mcfull${D}x${K}`] = (b, s) => (full ||= require('./engine').engineAgent({D, K, omniscient: true}))(b, s);
}

/**
 * Randomized team preview: each of the 20 possible trios is picked with probability proportional to
 * exp(score / temp), where a trio's score is the sum of its members' matchup scores against the six foes (the
 * heuristic's own preview score); the lead is the trio's best-scoring member. Every pilot otherwise picks the same
 * three against a given team, so a counter-team can be built against that one pick (2026-11-16: 12 of 28 team
 * pairs ended 90-100% one way). Seeded from the battle's seed: reproducible, and the same in every rerun.
 */
function stochasticPreview(battle, side, temp) {
	const {matchupScore} = require('./agent');
	const mine = side.pokemon, theirs = side.foe.pokemon;
	const score = mine.map(p => theirs.reduce((t, f) => t + matchupScore(battle, p, f), 0));
	const trios = [];
	for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) for (let k = j + 1; k < mine.length; k++) {
		trios.push({m: [i, j, k], s: score[i] + score[j] + score[k]});
	}
	const top = Math.max(...trios.map(t => t.s));
	const w = trios.map(t => Math.exp((t.s - top) / temp));
	const seed = String(battle.prngSeed) + side.id;
	let h = 2166136261;
	for (let c = 0; c < seed.length; c++) h = Math.imul(h ^ seed.charCodeAt(c), 16777619);
	let r = ((h >>> 0) / 4294967296) * w.reduce((a, b) => a + b, 0);
	let pick = trios[trios.length - 1];
	for (let t = 0; t < trios.length; t++) if ((r -= w[t]) <= 0) { pick = trios[t]; break; }
	const order = pick.m.slice().sort((a, b) => score[b] - score[a]);
	const rest = mine.map((_, i) => i).filter(i => !order.includes(i));
	return 'team ' + [...order, ...rest].map(i => i + 1).join('');
}

// The pipeline's 1v1 matrix (strong pilot, HP margin) from web/data/results.json, loaded once per worker.
let oneVsOne = null;
function loadOneVsOne() {
	if (oneVsOne !== null) return oneVsOne;
	try {
		const fs = require('fs'), path = require('path');
		const file = process.env.PREVIEW_RESULTS || path.join(__dirname, '..', 'web', 'data', 'results.json');
		const r = JSON.parse(fs.readFileSync(file, 'utf8'));
		const N = r.matchups.ids.length, K = r.meta.matchupBattlesPerPair || 8;
		const bin = Buffer.from(r.matchups.data, 'base64');
		const idx = new Map(r.matchups.ids.map((id, i) => [id, i]));
		const byKey = new Map(r.entries.map(e => [`${e.species}|${e.megaItem || ''}`, idx.get(e.id)]));
		oneVsOne = {N, K, bin, byKey};
	} catch (e) {
		oneVsOne = false;
	}
	return oneVsOne;
}

/**
 * Team preview from the 1v1 matrix: each trio scores the sum of its members' 1v1 results against the six foes, and is
 * picked with probability ~ exp(score / temp) (temp 0.05: almost always the best trio, but not predictably). On 30
 * ladder team pairs (sim/preview-bench.js, strong pilot, all 20 x 20 trio pairings) this gives up 4.2 ± 1.9 points
 * less win rate against the opponent's equilibrium pick than the matchup-score rule. Pokémon not in the roster
 * fall back to the matchup score.
 */
function oneVsOnePreview(battle, side, temp) {
	const {matchupScore} = require('./agent');
	const m = loadOneVsOne();
	const mine = side.pokemon, theirs = side.foe.pokemon;
	const key = p => `${p.set.species}|${/ite( [XYZ])?$/.test(p.set.item || '') && battle.dex.items.get(p.set.item).megaStone ? battle.dex.items.get(p.set.item).name : ''}`;
	const index = p => {
		if (!m) return undefined;
		const k = key(p);
		return m.byKey.has(k) ? m.byKey.get(k) : m.byKey.get(`${p.set.species}|`);
	};
	const im = mine.map(index), it = theirs.map(index);
	const v = (a, b, pa, pb) => (a === undefined || b === undefined)
		? Math.max(-0.5, Math.min(0.5, matchupScore(battle, pa, pb) / 4))
		: ((m.bin[a * m.N + b] / 255 * m.K + 1) / (m.K + 2)) - 0.5;
	const score = mine.map((p, i) => theirs.reduce((t, f, j) => t + v(im[i], it[j], p, f), 0));
	const trios = [];
	for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) for (let k = j + 1; k < mine.length; k++) {
		trios.push({m: [i, j, k], s: score[i] + score[j] + score[k]});
	}
	const top = Math.max(...trios.map(t => t.s));
	const w = trios.map(t => Math.exp((t.s - top) / temp));
	const seed = String(battle.prngSeed) + side.id + 'v';
	let h = 2166136261;
	for (let c = 0; c < seed.length; c++) h = Math.imul(h ^ seed.charCodeAt(c), 16777619);
	let r = ((h >>> 0) / 4294967296) * w.reduce((a, b) => a + b, 0);
	let pick = trios[trios.length - 1];
	for (let t = 0; t < trios.length; t++) if ((r -= w[t]) <= 0) { pick = trios[t]; break; }
	const order = pick.m.slice().sort((a, b) => score[b] - score[a]);
	const rest = mine.map((_, i) => i).filter(i => !order.includes(i));
	return 'team ' + [...order, ...rest].map(i => i + 1).join('');
}

// 'heuristic2!unaware,fakeout' is heuristic2 with those rule groups switched off (sim/agent.js), for ablations;
// 'rollout4all~v' picks at team preview from the 1v1 matrix (oneVsOnePreview, temp 0.05; '~v0.1' sets the temp);
// 'rollout4all~p1' is rollout4all with a randomized team preview at temperature 1 (stochasticPreview)
function resolveAgent(name) {
	if (AGENTS[name]) return AGENTS[name];
	const vm = /^(.+)~v([0-9.]*)$/.exec(String(name));
	if (vm) {
		const base = resolveAgent(vm[1]), temp = Number(vm[2] || 0.05);
		return AGENTS[name] = (b, s) => (s.activeRequest && s.activeRequest.teamPreview ? oneVsOnePreview(b, s, temp) : base(b, s));
	}
	const pm = /^(.+)~p([0-9.]+)$/.exec(String(name));
	if (pm) {
		const base = resolveAgent(pm[1]), temp = Number(pm[2]);
		return AGENTS[name] = (b, s) => (s.activeRequest && s.activeRequest.teamPreview ? stochasticPreview(b, s, temp) : base(b, s));
	}
	const m = /^heuristic2!(.+)$/.exec(String(name));
	if (m) {
		const off = new Set(m[1].split(','));
		return AGENTS[name] = (b, s) => decide(b, s, {v2: true, off});
	}
	return decide;
}

const MAX_TURNS = 150;

// Called on every decision step of every battle, including rollouts inside an AI's own analysis. The
// worker pool (sim/pool.js) uses it as a heartbeat, so slow AIs aren't mistaken for stalled workers.
let progress = () => {};
const setProgressHook = fn => { progress = fn; };

/**
 * @param {object[]} teamA PokemonSet[] (1-6 members; with 4+ the agent picks 3 at team preview)
 * @param {object[]} teamB
 * @param {number[]} seed four 16-bit ints
 * @param {string[]} agents agent name for each side: 'heuristic' (default) or 'lookahead'
 * @returns {{winner: 0|1|null, turns: number, picks: [string[], string[]]}}
 */
function runBattle(teamA, teamB, seed, agents = ['heuristic', 'heuristic']) {
	const battle = new Battle({formatid: FORMAT_ID, seed, send: () => {}});
	battle.setPlayer('p1', {name: 'A', team: teamA});
	battle.setPlayer('p2', {name: 'B', team: teamB});
	playOut(battle, agents);
	let winner = null;
	if (battle.winner === 'A') winner = 0;
	else if (battle.winner === 'B') winner = 1;
	// after team preview each side keeps only the Pokémon it brought; report their original team slots
	const picks = battle.sides.map((s, i) => s.pokemon.map(p => (i ? teamB : teamA).findIndex(t => t.species === p.set.species)));
	// fraction of total HP each side has left (of the Pokémon it brought)
	const hpLeft = battle.sides.map(s => {
		const max = s.pokemon.reduce((t, p) => t + p.maxhp, 0);
		return max ? s.pokemon.reduce((t, p) => t + (p.fainted ? 0 : p.hp), 0) / max : 0;
	});
	const out = {winner, turns: battle.turn, picks, hpLeft};
	battle.destroy();
	return out;
}

const choiceErrors = {count: 0, samples: []};

/** Play `battle` to the end (or the turn limit) with an agent on each side. */
function playOut(battle, agents = ['heuristic', 'heuristic'], maxTurns = MAX_TURNS) {
	const pilots = agents.map(resolveAgent);
	let guard = 0;
	while (!battle.ended && battle.turn <= maxTurns && guard++ < 2000) {
		progress();
		// Both sides decide before either submits, so neither can see the other's choice.
		const choices = battle.sides.map((side, i) => {
			if (!side.activeRequest || side.activeRequest.wait || side.isChoiceDone()) return null;
			return pilots[i](battle, side);
		});
		let acted = false;
		battle.sides.forEach((side, i) => {
			if (battle.ended || choices[i] === null) return;
			if (!battle.choose(side.id, choices[i])) {
				// a pilot bug, not a legal choice: count it (choiceErrors) and let the simulator pick
				choiceErrors.count++;
				if (choiceErrors.samples.length < 5) choiceErrors.samples.push(`${choices[i]} :: ${side.choice.error || ''}`);
				battle.choose(side.id, 'default');
			}
			acted = true;
		});
		if (!acted) break;
		// Showdown aborts a battle whose unsent log passes 1,000 lines ("Infinite loop"); nothing is sent here,
		// so mark it sent, or long stall games would crash instead of running to the turn limit.
		battle.sentLogPos = battle.log.length;
	}
	return battle;
}

module.exports = {runBattle, playOut, setProgressHook, AGENTS, resolveAgent, MAX_TURNS, choiceErrors};
