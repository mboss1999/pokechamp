'use strict';
// Team-specific tuning and validation. Given one team of six, re-tune each
// member's set *inside that team* against a gauntlet of strong meta teams
// (coordinate descent, paired comparisons on identical battles), then measure
// the original vs the tuned team on a fresh, larger gauntlet.

const S = require('./sets');
const {mulberry32, hash, seedFrom, clean, setKey, isFailed} = require('./util');
const {dex} = require('./format');

// Pilots (sim/battle.js AGENTS). The fast one plays the search (screen and confirm); it misjudges status moves,
// setup above all, so a change that adds or removes one must also win with the strong one, and the strong one
// plays the final validation (the before/after numbers the app shows). Same split as the set search
// (sim/setsearch.js) that produced web/data/results.json.
const FAST = process.env.TUNE_FAST_AGENT || 'heuristic2';
const STRONG = process.env.TUNE_STRONG_AGENT || 'rollout4all';
// what one strong-pilot battle costs in fast-pilot battles (Lambda spend caps count in fast battles)
const STRONG_COST = 25;

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];

/** results.json set description -> PokemonSet the simulator understands. */
function toPokemonSet(entry, desc) {
	const evs = Object.fromEntries(STAT_KEYS.map(k => [k, desc.statPoints[k] || 0]));
	return {
		name: entry.species, species: entry.species, item: desc.item || '', ability: desc.ability,
		nature: desc.nature, evs, ivs: Object.fromEntries(STAT_KEYS.map(k => [k, 31])), moves: desc.moves.slice(),
		level: 50, spread: 'custom', archetype: desc.archetype || 'custom',
	};
}

/** PokemonSet -> results.json style description (what the UI renders). */
function describe(set) {
	return {
		item: set.item, ability: set.ability, nature: set.nature, moves: set.moves,
		statPoints: Object.fromEntries(Object.entries(set.evs).filter(([, v]) => v > 0)),
	};
}

function rosterEntry(e) {
	return {id: e.id, species: e.species, megaItem: e.megaItem, battleSpecies: e.mega || e.species};
}

/** Meta gauntlet: opponent teams drawn from strong entries (weighted by rating), Item Clause respected. */
function makeGauntlet(results, rng, count) {
	const {entries} = results;
	const w = entries.map(e => Math.exp((e.rating - 1500) / 120));
	const total = w.reduce((a, b) => a + b, 0);
	const draw = () => {
		let r = rng() * total;
		for (let i = 0; i < entries.length; i++) if ((r -= w[i]) <= 0) return i;
		return entries.length - 1;
	};
	const teams = [];
	for (let t = 0; t < count; t++) {
		const species = new Set(), items = new Set(), members = [], sets = [];
		let guard = 0;
		while (members.length < 6 && guard++ < 500) {
			const i = draw(), e = entries[i];
			if (species.has(e.species)) continue;
			const options = [e.set, ...e.alts];
			const desc = options.find(s => !s.item || !items.has(s.item));
			if (!desc) continue;
			species.add(e.species); items.add(desc.item);
			members.push(i); sets.push(clean(toPokemonSet(e, desc)));
		}
		teams.push({members, sets});
	}
	return teams;
}

/**
 * Battle our team against every gauntlet team (each from both sides), returning per-game results.
 * Each game: {win: 0|0.5|1, ourPicks: number[], oppIndex, oppPicks: number[]}.
 */
async function playGauntlet(pool, team, gauntlet, seeds, priority = 0, token = null, agent = FAST) {
	const jobs = [];
	const meta = [];
	gauntlet.forEach((opp, g) => {
		for (let k = 0; k < seeds[g].length; k++) {
			const flip = k % 2 === 1;
			jobs.push({a: flip ? opp.sets : team, b: flip ? team : opp.sets, seed: seeds[g][k], picks: true, agents: [agent, agent]});
			meta.push({g, flip});
		}
	});
	// rollout battles take ~60x longer, so they go out in smaller chunks (Lambda invocations have a time limit)
	const res = await pool.run(jobs, agent.startsWith('rollout') ? 2 : 8, null, priority, token);
	return res.map((r, x) => {
		const {g, flip} = meta[x];
		const ours = flip ? 1 : 0;
		// a failed battle has no result: NaN, skipped by every statistic below (a drawn battle scores 0.5)
		if (isFailed(r)) return {win: NaN, failed: true, cancelled: !!r.cancelled, ourPicks: [], oppIndex: g, oppPicks: []};
		const win = r.w === null ? 0.5 : (r.w === ours ? 1 : 0);
		return {win, ourPicks: r.picks[ours] || [], oppIndex: g, oppPicks: r.picks[1 - ours] || []};
	});
}

