'use strict';
// One-turn lookahead agent. For each move decision it takes its few most promising
// options and the opponent's likely replies, plays every pairing forward one turn
// on a copy of the battle, scores the resulting positions, and picks the option
// with the best expected score. Team preview and forced switches reuse the
// heuristic agent.

const {Battle, PRNG} = require('pokemon-showdown');
const H = require('./agent');

const noop = () => {};
const STATUS_PENALTY = {brn: 0.12, psn: 0.08, tox: 0.15, par: 0.12, slp: 0.2, frz: 0.25};

function sideScore(battle, side) {
	let s = 0;
	for (const p of side.pokemon) {
		if (p.fainted || !p.hp) continue;
		s += 0.5 + 0.5 * p.hp / p.maxhp;
		if (p.status) s -= STATUS_PENALTY[p.status] || 0.1;
	}
	const active = side.active[0];
	if (active && !active.fainted) {
		for (const stat of ['atk', 'spa', 'spe', 'def', 'spd']) {
			s += 0.06 * Math.max(-3, Math.min(3, active.boosts[stat]));
		}
	}
	const sc = side.sideConditions;
	if (sc.stealthrock) s -= 0.08;
	if (sc.spikes) s -= 0.05 * sc.spikes.layers;
	if (sc.toxicspikes) s -= 0.04;
	if (sc.reflect || sc.lightscreen || sc.auroraveil) s += 0.08;
	return s;
}

/** Position value from `side`'s point of view. */
function evaluate(battle, side) {
	if (battle.ended) return battle.winner === side.name ? 100 : (battle.winner ? -100 : 0);
	let v = sideScore(battle, side) - sideScore(battle, side.foe);
	const me = side.active[0], foe = side.foe.active[0];
	if (me && foe && !me.fainted && !foe.fainted && me.hp && foe.hp) {
		v += 0.25 * H.matchupScore(battle, me, foe);
	}
	return v;
}

/** Moves (best first by the heuristic's own valuation) plus the best switch-ins. */
function candidateChoices(battle, side, maxMoves, maxSwitches, v2 = false) {
	const req = side.activeRequest;
	const active = req.active[0];
	const me = side.active[0], foe = side.foe.active[0];
	const mega = active.canMegaEvo ? ' mega' : '';
	const threat = H.bestDamage(battle, foe, me);
	const ctx = {
		iAmFaster: H.outspeeds(battle, me, foe), threatFrac: threat.frac,
		benchCount: side.pokemon.filter(p => !p.fainted && !p.isActive).length,
		v2,
	};
	const moves = [];
	active.moves.forEach((m, i) => {
		if (m.disabled || (m.pp !== undefined && m.pp <= 0)) return;
		moves.push({choice: `move ${i + 1}${mega}`, v: H.moveValue(battle, me, foe, m.id, ctx)});
	});
	moves.sort((a, b) => b.v - a.v);
	const out = moves.slice(0, maxMoves).map(m => m.choice);
	if (!active.trapped && !active.maybeTrapped && maxSwitches) {
		const bench = side.pokemon.map((p, i) => ({p, i}))
			.filter(({p}) => !p.fainted && !p.isActive)
			.map(({p, i}) => ({choice: `switch ${i + 1}`, v: H.matchupScore(battle, p, foe) + 0.3 * p.hp / p.maxhp}))
			.sort((a, b) => b.v - a.v);
		for (const b of bench.slice(0, maxSwitches)) out.push(b.choice);
	}
	return out;
}

/**
 * Play `mine` vs `theirs` for one turn on a copy of the battle, then optionally `rollout` more turns with
 * the heuristic piloting both sides, and score the position for our side. `salt` and `k` pick the dice:
 * each (decision, option, reply) gets its own, so skipping a simulation never changes another's dice.
 */
