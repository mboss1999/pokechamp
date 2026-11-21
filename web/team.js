// Team search over precomputed simulation results. Pure functions, usable from
// the browser (ES module) and from Node for testing.

/**
 * Decode the base64 uint8 matchup matrix into win probabilities. M[i*N+j] = P(i beats j) in a 1v1.
 * Rates are shrunk toward 50% (one virtual win and one virtual loss) so tiny samples don't read as certainties.
 */
export function decodeMatchups(matchups, battlesPerPair = 8) {
	const bin = typeof atob === 'function' ? atob(matchups.data) : Buffer.from(matchups.data, 'base64').toString('binary');
	const N = matchups.ids.length;
	const K = battlesPerPair; // total battles per pair, half from each side
	const M = new Float32Array(N * N);
	for (let x = 0; x < N * N; x++) M[x] = (bin.charCodeAt(x) / 255 * K + 1) / (K + 2);
	return {N, M, index: new Map(matchups.ids.map((id, i) => [id, i]))};
}

/** Threat weights: stronger entries matter more, so teams must answer the meta first. */
export function threatWeights(entries, temperature = 120) {
	const w = entries.map(e => Math.exp((e.rating - 1500) / temperature));
	const sum = w.reduce((a, b) => a + b, 0);
	return w.map(x => x / sum);
}

// You bring 3 of your 6 (4 in doubles), and a threat is rarely beaten by one perfect counter, so a team's answer to
// a threat is a weighted blend of its best matchups against it, one per Pokémon you bring (1v1 in singles; 2v2
// with a meta partner on each side in doubles). Only one Pokémon per side can Mega Evolve in a battle, and the
// matchup rates assume a Stone holder always does, so at most one of those answers may be a Mega.
const ANSWER_WEIGHTS = {3: [0.5, 0.3, 0.2], 4: [0.4, 0.3, 0.2, 0.1]};

export function makeScorer(results, opts = {}) {
	const {entries} = results;
	const {N, M, index} = decodeMatchups(results.matchups, results.meta.matchupBattlesPerPair);
	const W = threatWeights(entries, opts.temperature);
	const strength = entries.map(e => (e.rating - 1500) / 100);
	const RATING_WEIGHT = opts.ratingWeight ?? 0.06;
	const AW = ANSWER_WEIGHTS[results.meta.pickSize] || ANSWER_WEIGHTS[3];
	const K = AW.length;

	const isMega = entries.map(e => !!e.megaItem);

	// the best four non-Mega answers, then the best Mega takes a slot only if it beats the K-th (weights past K
	// are 0). score() inlines the same ranking for speed.
	const [w0, w1, w2, w3 = 0] = AW;
	let t0 = 0, t1 = 0, t2 = 0, t3 = 0;
	function rankAnswers(members, t) {
		t0 = t1 = t2 = t3 = 0;
		let mega = 0;
		for (const m of members) {
			const p = M[m * N + t];
			if (isMega[m]) { if (p > mega) mega = p; continue; }
			if (p > t0) { t3 = t2; t2 = t1; t1 = t0; t0 = p; } else if (p > t1) { t3 = t2; t2 = t1; t1 = p; } else if (p > t2) { t3 = t2; t2 = p; } else if (p > t3) t3 = p;
		}
		const p = mega;
		if (p > t0) { t3 = t2; t2 = t1; t1 = t0; t0 = p; } else if (p > t1) { t3 = t2; t2 = t1; t1 = p; } else if (p > t2) { t3 = t2; t2 = p; } else if (p > t3) t3 = p;
	}
	/** The K best answers to threat t (K = Pokémon brought), at most one of them a Mega; best first. */
	const topAnswers = (members, t) => { rankAnswers(members, t); return [t0, t1, t2, t3].slice(0, K); };
	const blend = answers => answers.reduce((s, p, k) => s + AW[k] * p, 0);

	/** Higher is better. Members are indices into `entries`. */
	function score(members) {
		let cover = 0;
		const L = members.length;
		for (let t = 0; t < N; t++) {
			// same as answerBlend(members, t), inlined with locals: this loop is the team search's hot path
			let a0 = 0, a1 = 0, a2 = 0, a3 = 0, mega = 0;
			for (let x = 0; x < L; x++) {
				const m = members[x], p = M[m * N + t];
				if (isMega[m]) { if (p > mega) mega = p; continue; }
				if (p > a0) { a3 = a2; a2 = a1; a1 = a0; a0 = p; } else if (p > a1) { a3 = a2; a2 = a1; a1 = p; } else if (p > a2) { a3 = a2; a2 = p; } else if (p > a3) a3 = p;
			}
			const p = mega;
			if (p > a0) { a3 = a2; a2 = a1; a1 = a0; a0 = p; } else if (p > a1) { a3 = a2; a2 = a1; a1 = p; } else if (p > a2) { a3 = a2; a2 = p; } else if (p > a3) a3 = p;
			cover += W[t] * (w0 * a0 + w1 * a1 + w2 * a2 + w3 * a3);
		}
		let s = 0;
		for (const m of members) s += strength[m];
		return cover + RATING_WEIGHT * s / 6;
	}

	/** Threat-weighted: blended answer strength, and share of the meta with two solid answers (win keeping 20%+ HP). */
	function summary(members) {
		let answer = 0, covered = 0;
		for (let t = 0; t < N; t++) {
			const top = topAnswers(members, t);
			answer += W[t] * blend(top);
			if (top[1] >= 0.6) covered += W[t];
		}
		return {answer, covered};
	}

	/** Per-threat breakdown for display. */
	function coverage(members, top = 25) {
		const order = entries.map((e, i) => i).sort((a, b) => W[b] - W[a]).slice(0, top);
		return order.map(t => {
			const answers = members.map(m => ({m, p: M[m * N + t]})).sort((a, b) => b.p - a.p);
			const best = answers[0];
			// one Mega per battle: if the best answer is a Mega, the second must not be
			const second = answers.slice(1).find(x => !(best && isMega[best.m] && isMega[x.m]));
			return {threat: t, weight: W[t], best, second};
		});
	}

	return {score, summary, coverage, M, N, index, W};
}

