'use strict';
// Offline simulation pipeline. Stages (each checkpointed to --out):
//   sets      find the best set(s) for every roster entry (successive halving + hill climbing)
//   matchups  1v1 win-rate matrix between every pair of entries' best sets (doubles: 2v2, each with a meta
//             partner, partners swapped between the two battles of a pair so partner luck cancels)
//   ladder    random bring-6-pick-3 team battles (doubles: pick 4), fitted into a per-entry strength rating
//
// The format comes from FORMAT (sim/format.js): FORMAT=gen9championsvgc2026regmc runs doubles, with the doubles
// pilot (sim/dagent.js), Showdown's curated doubles movepools, 3 partners per set-search battle and output to
// web/data/doubles-results.json.
//   export    bundle everything into web/data/results.json for the team builder UI
//
// Usage: node sim/pipeline.js [--scale 1] [--stages sets,matchups,ladder,export] [--out out] [--limit N]

const fs = require('fs');
const path = require('path');
const F = require('./format');
const S = require('./sets');
const {Pool} = require('./pool');
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const DOUBLES = F.GAME_TYPE === 'doubles';
const PARTNERS = F.PICK_SIZE - 1; // teammates of the Pokémon whose set is being searched: it always plays
const SCALE = Number(arg('scale', 1));
const STAGES = arg('stages', 'sets,matchups,ladder,export').split(',');
const OUT = path.resolve(arg('out', 'out'));
const LIMIT = Number(arg('limit', 0));
const PASSES = Number(arg('passes', 2));
// Battle AI per stage: 'heuristic' (fast) or 'rollout4' (one-turn lookahead with 4-turn rollouts; beats the
// heuristic ~63% head-to-head but is ~75x slower per battle). --agent sets the default for every stage;
// --sets-agent, --matchups-agent and --ladder-agent override it. See sim/battle.js and sim/compare.js.
const AGENT = arg('agent', DOUBLES ? 'dheuristic' : 'heuristic');
// The sets stage defaults to heuristic2 (v2 tactical rules), which values status moves the v1 pilot ignores.
const agentsFor = stage => {
	const a = arg(stage + '-agent', stage === 'sets' ? arg('agent', DOUBLES ? 'dheuristic' : 'heuristic2') : AGENT);
	return [a, a];
};
// Set search: 'descent' (sim/setsearch.js: every move slot, item, ability and spread raced with paired
// battles and confirmed on fresh ones) or 'halving' (the old random hill climb, kept for comparison).
const SEARCH = arg('search', 'descent');
// Stronger pilot that checks each searched set against its starting point ('none' to skip).
const SETS_CHECK = arg('sets-check-agent', DOUBLES ? 'none' : 'rollout4all'); // no doubles lookahead pilot yet
// Optional rating weights for drawing partners and opponents (a results.json); uniform without.
const WEIGHTS = arg('weights', '');
const SETS_AGENTS = agentsFor('sets'), MATCHUPS_AGENTS = agentsFor('matchups'), LADDER_AGENTS = agentsFor('ladder');
// Sample sizes for the two big stages, if you want them independent of --scale.
const MATCHUP_K = Number(arg('matchup-k', 0));
const LADDER_GAMES = Number(arg('ladder-games', 0));
// Sharding across machines (sim/shard.js): --shard k/N runs only this machine's part of each stage (entries
// with index % N === k for sets; the k-th slice of the battles for matchups and ladder, saved as parts), and
// --parts N combines N saved parts of matchups / ladder instead of playing them.
const SHARD = arg('shard', '') ? (([k, m]) => ({k: Number(k), n: Number(m)}))(arg('shard').split('/')) : null;
const PARTS = Number(arg('parts', 0));
// Starting sets from an earlier run's results.json: they seed the population (so partners and opponents are
// realistic from the start) and join the archetype candidates in the first pass.
const INIT_SETS = arg('init-sets', '');
// Showdown ladder usage stats (chaos JSON, sim/ladderstats.js): every move the ladder uses on an entry (>= 10%) joins
// the set search's move pool, and the ladder's modal set joins the first pass's candidates. Only widens what the
// search tries; the simulation still decides.
const LADDER_STATS = arg('ladder-stats', '');
const WEB_OUT = path.resolve(arg('web', path.join(__dirname, '..', 'web', 'data', DOUBLES ? 'doubles-results.json' : 'results.json')));
fs.mkdirSync(OUT, {recursive: true});

