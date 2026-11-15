'use strict';
// Convergence benchmark. "Converged" means: a decision made with simulation level A loses less than ~1
// percentage point of win rate when judged by a stronger or bigger level B. Rankings reshuffling among
// near-ties doesn't count; only lost win rate does.
//
//   node sim/bench.js make    [--dir bench] [--drafts 40] [--positions 300]   fixed scenarios (seeded)
//   node sim/bench.js draft   --level h-s1 [--dir bench] [--limit N]           solve every draft scenario
//   node sim/bench.js turn    --level h-8x8 [--dir bench] [--limit N]          analyse every battle position
//   node sim/bench.js study   --plan turn:h-4x4,turn:h-32x32:1,draft:h-s1@10,match:mc4x4:rollout4@100
//   node sim/bench.js compare --kind draft|turn --a h-s1 --b h-s16 [--dir bench]
//
// compare reports, over scenarios: how often A's top choice is also B's, and A's regret: B's value of
// B's best option minus B's value of A's choice (A's equilibrium mix, for drafts). Run B twice with a
// different --salt to measure B's own noise floor; regret below that floor can't be resolved.

const fs = require('fs');
const path = require('path');
const {Battle} = require('pokemon-showdown');
const {FORMAT_ID} = require('./format');
const {Pool} = require('./pool');
const {toPokemonSet} = require('./refine');
const {mulberry32, seedFrom, clean, hash} = require('./util');
const {playOut} = require('./battle');
const {legalChoices, analyzeTurn, DEFAULT_RESULTS} = require('./engine');
const {solveDraft, solveDraftStrong} = require('./draft');

const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const DIR = path.resolve(arg('dir', 'bench'));
const RESULTS = path.resolve(arg('results', DEFAULT_RESULTS));
const SALT = Number(arg('salt', 0));
const LIMIT = Number(arg('limit', 0));
// Every level (and --salt replicate) draws independent samples: if a bigger level reused a smaller one's
// first samples, the two would agree more than their accuracy deserves.
const levelSalt = (name, salt) => hash(`${name}|${salt}`);

// Simulation levels. Draft: battle AI + samples per cell at each adaptive stage. Turn: rollout AI,
// determinizations D and rollouts per cell K.
const DRAFT_LEVELS = {
	'h-s1': {policy: 'heuristic', screen: 4, refine: 16, grade: 48},
	'h-s4': {policy: 'heuristic', screen: 16, refine: 64, grade: 192},
	'h-s16': {policy: 'heuristic', screen: 64, refine: 256, grade: 768},
	'r4-s1': {policy: 'rollout4', screen: 4, refine: 16, grade: 48},
	'r4-s4': {policy: 'rollout4', screen: 16, refine: 64, grade: 192},
	// hybrid (sim/draft.js StrongDraft): heuristic screen, rollout4 on the contested corner
	'x4-s1': {hybrid: true, policy: 'rollout4', screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48},
	'x4-s4': {hybrid: true, policy: 'rollout4', screen: 4, refine: 16, rows: 12, cols: 10, strong: 64, grade: 192, probe: 16},
	'x2-s1': {hybrid: true, policy: 'rollout2', screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48},
};
const TURN_LEVELS = {
	'h-4x4': {policy: 'heuristic', D: 4, K: 4},
	'h-8x8': {policy: 'heuristic', D: 8, K: 8},
	'h-16x16': {policy: 'heuristic', D: 16, K: 16},
	'h-32x32': {policy: 'heuristic', D: 32, K: 32},
	'r4-4x4': {policy: 'rollout4', D: 4, K: 4},
	'r4-8x8': {policy: 'rollout4', D: 8, K: 8},
	'r4-16x16': {policy: 'rollout4', D: 16, K: 16},
};

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
const read = name => JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8'));
const write = (name, data) => {
	fs.mkdirSync(DIR, {recursive: true});
	fs.writeFileSync(path.join(DIR, name), JSON.stringify(data));
};

/** A meta team: entries drawn by rating (as on the ladder), distinct species, Item Clause. */
function metaTeam(results, rng) {
	const {entries} = results;
	const w = entries.map(e => Math.exp((e.rating - 1500) / 120));
	const total = w.reduce((a, b) => a + b, 0);
	const species = new Set(), items = new Set(), team = [];
	while (team.length < 6) {
		let r = rng() * total, i = 0;
		while ((r -= w[i]) > 0 && i < entries.length - 1) i++;
		const e = entries[i];
		if (species.has(e.species)) continue;
		const desc = [e.set, ...e.alts].find(s => !s.item || !items.has(s.item));
		if (!desc) continue;
		species.add(e.species); items.add(desc.item);
		team.push(clean(toPokemonSet(e, desc)));
	}
	return team;
}