const mean = xs => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
function pairedDiff(a, b) {
	const d = a.map((x, i) => x - b[i]).filter(Number.isFinite);
	const m = mean(d);
	const sd = Math.sqrt(mean(d.map(x => (x - m) ** 2)));
	return {diff: m, se: sd / Math.sqrt(d.length || 1)};
}

function seedsFor(rng, teams, perTeam) {
	return teams.map(() => Array.from({length: perTeam}, () => seedFrom(rng)));
}

const statusIds = s => s.moves.map(m => dex.moves.get(m)).filter(m => m.category === 'Status').map(m => m.id).sort().join();
/** Does going from set a to set b add or remove a status move? */
const touchesStatus = (a, b) => statusIds(a) !== statusIds(b);
/** Pairs of attacks doing the same job (same type, category, priority, pivoting): one is a dead slot. */
function redundantPairs(set) {
	const ms = set.moves.map(m => dex.moves.get(m));
	let n = 0;
	for (let i = 0; i < ms.length; i++) {
		for (let j = i + 1; j < ms.length; j++) {
			const a = ms[i], b = ms[j];
			if (a.category !== 'Status' && a.category === b.category && a.type === b.type && a.priority === b.priority &&
				!!a.selfSwitch === !!b.selfSwitch) n++;
		}
	}
	return n;
}

/** Describe what changed between two sets, for the UI. */
function changes(before, after) {
	const out = [];
	if (before.item !== after.item) out.push(`Item: ${before.item || 'none'} → ${after.item || 'none'}`);
	if (before.ability !== after.ability) out.push(`Ability: ${before.ability} → ${after.ability}`);
	if (before.nature !== after.nature || JSON.stringify(before.evs) !== JSON.stringify(after.evs)) {
		const sp = s => STAT_KEYS.filter(k => s.evs[k]).map(k => `${s.evs[k]} ${k}`).join('/');
		out.push(`Spread: ${before.nature} ${sp(before)} → ${after.nature} ${sp(after)}`);
	}
	const removed = before.moves.filter(m => !after.moves.includes(m));
	const added = after.moves.filter(m => !before.moves.includes(m));
	if (removed.length || added.length) out.push(`Moves: ${removed.join(', ')} → ${added.join(', ')}`);
	return out;
}

// Sample sizes (multiples of the base batches below) and the most rounds of coordinate descent; tuning stops
// early once a whole round changes nothing. rigorous is what the app uses (see README, "Tune & validate").
const BUDGETS = {
	quick: {scale: 0.5, rounds: 1},
	normal: {scale: 1, rounds: 1},
	thorough: {scale: 2.5, rounds: 2},
	rigorous: {scale: 10, rounds: 4}, // 5x left 1.7 ± 1.1 pp on the table vs 10x (sim/tune-study.js, 2026-11-14)
};

/**
 * @param pool      sim/pool Pool (or anything with the same run(jobs, chunk, onChunk, priority, token))
 * @param results   web/data/results.json contents
 * @param team      [{entryId, set}] where set is a results.json set description
 * @param opts      {budget: key of BUDGETS, scale/rounds (override the budget's), onProgress(fraction, message),
 *                   priority (pool priority of this team's battles), shouldStop() (true to abandon the run: it
 *                   then rejects with an error whose `aborted` is true), salt (different battles, for studies),
 *                   token ({cancelled}: set it to drop every battle of this run not yet started, then stop),
 *                   lookahead (members evaluated speculatively past the current one; default pool.speculate,
 *                   else 0: on a pool whose throughput is the limit, speculation only adds battles)}
 *
 * Members are tuned one after another (each sees the changes accepted before it), but their battles are played
 * speculatively in parallel: every remaining member is evaluated against the current team at once, and when one
 * accepts a change the evaluations after it are cancelled and redone. The result is identical to evaluating them
 * strictly one by one; it just needs far fewer round trips, which matters when battles run on Lambda.
 */