function rngFrom(seed) {
	let a = seed >>> 0;
	return () => {
		a = a + 0x6D2B79F5 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

/**
 * Find the best teams buildable from the owned species.
 * @param results   results.json
 * @param owned     Set of species names the player owns
 * @param opts      {teams, restarts, includeMegas, maxMegas (optional cap; the scorer already allows one Mega per battle)}
 * @returns [{members: entryIndex[], score}]
 */
export function buildTeams(results, owned, opts = {}) {
	const {entries} = results;
	const scorer = opts.scorer || makeScorer(results, opts);
	const maxMegas = opts.maxMegas ?? Infinity;
	const size = 6;
	const pool = entries.map((e, i) => i).filter(i => owned.has(entries[i].species) &&
		(opts.includeMegas !== false || !entries[i].megaItem));
	if (!pool.length) return [];

	const valid = members => {
		const species = new Set();
		let megas = 0;
		for (const m of members) {
			if (species.has(entries[m].species)) return false;
			species.add(entries[m].species);
			if (entries[m].megaItem) megas++;
		}
		return megas <= maxMegas;
	};
	const teamSize = Math.min(size, new Set(pool.map(i => entries[i].species)).size);

	function greedy(start, banned = new Set()) {
		const team = start.slice();
		while (team.length < teamSize) {
			let best = -1, bestS = -Infinity;
			for (const c of pool) {
				if (team.includes(c) || banned.has(entries[c].species)) continue;
				const t = [...team, c];
				if (!valid(t)) continue;
				const s = scorer.score(t);
				if (s > bestS) { bestS = s; best = c; }
			}
			if (best < 0) break;
			team.push(best);
		}
		return team;
	}

	function improve(team, banned = new Set()) {
		let cur = scorer.score(team);
		let improved = true;
		while (improved) {
			improved = false;
			for (let slot = 0; slot < team.length; slot++) {
				for (const c of pool) {
					if (team.includes(c) || banned.has(entries[c].species)) continue;
					const t = team.slice();
					t[slot] = c;
					if (!valid(t)) continue;
					const s = scorer.score(t);
					if (s > cur + 1e-9) { cur = s; team.splice(0, team.length, ...t); improved = true; }
				}
			}
		}
		return {members: team, score: cur};
	}

	const rng = rngFrom(opts.seed ?? 1);
	const found = [];
	const restarts = opts.restarts ?? 12;
	for (let r = 0; r < restarts; r++) {
		// first restart is pure greedy; later ones seed with a random owned Pokémon to explore other cores
		const start = r === 0 ? [] : [pool[Math.floor(rng() * pool.length)]];
		found.push(improve(greedy(start)));
	}
	// Also explore "team built around X" for the strongest owned entries, which gives variety.
	const strongest = pool.slice().sort((a, b) => entries[b].rating - entries[a].rating).slice(0, 8);
	for (const s of strongest) found.push(improve(greedy([s])));
	found.sort((a, b) => b.score - a.score);
	// Alternatives: the best team you can make without each member of the current best team.
	for (const m of found[0].members.slice()) {
		const banned = new Set([entries[m].species]);
		found.push(improve(greedy([], banned), banned));
	}

	found.sort((a, b) => b.score - a.score);
	const out = [];
	const want = opts.teams ?? 5;
	// Prefer teams that differ from every kept team by at least two species; relax to one if that runs dry.
	for (const minDiff of [2, 1]) {
		for (const t of found) {
			if (out.length >= want) break;
			const key = new Set(t.members.map(m => entries[m].species));
			if (out.some(o => o.members.filter(m => key.has(entries[m].species)).length > teamSize - minDiff)) continue;
			out.push({...t, members: t.members.slice().sort((a, b) => entries[b].rating - entries[a].rating)});
		}
	}
	return out;
}

/**
 * Builder teams plus the measured teams (the Strongest teams tab's ladder teams, strategies.json) that the owned
 * species can build. Those were scored in full battles, so they go first, as {members, proven: {...team, members:
 * [{...member, index}]}}; a builder team with the same six species is dropped.
 */
export function withProvenTeams(results, ladderTeams, owned, teams, opts = {}) {
	const {entries} = results;
	const index = new Map(entries.map((e, i) => [e.id, i]));
	const proven = [];
	for (const t of ladderTeams || []) {
		const members = t.members.map(m => ({...m, index: index.get(m.entryId)}));
		if (members.some(m => m.index === undefined)) continue;
		if (members.some(m => !owned.has(entries[m.index].species) || (opts.includeMegas === false && entries[m.index].megaItem))) continue;
		proven.push({members: members.map(m => m.index), proven: {...t, members}});
	}
	const key = t => t.members.map(m => entries[m].species).sort().join('|');
	const seen = new Set(proven.map(key));
	return [...proven, ...teams.filter(t => !seen.has(key(t)))];
}

/** Choose a set for each member so no two share an item (Item Clause). */
export function assignSets(results, members) {
	const {entries} = results;
	// Exhaustive search (at most 4^6 combos): maximise total simulated set win rate with distinct items.
	const options = members.map(m => {
		const e = entries[m];
		return [{set: e.set, wr: e.setWinRate}, ...e.alts.map(a => ({set: a, wr: a.winRate}))];
	});
	let best = null, bestScore = -Infinity;
	const pick = new Array(members.length);
	const used = new Set();
	(function search(k, total) {
		if (k === members.length) {
			if (total > bestScore) { bestScore = total; best = pick.slice(); }
			return;
		}
		for (const o of options[k]) {
			if (o.set.item && used.has(o.set.item)) continue;
			used.add(o.set.item);
			pick[k] = o;
			search(k + 1, total + o.wr);
			used.delete(o.set.item);
		}
	})(0, 0);
	// if no clause-legal combination exists, fall back to everyone's best set
	best = best || options.map(o => o[0]);
	return members.map((m, k) => ({entry: entries[m], set: best[k].set, isAlt: best[k].set !== entries[m].set}));
}

const STAT_NAMES = {hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};

/** Showdown import/export text. Champions stat points go in the EVs line. */
export function showdownText(entry, set) {
	const name = entry.species;
	const lines = [`${name}${set.item ? ' @ ' + set.item : ''}`, `Ability: ${set.ability}`, 'Level: 50'];
	const sp = Object.entries(set.statPoints).map(([k, v]) => `${v} ${STAT_NAMES[k]}`).join(' / ');
	if (sp) lines.push(`EVs: ${sp}`);
	lines.push(`${set.nature} Nature`);
	for (const m of set.moves) lines.push(`- ${m}`);
	return lines.join('\n');
}