const n = x => Math.max(4, Math.round(x * SCALE));

function save(name, data) {
	fs.writeFileSync(path.join(OUT, name), JSON.stringify(data));
}
function load(name) {
	const p = path.join(OUT, name);
	return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

async function mapLimit(items, limit, fn) {
	let i = 0;
	const workers = Array.from({length: Math.min(limit, items.length)}, async () => {
		while (i < items.length) {
			const idx = i++;
			await fn(items[idx], idx);
		}
	});
	await Promise.all(workers);
}

function log(...a) {
	console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

let entries = S.rosterEntries();
if (LIMIT) {
	const step = entries.length / LIMIT;
	entries = Array.from({length: LIMIT}, (_, i) => entries[Math.floor(i * step)]);
}
const byId = new Map(entries.map(e => [e.id, e]));

/** Pick k entries with distinct species, excluding `excludeSpecies`. */
function sampleEntries(rng, k, excludeSpecies = new Set()) {
	const out = [];
	const used = new Set(excludeSpecies);
	let guard = 0;
	while (out.length < k && guard++ < 1000) {
		const e = entries[Math.floor(rng() * entries.length)];
		if (used.has(e.species)) continue;
		used.add(e.species);
		out.push(e);
	}
	return out;
}

/** Build a team from entries, honouring Item Clause by falling back to alternate sets. */
function teamFrom(list, setsOf) {
	const usedItems = new Set();
	return list.map(e => {
		const options = setsOf(e.id);
		const pick = options.find(s => !s.item || !usedItems.has(s.item)) || options[0];
		usedItems.add(pick.item);
		return clean(pick);
	});
}

/**
 * Run jobs in slices, checkpointing finished results so an interrupted run (e.g. a reclaimed Spot server)
 * resumes where it stopped. Jobs must be generated deterministically, so the same index is the same battle.
 */
async function runResumable(pool, name, jobs, slice = 4000) {
	const file = path.join(OUT, `${name}.partial.json`);
	let results = [];
	if (fs.existsSync(file)) {
		const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
		if (saved.total === jobs.length) {
			results = saved.results;
			log(`${name}: resuming from ${results.length}/${jobs.length} battles`);
		}
	}
	for (let i = results.length; i < jobs.length; i += slice) {
		const part = await pool.run(jobs.slice(i, i + slice), 8);
		for (const r of part) results.push(r);
		fs.writeFileSync(file + '.tmp', JSON.stringify({total: jobs.length, results}));
		fs.renameSync(file + '.tmp', file);
		log(`  ${name}: ${results.length}/${jobs.length} battles`);
	}
	return results;
}

/**
 * Play `jobs` (all of them), or with --shard only this machine's slice, saved as `<name>.part<k>.json` (and
 * null returned); with --parts N, load the N saved slices instead of playing anything.
 */
async function playStage(pool, name, jobs) {
	const slice = k => [Math.floor(k * jobs.length / (SHARD || {n: PARTS}).n), Math.floor((k + 1) * jobs.length / (SHARD || {n: PARTS}).n)];
	if (SHARD) {
		const [lo, hi] = slice(SHARD.k);
		log(`${name}: shard ${SHARD.k}/${SHARD.n} plays battles ${lo}-${hi} of ${jobs.length}`);
		save(`${name}.part${SHARD.k}.json`, await runResumable(pool, `${name}.shard${SHARD.k}`, jobs.slice(lo, hi)));
		return null;
	}
	if (PARTS) {
		const res = [];
		for (let k = 0; k < PARTS; k++) {
			const part = load(`${name}.part${k}.json`);
			const [lo, hi] = slice(k);
			if (!part || part.length !== hi - lo) throw new Error(`${name}.part${k}.json missing or wrong size`);
			for (const r of part) res.push(r); // not push(...part): a slice can exceed the call-stack argument limit
		}
		return res;
	}
	return runResumable(pool, name, jobs);
}

// ---------------------------------------------------------------- stage: sets

async function stageSets(pool) {
	const state = load('sets.json') || {};
	const cands = new Map();
	for (const e of entries) cands.set(e.id, S.candidateSets(e));
	const init = new Map();
	if (INIT_SETS) {
		const {toPokemonSet} = require('./refine');
		const {setKey} = require('./util');
		const keyed = s => { s.key = setKey(s); return s; };
		for (const e of JSON.parse(fs.readFileSync(path.resolve(INIT_SETS), 'utf8')).entries) {
			if (!byId.has(e.id)) continue;
			init.set(e.id, {best: keyed(toPokemonSet(e, e.set)), alts: e.alts.map(a => keyed(toPokemonSet(e, a)))});
		}
		log(`sets: ${init.size} starting sets from ${INIT_SETS}`);
	}
	let extraMoves = null;
	if (LADDER_STATS) {
		const {loadLadder, ladderMoves} = require('./ladderstats');
		const {setKey} = require('./util');
		const ladder = loadLadder(path.resolve(LADDER_STATS), entries, {abilityOf: e => {
			const c = cands.get(e.id)[0];
			return c ? c.ability : Object.values(F.dex.species.get(e.species).abilities)[0];
		}});
		extraMoves = ladderMoves(ladder, 0.1);
		let seeded = 0;
		for (const x of ladder.list) {
			if (x.problems || !cands.has(x.entry.id)) continue;
			const set = {...x.set, spread: 'custom', archetype: 'ladder'};
			set.key = setKey(set);
			cands.get(x.entry.id).push(set);
			seeded++;
		}
		log(`sets: ladder stats ${LADDER_STATS}: ${seeded} modal sets seeded, extra moves for ${extraMoves.size} entries`);
	}
	const pop = new Map(entries.map(e => [e.id, state[e.id]?.best || init.get(e.id)?.best || cands.get(e.id)[0]]));
	const popSets = id => [pop.get(id)];

	async function evaluate(entry, candidates, games, rng, stats) {
		const contexts = [];
		for (let g = 0; g < games; g++) {
			const partners = sampleEntries(rng, PARTNERS, new Set([entry.species]));
			const opps = sampleEntries(rng, 6);
			contexts.push({partners: teamFrom(partners, popSets), opps: teamFrom(opps, popSets), seed: seedFrom(rng)});
		}
		const jobs = [];
		for (const c of candidates) {
			for (const ctx of contexts) {
				const a = [clean(c), ...ctx.partners.filter(p => !c.item || p.item !== c.item)];
				jobs.push({a, b: ctx.opps, seed: ctx.seed, agents: SETS_AGENTS});
			}
		}
		const res = await pool.run(jobs);
		candidates.forEach((c, ci) => {
			const st = stats.get(c.key) || {w: 0, g: 0};
			for (let k = 0; k < games; k++) {
				const r = res[ci * games + k];
				if (isFailed(r)) continue;
				if (r === 0) st.w += 1;
				else if (r === null) st.w += 0.5;
				st.g += 1;
			}
			stats.set(c.key, st);
		});
	}

	async function halving(entry, candidates, rounds, rng, stats) {
		let alive = candidates.slice();
		for (const games of rounds) {
			await evaluate(entry, alive, games, rng, stats);
			alive.sort((x, y) => wr(stats, y) - wr(stats, x));
			if (alive.length <= 2) continue;
			alive = alive.slice(0, Math.max(2, Math.ceil(alive.length / 2)));
		}
		return alive;
	}
	const wr = (stats, c) => {
		const st = stats.get(c.key);
		return st ? (st.w + 1) / (st.g + 2) : 0;
	};

	// descent: partners (each with its alternative sets, for Item Clause) and opponents from the population
	const popAlts = new Map(entries.map(e => [e.id, state[e.id] ? (state[e.id].alts || []).map(a => a.set) : init.get(e.id)?.alts || []]));
	const weightOf = (() => {
		if (!WEIGHTS) return () => 1;
		const prev = JSON.parse(fs.readFileSync(path.resolve(WEIGHTS), 'utf8'));
		const r = new Map(prev.entries.map(e => [e.id, e.rating]));
		return id => Math.exp(((r.get(id) ?? 1500) - 1500) / 120);
	})();
	const wList = entries.map(e => weightOf(e.id)), wTotal = wList.reduce((a, b) => a + b, 0);
	const drawEntry = rng => {
		let r = rng() * wTotal;
		for (let i = 0; i < entries.length; i++) if ((r -= wList[i]) <= 0) return entries[i];
		return entries[entries.length - 1];
	};
	const optionsOf = id => [pop.get(id), ...(popAlts.get(id) || [])].map(clean);
	const context = (rng, subject) => {
		const species = new Set([subject.species]), used = new Set(), partners = [];
		for (let guard = 0; partners.length < PARTNERS && guard < 1000; guard++) {
			const e = drawEntry(rng);
			if (species.has(e.species)) continue;
			const opts = optionsOf(e.id).filter(x => !x.item || !used.has(x.item));
			if (!opts.length) continue;
			species.add(e.species); used.add(opts[0].item); partners.push(opts);
		}
		const oppSpecies = new Set(), oppItems = new Set(), opps = [];
		for (let guard = 0; opps.length < 6 && guard < 1000; guard++) {
			const e = drawEntry(rng);
			if (oppSpecies.has(e.species)) continue;
			const x = optionsOf(e.id).find(o => !o.item || !oppItems.has(o.item));
			if (!x) continue;
			oppSpecies.add(e.species); oppItems.add(x.item); opps.push(x);
		}
		return {partners, opps};
	};
	const {SetSearch} = require('./setsearch');
	const descent = new SetSearch({
		pool, context, agent: SETS_AGENTS[0], checkAgent: SETS_CHECK === 'none' ? null : SETS_CHECK, scale: SCALE,
		rounds: Number(arg('rounds', 3)), log: m => log('  ' + m), extraMoves,
	});

	// progress = {pass, done: ids finished in that pass}; lets a restarted run skip finished work
	const progress = load('sets.progress.json') || {pass: 1, done: []};
	const saveAll = () => { save('sets.json', state); save('sets.progress.json', progress); };
	for (let pass = 1; pass <= PASSES; pass++) {
		if (pass < progress.pass) continue;
		const finished = new Set(pass === progress.pass ? progress.done : []);
		if (finished.size) log(`sets: resuming pass ${pass} with ${finished.size} entries already done`);
		log(`sets: pass ${pass}/${PASSES} over ${entries.length} entries`);
		let done = finished.size;
		const mine = entries.filter((e, i) => !SHARD || i % SHARD.n === SHARD.k);
		if (SHARD) log(`sets: shard ${SHARD.k}/${SHARD.n} runs ${mine.length} entries`);
		await mapLimit(mine.filter(e => !finished.has(e.id)), Number(arg('concurrency', 32)), async entry => {
			const rng = mulberry32(hash(entry.id) + pass * 7919);
			const stats = new Map();
			let pool0 = cands.get(entry.id);
			if (pass > 1 && state[entry.id]) pool0 = [state[entry.id].best, ...state[entry.id].alts.map(a => a.set)];
			else if (init.has(entry.id)) pool0 = [init.get(entry.id).best, ...init.get(entry.id).alts, ...pool0];
			// dedupe by key
			pool0 = pool0.filter((s, i, arr) => arr.findIndex(t => t.key === s.key) === i);
			// A later pass starts the descent from the incumbent: re-racing it against its item alternatives in a small
			// halving (~340 battles, no paired confirmation, no strong-pilot check) used to swap the item on noise
			// (44 of 344 sets in the 2026-11-15 run, mostly to Quick Claw / Bright Powder). The descent's item sweep
			// still tries every item, with the paired confirm.
			let ranked = SEARCH === 'descent' && pass > 1 && state[entry.id] ? [state[entry.id].best]
				: await halving(entry, pool0, [n(12), n(24), n(48)], rng, stats);
			if (SEARCH === 'descent') {
				// coordinate descent from the archetype screen's winner
				const r = await descent.search(entry, ranked[0], pass);
				state[entry.id] = {best: r.best, wr: r.wr, alts: r.alts, history: r.history, check: r.check, candidates: pool0.length, pass};
				pop.set(entry.id, r.best);
				popAlts.set(entry.id, r.alts.map(a => a.set));
				finished.add(entry.id);
				if (++done % 10 === 0) {
					log(`  ${done}/${mine.length} (${pool.battles} battles so far)`);
					progress.pass = pass; progress.done = [...finished];
					saveAll();
				}
				return;
			}
			// hill climb around the leader
			for (let step = 0; step < 2; step++) {
				const leader = ranked[0];
				const nbrs = S.neighbours(entry, leader, rng).slice(0, 6);
				if (!nbrs.length) break;
				const contest = await halving(entry, [leader, ...nbrs], [n(32), n(64)], rng, stats);
				ranked = [...contest, ...ranked.filter(r => !contest.some(c => c.key === r.key))];
				ranked.sort((x, y) => wr(stats, y) - wr(stats, x));
			}
			const all = [...new Map([...pool0, ...ranked].map(s => [s.key, s])).values()]
				.filter(s => stats.has(s.key))
				.sort((x, y) => wr(stats, y) - wr(stats, x));
			const alts = [];
			for (const s of all) {
				if (alts.length >= 4) break;
				if (alts.some(a => a.set.item === s.item)) continue;
				alts.push({set: s, wr: +wr(stats, s).toFixed(4), games: stats.get(s.key).g});
			}
			state[entry.id] = {best: alts[0].set, wr: alts[0].wr, alts: alts.slice(1), candidates: all.length, pass};
			pop.set(entry.id, alts[0].set);
			finished.add(entry.id);
			if (++done % 25 === 0) {
				log(`  ${done}/${entries.length} (${pool.battles} battles so far)`);
				progress.pass = pass; progress.done = [...finished];
				saveAll();
			}
		});
		progress.pass = pass + 1; progress.done = [];
		saveAll();
	}
	return state;
}

// ----------------------------------------------------------- stage: matchups

async function stageMatchups(pool, sets) {
	const ids = entries.map(e => e.id);
	const N = ids.length;
	const K = MATCHUP_K || n(8);
	log(`matchups: ${N}x${N} pairs, ${K} battles each`);
	const rng = mulberry32(12345);
	const jobs = [], index = [];
	// doubles partner: another entry's best set (an alternate if the items clash)
	// (redrawn until one has a set whose item clashes with neither subject: a side with a single Pokémon crashes
	// Showdown's doubles engine)
	const partnerFor = (rng, exclude, items) => {
		for (let guard = 0; guard < 200; guard++) {
			const [e] = sampleEntries(rng, 1, exclude);
			const opts = [sets[e.id].best, ...sets[e.id].alts.map(a => a.set)];
			const o = opts.find(x => !x.item || !items.includes(x.item));
			if (o) return clean(o);
		}
		throw new Error('no partner without an item clash');
	};
	for (let i = 0; i < N; i++) {
		for (let j = i + 1; j < N; j++) {
			const si = clean(sets[ids[i]].best), sj = clean(sets[ids[j]].best);
			let P = null, Q = null;
			for (let k = 0; k < K; k++) {
				const flip = k % 2 === 1;
				let a = [si], b = [sj];
				if (DOUBLES) {
					// battles 2m and 2m+1 share partners P and Q, swapped, so neither side keeps the better one
					if (k % 2 === 0) {
						const ex = new Set([byId.get(ids[i]).species, byId.get(ids[j]).species]);
						const items = [si.item, sj.item].filter(Boolean);
						P = partnerFor(rng, ex, items);
						ex.add(P.species);
						Q = partnerFor(rng, ex, items);
					}
					const [pi, pj] = flip ? [Q, P] : [P, Q];
					a = [si, pi];
					b = [sj, pj];
				}
				jobs.push({a: flip ? b : a, b: flip ? a : b, seed: seedFrom(rng), hp: true, agents: MATCHUPS_AGENTS});
				index.push([i, j, flip]);
			}
		}
	}
	const res = await playStage(pool, 'matchups', jobs);
	if (!res) return null;
	// Matchup value in [0, 1]: a win scores 0.5 + half the winner's remaining HP, a loss 0.5 - half the
	// opponent's remaining HP. So 1.0 = untouched sweep, 0.5 = coin flip, 0.0 = swept.
	const wins = new Float32Array(N * N), games = new Float32Array(N * N);
	res.forEach((r, x) => {
		const [i, j, flip] = index[x];
		if (isFailed(r)) return;
		const hpI = r.hp[flip ? 1 : 0], hpJ = r.hp[flip ? 0 : 1];
		let iVal = 0.5;
		if (r.w !== null) iVal = ((r.w === 0) !== flip) ? 0.5 + 0.5 * hpI : 0.5 - 0.5 * hpJ;
		wins[i * N + j] += iVal; games[i * N + j] += 1;
		wins[j * N + i] += 1 - iVal; games[j * N + i] += 1;
	});
	const bytes = Buffer.alloc(N * N);
	for (let x = 0; x < N * N; x++) {
		bytes[x] = games[x] ? Math.round(255 * wins[x] / games[x]) : 128;
	}
	const out = {ids, K, data: bytes.toString('base64')};
	save('matchups.json', out);
	return out;
}

// ------------------------------------------------------------- stage: ladder

function fitRatings(games, N, lambda = 0.02, iters = 400) {
	// logistic regression: P(A wins) = sigmoid(sum r[A picks] - sum r[B picks])
	const r = new Float64Array(N);
	const lr = 0.5;
	for (let it = 0; it < iters; it++) {
		const grad = new Float64Array(N);
		for (const g of games) {
			let z = 0;
			for (const i of g.a) z += r[i];
			for (const i of g.b) z -= r[i];
			const p = 1 / (1 + Math.exp(-z));
			const err = g.y - p;
			for (const i of g.a) grad[i] += err;
			for (const i of g.b) grad[i] -= err;
		}
		for (let i = 0; i < N; i++) r[i] += lr * (grad[i] / games.length * N / 6 - lambda * r[i]);
	}
	return r;
}

async function stageLadder(pool, sets) {
	const G = LADDER_GAMES || n(20000);
	const ids = entries.map(e => e.id);
	const idx = new Map(ids.map((id, i) => [id, i]));
	const setsOf = id => [sets[id].best, ...sets[id].alts.map(a => a.set)];
	log(`ladder: ${G} team battles`);
	const rng = mulberry32(777);
	const jobs = [], teams = [];
	for (let g = 0; g < G; g++) {
		const A = sampleEntries(rng, 6), B = sampleEntries(rng, 6);
		teams.push([A, B]);
		jobs.push({a: teamFrom(A, setsOf), b: teamFrom(B, setsOf), seed: seedFrom(rng), picks: true, agents: LADDER_AGENTS});
	}
	const res = await playStage(pool, 'ladder', jobs);
	if (!res) return null;
	const stats = ids.map(() => ({brought: 0, picked: 0, pickedWins: 0}));
	const games = [];
	res.forEach((r, g) => {
		if (r.w === null || !r.picks[0].length) return;
		const [A, B] = teams[g];
		const pa = r.picks[0].map(k => idx.get(A[k].id)), pb = r.picks[1].map(k => idx.get(B[k].id));
		for (const e of A) stats[idx.get(e.id)].brought++;
		for (const e of B) stats[idx.get(e.id)].brought++;
		for (const i of pa) { stats[i].picked++; if (r.w === 0) stats[i].pickedWins++; }
		for (const i of pb) { stats[i].picked++; if (r.w === 1) stats[i].pickedWins++; }
		games.push({a: pa, b: pb, y: r.w === 0 ? 1 : 0});
	});
	const r = fitRatings(games, ids.length);
	const out = {
		games: games.length,
		ratings: Object.fromEntries(ids.map((id, i) => [id, +r[i].toFixed(4)])),
		stats: Object.fromEntries(ids.map((id, i) => [id, stats[i]])),
	};
	save('ladder.json', out);
	return out;
}

// ------------------------------------------------------------- stage: export

function stageExport(sets, matchups, ladder) {
	const ids = matchups.ids;
	const elo = r => Math.round(1500 + 400 / Math.LN10 * r);
	const describe = s => ({
		item: s.item, ability: s.ability, nature: s.nature, moves: s.moves,
		statPoints: Object.fromEntries(Object.entries(s.evs).filter(([, v]) => v > 0)), archetype: s.archetype,
	});
	const out = ids.map(id => {
		const e = byId.get(id);
		const sp = F.dex.species.get(e.battleSpecies);
		const st = ladder.stats[id];
		return {
			id, species: e.species, mega: e.megaItem ? e.battleSpecies : null, megaItem: e.megaItem,
			types: sp.types, baseStats: sp.baseStats, num: F.dex.species.get(e.species).num, sprite: sp.spriteid,
			rating: elo(ladder.ratings[id]),
			setWinRate: sets[id].wr,
			pickRate: st.brought ? +(st.picked / st.brought).toFixed(3) : 0,
			winRateWhenPicked: st.picked ? +(st.pickedWins / st.picked).toFixed(3) : 0,
			games: st.picked,
			set: describe(sets[id].best),
			alts: sets[id].alts.map(a => ({...describe(a.set), winRate: a.wr})),
		};
	});
	const result = {
		meta: {
			format: F.format.name, formatId: F.FORMAT_ID, gameType: F.GAME_TYPE, pickSize: F.PICK_SIZE, generatedAt: new Date().toISOString(), scale: SCALE, agents: {sets: SETS_AGENTS[0], matchups: MATCHUPS_AGENTS[0], ladder: LADDER_AGENTS[0]},
			ladderGames: ladder.games, matchupBattlesPerPair: matchups.K,
			showdownVersion: require('pokemon-showdown/package.json').version,
		},
		entries: out,
		matchups: {ids, data: matchups.data},
	};
	fs.mkdirSync(path.dirname(WEB_OUT), {recursive: true});
	fs.writeFileSync(WEB_OUT, JSON.stringify(result));
	log(`export: wrote ${out.length} entries to ${WEB_OUT}`);
}

(async () => {
	const t0 = Date.now();
	// --pool lambda plays every battle on AWS Lambda (aws/lambda-deploy.sh) instead of this machine's cores
	const pool = arg('pool', 'local') === 'lambda'
		? new (require('./lambdapool').LambdaPool)({concurrency: Number(arg('lambda-concurrency', 700))}) : new Pool();
	// memory diagnostics every 2 minutes (a 64-thread machine has run out of RAM before)
	const memTimer = pool.memStats ? setInterval(() => log(`[mem] ${pool.memStats()}`), 120000) : null;
	if (memTimer) memTimer.unref();
	log(`search=${SEARCH} check=${SETS_CHECK} agents=${SETS_AGENTS[0]}/${MATCHUPS_AGENTS[0]}/${LADDER_AGENTS[0]} scale=${SCALE} stages=${STAGES} entries=${entries.length} workers=${pool.size}`);
	try {
		let sets = load('sets.json');
		if (STAGES.includes('sets')) sets = await stageSets(pool);
		let matchups = load('matchups.json');
		if (STAGES.includes('matchups')) matchups = await stageMatchups(pool, sets);
		let ladder = load('ladder.json');
		if (STAGES.includes('ladder')) ladder = await stageLadder(pool, sets);
		if (STAGES.includes('export')) stageExport(sets, matchups, ladder);
	} finally {
		pool.close();
	}
	log(`done: ${pool.battles} battles in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
	if (pool.errors || pool.workerFailures) {
		log(`WARNING: ${pool.errors} battles crashed and ${pool.workerFailures} worker failures; ${pool.failed} failed battles were left out. First errors:`);
		for (const e of pool.errorSamples) log('  ' + e);
	}
})().catch(e => {
	console.error(e);
	process.exit(1);
});