function simulate(state, sideIdx, mine, theirs, salt, rollout, k, hopts = {}) {
	const clone = Battle.fromJSON(state);
	// fromJSON reuses state.log: without a fresh array every simulation of this decision appends to one
	// shared log, which passes Showdown's 1,000-line limit and makes later candidates throw (and be skipped)
	clone.log = [];
	clone.send = noop;
	// Fresh dice, so the agent can't see the real battle's upcoming rolls. "Expected" dice: likely
	// events (a 90% move hitting) happen, unlikely ones (crits, 30% burns) don't, and damage rolls average.
	clone.prng = new PRNG([salt & 0xffff, (salt >>> 16) & 0xffff, k & 0xffff, 0x2a]);
	clone.randomChance = (numerator, denominator) => numerator / denominator >= 0.5;
	clone.randomizer = d => Math.floor(d * 0.925);
	const me = clone.sides[sideIdx], foe = clone.sides[1 - sideIdx];
	if (!clone.choose(me.id, mine)) return null;
	if (!clone.choose(foe.id, theirs)) clone.choose(foe.id, 'default');
	const stopTurn = clone.turn + rollout;
	let guard = 0;
	while (rollout && !clone.ended && clone.turn < stopTurn && guard++ < 20) {
		const choices = clone.sides.map(s =>
			(!s.activeRequest || s.activeRequest.wait || s.isChoiceDone()) ? null : H.decide(clone, s, hopts));
		clone.sides.forEach((s, i) => {
			if (clone.ended || choices[i] === null) return;
			if (!clone.choose(s.id, choices[i])) clone.choose(s.id, 'default');
		});
	}
	const v = evaluate(clone, me);
	clone.destroy();
	return v;
}

function decideLookahead(battle, side, opts = {}) {
	// the shared damage memo (sim/agent.js) is worth its memory only while simulating this decision's battle copies
	const wasActive = H.sharedMemo.active;
	H.sharedMemo.active = true;
	try {
		return decideLookaheadInner(battle, side, opts);
	} finally {
		H.sharedMemo.active = wasActive;
	}
}

function decideLookaheadInner(battle, side, opts) {
	const req = side.activeRequest;
	const hopts = {v2: !!opts.v2};
	if (!req || req.wait || req.teamPreview || req.forceSwitch) return H.decide(battle, side, hopts);
	const foeReq = side.foe.activeRequest;
	// the opponent must also be choosing a move this turn for the lookahead to mean anything
	if (!foeReq || foeReq.wait || foeReq.forceSwitch || !foeReq.active) return H.decide(battle, side, hopts);

	// H.decide counts switches on the active Pokémon; asking it hypothetically must not change that.
	const actives = [side.active[0], side.foe.active[0]];
	const counts = actives.map(p => p.switchCount);
	const heuristicMine = H.decide(battle, side, hopts);
	// Opponent model: its heuristic choice is most likely, its other top moves less so.
	const heuristicTheirs = H.decide(battle, side.foe, hopts);
	actives.forEach((p, i) => { p.switchCount = counts[i]; });
	const mine = [...new Set([heuristicMine, ...candidateChoices(battle, side, opts.myMoves ?? 3, opts.mySwitches ?? 1, hopts.v2)])];
	const theirAlts = candidateChoices(battle, side.foe, opts.theirMoves ?? 2, 0, hopts.v2).filter(c => c !== heuristicTheirs);
	const theirs = [{choice: heuristicTheirs, w: 0.6}, ...theirAlts.map(c => ({choice: c, w: 0.4 / theirAlts.length}))];
	if (!theirAlts.length) theirs[0].w = 1;

	const state = battle.toJSON();
	state.log = [];
	const sideIdx = battle.sides.indexOf(side);
	const salt = (battle.turn * 7919) ^ (sideIdx * 104729);
	let best = heuristicMine, bestV = -Infinity;
	const values = opts.onDecision ? [] : null;
	if (mine.length === 1) {
		if (opts.onDecision) opts.onDecision({battle, side, heuristicMine, heuristicTheirs, mine, theirs, values, best});
		return best; // nothing to compare
	}
	for (const [mi, m] of mine.entries()) {
		// The heuristic's choice is tried first. If it wins against every reply (100, plus its 0.02
		// tie-break), no other option can score higher, so the rest needn't be simulated.
		if (mi > 0 && bestV >= 100.02 && best === heuristicMine && opts.earlyExit !== false) break;
		let total = 0, weight = 0;
		for (const [oi, o] of theirs.entries()) {
			let v = null;
			try {
				v = simulate(state, sideIdx, m, o.choice, salt, opts.rollout ?? 0, mi * 16 + oi, hopts);
			} catch (e) {
				v = null;
			}
			if (v === null) continue;
			total += o.w * v; weight += o.w;
		}
		if (!weight) continue;
		const value = total / weight + (m === heuristicMine ? 0.02 : 0); // tie-break toward the heuristic
		if (values) values.push({choice: m, value});
		if (value > bestV) { bestV = value; best = m; }
	}
	if (opts.onDecision) opts.onDecision({battle, side, heuristicMine, heuristicTheirs, mine, theirs, values, best});
	// keep the heuristic's switch-loop guard working when we pick a switch
	if (best.startsWith('switch') && best !== heuristicMine) actives[0].switchCount = (actives[0].switchCount || 0) + 1;
	return best;
}

module.exports = {decideLookahead, evaluate};