async function mapLimit(items, limit, fn) {
	let i = 0;
	await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
		while (i < items.length) { const k = i++; await fn(items[k], k); }
	}));
}

// ------------------------------------------------------------------ make

function make() {
	const results = require(RESULTS);
	const rng = mulberry32(20261022);
	const drafts = Array.from({length: Number(arg('drafts', 40))}, () => {
		const mine = metaTeam(results, rng);
		const theirs = metaTeam(results, rng);
		return {mine, theirSpecies: theirs.map(s => s.species), theirs};
	});
	// Battle positions: heuristic-vs-heuristic games between meta teams, stopped at a random decision
	// where the side to move has at least two options.
	const positions = [];
	const want = Number(arg('positions', 300));
	let guard = 0;
	while (positions.length < want && guard++ < want * 20) {
		const b = new Battle({formatid: FORMAT_ID, seed: seedFrom(rng), send: () => {}});
		b.setPlayer('p1', {name: 'A', team: metaTeam(results, rng)});
		b.setPlayer('p2', {name: 'B', team: metaTeam(results, rng)});
		const stopAt = 1 + Math.floor(rng() * 8);
		playOut(b, ['heuristic', 'heuristic'], stopAt);
		if (b.ended) { b.destroy(); continue; }
		const viewer = rng() < 0.5 ? 0 : 1;
		const side = b.sides[viewer];
		if (!side.activeRequest || side.activeRequest.wait || side.isChoiceDone() || legalChoices(side).length < 2) {
			b.destroy();
			continue;
		}
		const state = b.toJSON();
		const blog = state.log.slice();
		state.log = [];
		positions.push({state, log: blog, viewer, turn: b.turn});
		b.destroy();
	}
	write('drafts.json', drafts);
	write('positions.json', positions);
	log(`wrote ${drafts.length} draft scenarios and ${positions.length} positions to ${DIR}`);
}

// ------------------------------------------------------------------ run levels

const outName = (kind, level, salt) => `${kind}-${level}${salt ? '-s' + salt : ''}.json`;

