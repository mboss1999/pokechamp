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
};
// Analysis-engine agents (sim/engine.js), named mc<determinizations>x<rollouts per cell>. Hidden-info aware.
// mcfull* see the opponent's sets (like the other AIs); a diagnostic for the cost of hidden information.
for (const [D, K] of [[2, 2], [4, 4], [8, 8]]) {
	let agent = null, full = null;
	AGENTS[`mc${D}x${K}`] = (b, s) => (agent ||= require('./engine').engineAgent({D, K}))(b, s);
	AGENTS[`mcfull${D}x${K}`] = (b, s) => (full ||= require('./engine').engineAgent({D, K, omniscient: true}))(b, s);
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

/** Play `battle` to the end (or the turn limit) with an agent on each side. */
function playOut(battle, agents = ['heuristic', 'heuristic'], maxTurns = MAX_TURNS) {
	const pilots = agents.map(a => AGENTS[a] || decide);
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
			if (!battle.choose(side.id, choices[i])) battle.choose(side.id, 'default');
			acted = true;
		});
		if (!acted) break;
		// Showdown aborts a battle whose unsent log passes 1,000 lines ("Infinite loop"); nothing is sent here,
		// so mark it sent, or long stall games would crash instead of running to the turn limit.
		battle.sentLogPos = battle.log.length;
	}
	return battle;
}

module.exports = {runBattle, playOut, setProgressHook, AGENTS, MAX_TURNS};