async function refineTeam(pool, results, team, opts = {}) {
	const progress = opts.onProgress || (() => {});
	const priority = opts.priority || 0;
	const runToken = opts.token || {cancelled: false};
	const checkStop = () => {
		if (runToken.cancelled || (opts.shouldStop && opts.shouldStop())) {
			throw Object.assign(new Error('Tuning abandoned'), {aborted: true});
		}
	};
	const budget = BUDGETS[opts.budget || 'normal'] || BUDGETS.normal;
	const scale = opts.scale || budget.scale;
	const rounds = opts.rounds || budget.rounds;
	// how many members past the one being decided to evaluate speculatively (0 = strictly one at a time)
	const lookahead = opts.lookahead ?? pool.speculate ?? 0;
	const byId = new Map(results.entries.map((e, i) => [e.id, i]));
	const members = team.map(t => {
		const idx = byId.get(t.entryId);
		if (idx === undefined) throw new Error(`Unknown entry ${t.entryId}`);
		const e = results.entries[idx];
		const set = toPokemonSet(e, t.set || e.set);
		set.key = setKey(set);
		return {idx, e, entry: rosterEntry(e), original: set, current: set};
	});
	if (members.length < 3) throw new Error('Need at least 3 Pokémon to battle');

	// Independent batches of battles against strong meta teams:
	//   screen   cheap first look at every candidate set (fast pilot)
	//   confirm  bigger, separate sample for the two best; a change is only accepted if it wins here (fast pilot)
	//   strong   a change that adds or removes a status move must also win here (strong pilot)
	//   validate fresh sample comparing the original and final teams: what we report (strong pilot)
	const rng = mulberry32(hash(members.map(m => m.e.id).join(',') + (opts.salt ? `#${opts.salt}` : '')));
	// opts.opponents(rng) -> PokemonSet[6]: tune against that field (e.g. sim/field.js, the real ladder) instead of
	// teams drawn from the simulated meta
	const entryOf = new Map(results.entries.map((e, i) => [`${e.species}|${e.megaItem || ''}`, i]));
	const fieldGauntlet = count => Array.from({length: count}, () => {
		const sets = opts.opponents(rng);
		return {sets, members: sets.map(st => entryOf.get(`${st.species}|${dex.items.get(st.item).megaStone ? st.item : ''}`) ??
			entryOf.get(`${st.species}|`) ?? -1)};
	});
	const batch = (teams, perTeam) => {
		const gauntlet = opts.opponents ? fieldGauntlet(Math.round(teams * scale)) : makeGauntlet(results, rng, Math.round(teams * scale));
		return {gauntlet, seeds: seedsFor(rng, gauntlet, perTeam), size: Math.round(teams * scale) * perTeam};
	};
	// strong: the strong pilot's check of a status change; validate is played by the strong pilot too
	const screen = batch(30, 6), confirm = batch(100, 6), strong = batch(25, 8), validate = batch(40, 8);
	const CANDIDATES = 7, FINALISTS = 2;

	// progress counts in fast-pilot battles (a strong battle is worth STRONG_COST); assumes one status check
	const perRound = members.length * (CANDIDATES * screen.size + FINALISTS * confirm.size);
	const totalBattles = screen.size + confirm.size + Math.min(rounds, 2) * perRound + STRONG_COST * (2 * strong.size + 2 * validate.size);
	let done = 0;
	const tick = (n, msg) => { done += n; progress(Math.min(0.99, done / totalBattles), msg); checkStop(); };
	let played = 0, strongPlayed = 0; // battles actually played, including speculative ones that were thrown away
	// a battle is skipped if the whole run is cancelled or (for speculative work) its own evaluation is
	const tokenFor = t => (t ? {get cancelled() { return runToken.cancelled || t.cancelled; }} : runToken);
	// lane: a speculative evaluation's distance from the member being decided; nearer ones get the cores first, so
	// little work is thrown away when an earlier member accepts a change
	const play = (team, b, token = null, lane = 0, agent = FAST) =>
		playGauntlet(pool, team, b.gauntlet, b.seeds, priority - lane * 1e-4, tokenFor(token), agent)
		.then(games => {
			const n = games.filter(g => !g.cancelled).length;
			if (agent === FAST) played += n; else strongPlayed += n;
			return games;
		});
	const wins = games => games.map(g => g.win);
	const sets = () => members.map(m => m.current);
	const teamOf = (snapshot, mi, set) => snapshot.map((o, j) => clean(j === mi ? set : o));

	progress(0, 'Measuring your team as built…');
	// the original team's validation never depends on the tuning, so it plays alongside everything else
	const beforeP = play(members.map(m => clean(m.original)), validate, null, 0, STRONG);
	let [baseScreen, baseConfirm] = await Promise.all([
		play(teamOf(sets(), -1), screen).then(wins),
		play(teamOf(sets(), -1), confirm).then(wins),
	]);
	tick(screen.size + confirm.size, 'Baseline measured');

	// the strong pilot's results for a team as it stands, shared by every status check made against it
	const strongBases = new Map();
	const strongBase = (snapshot, token, lane) => {
		const key = snapshot.map(s => s.key).join('|');
		let p = strongBases.get(key);
		if (!p) {
			p = play(teamOf(snapshot, -1), strong, token, lane, STRONG).then(wins);
			// a cancelled evaluation's battles are missing: don't let another check reuse them
			p.then(w => { if (w.some(x => Number.isNaN(x))) strongBases.delete(key); });
			strongBases.set(key, p);
		}
		return p;
	};

	/** Screen member mi's candidates on a snapshot of the team, then confirm the best two. Returns the change to accept, or null. */
	async function evaluate(mi, cands, snapshot, bScreen, bConfirm, token, lane) {
		const screened = await Promise.all(cands.map(c => play(teamOf(snapshot, mi, c), screen, token, lane).then(wins)));
		if (token.cancelled) return null;
		const finalists = cands.map((c, i) => ({c, res: screened[i], d: pairedDiff(screened[i], bScreen).diff}))
			.filter(f => f.d > 0).sort((a, b) => b.d - a.d).slice(0, FINALISTS);
		const confirmed = await Promise.all(finalists.map(f => play(teamOf(snapshot, mi, f.c), confirm, token, lane).then(wins)));
		if (token.cancelled) return null;
		// one-sided 95%: only accept changes that hold up on battles they weren't selected on
		const passed = [];
		finalists.forEach((f, i) => {
			const stat = pairedDiff(confirmed[i], bConfirm);
			if (stat.diff > 1.645 * stat.se) passed.push({f, conf: confirmed[i], stat});
		});
		passed.sort((a, b) => b.stat.diff - a.stat.diff);
		// The fast pilot misjudges status moves, so a change adding or removing one must also win with the strong
		// pilot (same one-sided test). If the best fails, the runner-up may still pass.
		for (const best of passed) {
			if (!touchesStatus(snapshot[mi], best.f.c)) return best;
			const [cur, next] = await Promise.all([
				strongBase(snapshot, token, lane),
				play(teamOf(snapshot, mi, best.f.c), strong, token, lane, STRONG).then(wins),
			]);
			if (token.cancelled) return null;
			const stat = pairedDiff(next, cur);
			if (stat.diff > 1.645 * stat.se) return {...best, strongCheck: stat};
		}
		return null;
	}

	for (let round = 0; round < rounds; round++) {
		// Neighbour sets come from the shared rng; draw them in member order, exactly as a one-by-one pass would.
		const nbrs = members.map(m => S.neighbours(m.entry, m.current, rng).map(s => { s.key = setKey(s); return s; }));
		const candidates = (mi, snapshot) => {
			const m = members[mi];
			const otherItems = new Set(snapshot.filter((_, j) => j !== mi).map(o => o.item).filter(Boolean));
			const precomputed = [m.e.set, ...m.e.alts].map(d => {
				const s = toPokemonSet(m.e, d); s.key = setKey(s); return s;
			});
			const seen = new Set([m.current.key]);
			const cands = [];
			const dead = redundantPairs(m.current);
			for (const s of [...precomputed, ...nbrs[mi]]) {
				if (seen.has(s.key) || (s.item && otherItems.has(s.item))) continue;
				// never add a second attack doing the same job as one already there (Dragon Darts + Dragon Claw)
				if (redundantPairs(s) > dead) continue;
				seen.add(s.key);
				cands.push(s);
				if (cands.length >= CANDIDATES) break;
			}
			return cands;
		};
		let changed = false;
		let next = 0;
		while (next < members.length) {
			// speculate: evaluate the next `lookahead` members too, against the team as it stands now
			const snapshot = sets(), token = {cancelled: false};
			const evals = [];
			const launch = mi => {
				if (mi < members.length && !evals[mi]) {
					evals[mi] = evaluate(mi, candidates(mi, snapshot), snapshot, baseScreen, baseConfirm, token, mi - next);
				}
			};
			for (let mi = next; mi <= next + lookahead; mi++) launch(mi);
			let accepted = -1;
			for (let mi = next; mi < members.length; mi++) {
				launch(mi);
				const best = await evals[mi];
				const m = members[mi];
				tick(perRound / members.length, `Tuning ${m.e.mega || m.e.species}${rounds > 1 ? ` (round ${round + 1})` : ''}`);
				if (!best) launch(mi + lookahead + 1); // still valid: nothing before it changed
				if (best) {
					m.current = best.f.c;
					baseScreen = best.f.res;
					baseConfirm = best.conf;
					changed = true;
					accepted = mi;
					break;
				}
			}
			if (accepted < 0) break;
			// later members were judged next to the old set: drop that work and redo them next to the new one
			token.cancelled = true;
			next = accepted + 1;
		}
		if (!changed) break;
	}

	progress(Math.min(0.99, done / totalBattles), 'Validating original vs tuned team on fresh battles…');
	const anyChange = members.some(m => m.current !== m.original);
	const [before, after] = await Promise.all([beforeP, anyChange ? play(teamOf(sets(), -1), validate, null, 0, STRONG) : beforeP]);
	done = Math.max(done, totalBattles - STRONG_COST * 2 * validate.size);
	tick(STRONG_COST * 2 * validate.size, 'Validated');

	const diff = pairedDiff(wins(after), wins(before));
	// Never hand back a team that validates worse than what you started with.
	const kept = anyChange && diff.diff <= 0;
	// what was tried and turned down, so a reverted tuning can still be inspected
	const rejected = kept ? {diff: +diff.diff.toFixed(4), se: +diff.se.toFixed(4),
		changes: members.map(m => ({entryId: m.e.id, changes: changes(m.original, m.current)})).filter(x => x.changes.length)} : null;
	if (kept) for (const m of members) m.current = m.original;
	const final = (kept ? before : after).filter(g => !g.failed);

	const summarize = games => {
		const w = wins(games).filter(Number.isFinite);
		const p = mean(w);
		return {winRate: +p.toFixed(4), games: w.length, ci95: +(1.96 * Math.sqrt(p * (1 - p) / w.length)).toFixed(4)};
	};
	// Who we bring and lead with, and which meta Pokémon beat us most when the opponent brought them.
	const bringRate = members.map((_, i) => final.filter(g => g.ourPicks.includes(i)).length / final.length);
	const leadRate = members.map((_, i) => final.filter(g => g.ourPicks[0] === i).length / final.length);
	const vs = new Map();
	for (const g of final) {
		const opp = validate.gauntlet[g.oppIndex];
		for (const k of g.oppPicks) {
			const idx = opp.members[k];
			if (idx === undefined || idx < 0) continue;
			const s = vs.get(idx) || {games: 0, wins: 0};
			s.games++; s.wins += g.win;
			vs.set(idx, s);
		}
	}
	const minGames = Math.max(30, Math.round(validate.size / 30));
	const threats = [...vs.entries()].filter(([, s]) => s.games >= minGames)
		.map(([idx, s]) => ({entryId: results.entries[idx].id, games: s.games, winRate: +(s.wins / s.games).toFixed(3)}))
		.sort((a, b) => a.winRate - b.winRate);

	progress(1, 'Done');
	return {
		before: summarize(before),
		after: summarize(final),
		improvement: {diff: kept ? 0 : +diff.diff.toFixed(4), se: +diff.se.toFixed(4)},
		revertedTuning: kept,
		rejectedTuning: rejected,
		members: members.map((m, i) => ({
			entryId: m.e.id,
			original: describe(m.original),
			refined: describe(m.current),
			changes: changes(m.original, m.current),
			bringRate: +bringRate[i].toFixed(3),
			leadRate: +leadRate[i].toFixed(3),
		})),
		threats: threats.slice(0, 8),
		battles: played,
		strongBattles: strongPlayed,
		// in fast-pilot battles, for spend caps
		cost: played + STRONG_COST * strongPlayed,
		agents: {search: FAST, strong: STRONG},
	};
}

module.exports = {refineTeam, toPokemonSet, BUDGETS, makeGauntlet, playGauntlet, seedsFor, pairedDiff, FAST, STRONG, STRONG_COST};