async function runDrafts(pool, levelName, salt = SALT, limit = LIMIT) {
	const level = DRAFT_LEVELS[levelName];
	if (!level) throw new Error(`unknown draft level ${levelName}: ${Object.keys(DRAFT_LEVELS)}`);
	let drafts = read('drafts.json');
	if (limit) drafts = drafts.slice(0, limit);
	const file = outName('draft', levelName, salt);
	const done = fs.existsSync(path.join(DIR, file)) ? read(file) : {};
	const t0 = Date.now();
	let battles = 0;
	// a few scenarios at a time keeps every core busy through each solver's sequential stages
	// hybrid solves have short sequential stages, so more of them run at once
	await mapLimit(drafts.map((d, i) => i).filter(i => !done[i]), level.hybrid ? 8 : 3, async i => {
		const d = drafts[i];
		const r = await (level.hybrid ? solveDraftStrong : solveDraft)(pool, d.mine, d.theirSpecies, {...level, resultsPath: RESULTS, salt: levelSalt(levelName, salt)});
		done[i] = {value: r.value, battles: r.battles, strongBattles: r.strongBattles, failed: r.failed, options: r.options.map(o => ({index: o.index, value: o.value, se: o.se, mix: o.mix})),
			theirMix: r.theirMix.map(t => ({index: t.index, p: t.p}))};
		battles += r.battles;
		write(file, done);
		log(`${file}: scenario ${i} value ${(100 * r.value).toFixed(1)}% (${r.battles} battles${r.failed ? `, ${r.failed} FAILED` : ''}, ${((Date.now() - t0) / 1000).toFixed(0)}s total)`);
	});
	log(`${file} done: ${battles} battles in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function runTurns(pool, levelName, salt = SALT, limit = LIMIT) {
	const level = TURN_LEVELS[levelName];
	if (!level) throw new Error(`unknown turn level ${levelName}: ${Object.keys(TURN_LEVELS)}`);
	let positions = read('positions.json');
	if (limit) positions = positions.slice(0, limit);
	const file = outName('turn', levelName, salt);
	const done = fs.existsSync(path.join(DIR, file)) ? read(file) : {};
	const t0 = Date.now();
	let n = 0;
	await mapLimit(positions.map((p, i) => i).filter(i => !done[i]), 4, async i => {
		const p = positions[i];
		const b = Battle.fromJSON(p.state);
		b.log = p.log;
		const r = await analyzeTurn(pool, b, p.viewer, {...level, resultsPath: RESULTS, salt: levelSalt(levelName, salt)});
		b.destroy();
		done[i] = {value: r.value, dropped: r.droppedDeterminizations, options: r.options.map(o => ({choice: o.choice, label: o.label, value: o.value, se: o.se, mix: o.mix}))};
		if (++n % 10 === 0) {
			write(file, done);
			log(`${file}: ${Object.keys(done).length}/${positions.length} positions, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
		}
	});
	write(file, done);
	log(`${file} done in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

/**
 * Several runs in one go (for a single AWS instance), e.g.
 *   --plan turn:h-4x4,turn:h-32x32:1,draft:r4-s1@10,match:mc4x4:mcfull4x4@100
 * kind:level[:salt][@limit]; match:A:B@pairs plays sim/compare.js. Finished work is skipped on a rerun.
 */
async function study(pool) {
	const plan = arg('plan', '').split(',').filter(Boolean);
	// check every item first, so a typo late in the plan can't waste the runs before it
	for (const item of plan) {
		const [kind, a, b] = item.split('@')[0].split(':');
		const known = {turn: TURN_LEVELS, draft: DRAFT_LEVELS}[kind];
		if (kind === 'match' ? !(a && b) : !(known && known[a])) throw new Error(`bad plan item ${item}`);
	}
	for (const item of plan) {
		const [spec, lim] = item.split('@');
		const [kind, a, b] = spec.split(':');
		log(`study: ${item}`);
		if (kind === 'turn') await runTurns(pool, a, Number(b || 0), Number(lim || 0));
		else if (kind === 'draft') await runDrafts(pool, a, Number(b || 0), Number(lim || 0));
		else if (kind === 'match') {
			const file = path.join(DIR, `match-${a}-${b}.txt`);
			if (fs.existsSync(file)) continue;
			const out = require('child_process').execFileSync(process.execPath,
				[path.join(__dirname, 'compare.js'), '--a', a, '--b', b, '--pairs', lim || '100', '--results', RESULTS], {encoding: 'utf8'});
			fs.writeFileSync(file, out);
			log(out.trim());
		} else throw new Error(`bad plan item ${item}`);
	}
}

// ------------------------------------------------------------------ compare

function compare() {
	const kind = arg('kind', 'turn');
	const A = read(`${kind}-${arg('a')}.json`), B = read(`${kind}-${arg('b')}.json`);
	const key = kind === 'draft' ? 'index' : 'choice';
	const regrets = [], agree = [];
	const hurt = x => x.failed || x.dropped; // scenarios with failed battles or dropped determinizations
	const damaged = Object.keys(A).filter(id => B[id] && (hurt(A[id]) || hurt(B[id])));
	for (const id of Object.keys(A)) {
		if (!B[id]) continue;
		const bVal = new Map(B[id].options.map(o => [o[key], o.value]));
		const bBest = Math.max(...bVal.values());
		// A plays its equilibrium mix; B judges each option
		const aValue = A[id].options.reduce((s, o) => s + o.mix * (bVal.get(o[key]) ?? 0), 0) /
			A[id].options.reduce((s, o) => s + o.mix, 0);
		regrets.push(bBest - aValue);
		const aTop = A[id].options[0][key], bTop = B[id].options[0][key];
		agree.push(aTop === bTop ? 1 : 0);
	}
	const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
	const se = xs => Math.sqrt(xs.reduce((s, x) => s + (x - mean(xs)) ** 2, 0) / (xs.length - 1) / xs.length);
	const sorted = regrets.slice().sort((a, b) => a - b);
	console.log(`${kind}: ${arg('a')} judged by ${arg('b')} over ${regrets.length} scenarios`);
	console.log(`  mean regret ${(100 * mean(regrets)).toFixed(2)} ± ${(196 * se(regrets)).toFixed(2)} pp (95% CI)`);
	console.log(`  median ${(100 * sorted[sorted.length >> 1]).toFixed(2)} pp, 90th pct ${(100 * sorted[Math.floor(sorted.length * 0.9)]).toFixed(2)} pp, max ${(100 * sorted[sorted.length - 1]).toFixed(2)} pp`);
	console.log(`  same top choice: ${(100 * mean(agree)).toFixed(0)}%`);
	if (damaged.length) console.log(`  WARNING: ${damaged.length} scenarios include failed battles: ${damaged.join(', ')}`);
}

(async () => {
	if (cmd === 'make') make();
	else if (cmd === 'compare') compare();
	else if (['draft', 'turn', 'study'].includes(cmd)) {
		const pool = new Pool();
		try {
			if (cmd === 'draft') await runDrafts(pool, arg('level', 'h-s1'));
			else if (cmd === 'turn') await runTurns(pool, arg('level', 'h-8x8'));
			else await study(pool);
		} finally {
			pool.close();
		}
		if (pool.errors || pool.workerFailures) log(`WARNING: ${pool.errors} crashed jobs, ${pool.workerFailures} worker failures, ${pool.failed} failed jobs left out`, pool.errorSamples);
	} else console.log('usage: node sim/bench.js make|draft|turn|study|compare ... (see the top of sim/bench.js)');
})().catch(e => { console.error(e); process.exit(1); });
