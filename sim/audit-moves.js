'use strict';
// Move-choice audit for the precomputed singles sets (web/data/results.json).
//
// Answers two questions with paired battles (every variant plays the same opponents, partners and dice):
//   redundancy  For each best set with two attacks of the same type and category, is the weaker one a dead
//               slot (removing it costs nothing), and does any other move in that slot do better?
//   status      For strong entries, does any status / tactical move beat the set's weakest slot?
//
// Context: like the sets stage, the subject plus 2 partners (fixed, so the subject always plays) against a
// 6-member opponent that picks 3, all drawn from the meta weighted by rating, Item Clause respected.
//
//   node sim/audit-moves.js --mode redundancy --n 4000 --pool lambda --out out/audit-redundancy.json
//   node sim/audit-moves.js --mode status --top 30 --n 4000 --pool lambda --out out/audit-status.json
//   node sim/audit-moves.js --mode pairs --pairs out/pairs.json --agent rollout4 --n 1500 --pool lambda ...
// --agent picks the pilot for both sides (heuristic, rollout4). --pool local uses this machine's cores.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const {dex} = F;
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');
const {toPokemonSet} = require('./refine');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const MODE = arg('mode', 'redundancy');
const N = Number(arg('n', 4000));
const AGENT = arg('agent', 'heuristic');
const TOP = Number(arg('top', 30));
const OUT = path.resolve(arg('out', `out/audit-${MODE}-${AGENT}.json`));
const RESULTS = require(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))));
const SUBJECTS = arg('subjects', '') ? arg('subjects').split(',') : null;

// Status and tactical moves a competitive singles player would consider. Not all are understood equally by the
// heuristic pilot (sim/agent.js), which is part of what this audit measures.
const TACTICAL = [
	'willowisp', 'thunderwave', 'toxic', 'glare', 'spore', 'sleeppowder', 'yawn', 'nuzzle',
	'swordsdance', 'nastyplot', 'dragondance', 'calmmind', 'bulkup', 'quiverdance', 'shellsmash', 'irondefense',
	'recover', 'roost', 'slackoff', 'synthesis', 'moonlight', 'softboiled', 'strengthsap', 'wish',
	'protect', 'substitute', 'taunt', 'encore', 'disable', 'trick', 'haze', 'roar', 'whirlwind', 'destinybond',
	'stealthrock', 'spikes', 'toxicspikes', 'stickyweb', 'rapidspin', 'defog',
	'reflect', 'lightscreen', 'auroraveil', 'trickroom', 'tailwind', 'memento', 'healingwish', 'partingshot',
	'uturn', 'voltswitch', 'flipturn', 'knockoff', 'suckerpunch', 'fakeout', 'icywind', 'electroweb', 'bodypress',
];

const entries = RESULTS.entries;
const weights = entries.map(e => Math.exp((e.rating - 1500) / 120));
const totalW = weights.reduce((a, b) => a + b, 0);
function draw(rng) {
	let r = rng() * totalW;
	for (let i = 0; i < entries.length; i++) if ((r -= weights[i]) <= 0) return entries[i];
	return entries[entries.length - 1];
}
/** k meta sets with distinct species (not in `species`) and items (not in `items`). */
function drawSets(rng, k, species, items) {
	const out = [];
	let guard = 0;
	while (out.length < k && guard++ < 1000) {
		const e = draw(rng);
		if (species.has(e.species)) continue;
		const desc = [e.set, ...e.alts].find(s => !s.item || !items.has(s.item));
		if (!desc) continue;
		species.add(e.species); items.add(desc.item);
		out.push(clean(toPokemonSet(e, desc)));
	}
	return out;
}

function contexts(subject, n, salt = 0) {
	const rng = mulberry32(hash(subject.id) + 7 + salt);
	return Array.from({length: n}, () => {
		const partners = drawSets(rng, 2, new Set([subject.species]), new Set([subject.set.item]));
		const opps = drawSets(rng, 6, new Set(), new Set());
		return {partners, opps, seed: seedFrom(rng), flip: rng() < 0.5};
	});
}

const moveId = name => F.toID(name);
const learnable = species => new Set(F.learnableMoves(dex.species.get(species)).map(m => m.id));

/** Paired evaluation of several variants of one subject's set. Returns win rates and diffs vs variants[0]. */
async function evaluate(pool, subject, variants, n) {
	const ctxs = contexts(subject, n);
	const jobs = [];
	for (const v of variants) {
		const mine = clean(v.set);
		for (const c of ctxs) {
			const team = [mine, ...c.partners];
			jobs.push({a: c.flip ? c.opps : team, b: c.flip ? team : c.opps, seed: c.seed, agents: [AGENT, AGENT]});
		}
	}
	const res = await pool.run(jobs, 8);
	const wins = variants.map((v, vi) => ctxs.map((c, k) => {
		const r = res[vi * n + k];
		if (isFailed(r)) return NaN;
		if (r === null) return 0.5;
		return r === (c.flip ? 1 : 0) ? 1 : 0;
	}));
	return variants.map((v, vi) => {
		const d = wins[vi].map((x, k) => x - wins[0][k]).filter(Number.isFinite);
		const m = d.reduce((a, b) => a + b, 0) / (d.length || 1);
		const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / (d.length || 1));
		const w = wins[vi].filter(Number.isFinite);
		return {label: v.label, moves: v.set.moves, wr: +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(4),
			diff: +m.toFixed(4), se: +(sd / Math.sqrt(d.length || 1)).toFixed(4), n: d.length};
	});
}

function withMove(set, slot, move) {
	const s = JSON.parse(JSON.stringify(set));
	if (move === null) s.moves.splice(slot, 1);
	else s.moves[slot] = dex.moves.get(move).name;
	return s;
}

/** Pairs of attacks in a set with the same type, category and priority. */
function redundantPairs(moves) {
	const ms = moves.map(m => dex.moves.get(m));
	const out = [];
	for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
		const a = ms[i], b = ms[j];
		if (a.category === 'Status' || b.category === 'Status') continue;
		if (a.type === b.type && a.category === b.category && a.priority === b.priority) out.push([i, j]);
	}
	return out;
}

/** Replacement candidates for one slot: curated movepool moves, tactical moves, then new attacking types. */
function candidates(subject, set, limit) {
	const learn = learnable(subject.species);
	const have = new Set(set.moves.map(moveId));
	const haveTypes = new Set(set.moves.map(m => dex.moves.get(m)).filter(m => m.category !== 'Status').map(m => m.type));
	const out = [];
	const add = id => { if (learn.has(id) && !have.has(id) && !out.includes(id)) out.push(id); };
	const {curatedRoles} = require('./sets');
	const roles = curatedRoles(F.toID(subject.mega || subject.species)) || curatedRoles(F.toID(subject.species)) || [];
	for (const r of roles) for (const m of r.movepool) add(moveId(m));
	TACTICAL.forEach(add);
	const cat = dex.moves.get(set.moves[0]).category;
	const attacks = [...learn].map(id => dex.moves.get(id)).filter(m => m.category !== 'Status' && m.basePower >= 60 &&
		!haveTypes.has(m.type) && (!require('./sets').BANNED_ATTACKS.has(m.id) || require('./sets').SPECIAL_POWER[m.id]) && (cat === 'Status' || m.category === cat) && !m.flags.charge && !m.selfdestruct)
		.sort((a, b) => b.basePower * (b.accuracy === true ? 1 : b.accuracy / 100) - a.basePower * (a.accuracy === true ? 1 : a.accuracy / 100));
	const seenTypes = new Set();
	for (const m of attacks) {
		if (seenTypes.has(m.type)) continue;
		seenTypes.add(m.type);
		add(m.id);
		if (seenTypes.size >= 4) break;
	}
	return out.slice(0, limit);
}

async function main() {
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
	} else {
		pool = new (require('./pool').Pool)();
	}
	const report = {mode: MODE, agent: AGENT, n: N, generatedAt: new Date().toISOString(), subjects: []};
	const save = () => { fs.mkdirSync(path.dirname(OUT), {recursive: true}); fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); };
	const t0 = Date.now();

	let subjects;
	if (MODE === 'redundancy') subjects = entries.filter(e => redundantPairs(e.set.moves).length);
	else if (MODE === 'status') subjects = [...entries].sort((a, b) => b.rating - a.rating).slice(0, TOP);
	else if (MODE === 'pairs') subjects = [];
	if (SUBJECTS) subjects = entries.filter(e => SUBJECTS.includes(e.id));

	const work = async subject => {
		const base = toPokemonSet(subject, subject.set);
		const variants = [{label: 'base', set: base}];
		let slot;
		if (MODE === 'redundancy') {
			const [i, j] = redundantPairs(base.moves)[0];
			// the weaker of the pair by base power x accuracy
			const pw = k => { const m = dex.moves.get(base.moves[k]); return (m.basePower || 0) * (m.multihit ? 2 : 1); };
			slot = pw(i) <= pw(j) ? i : j;
		} else {
			// weakest slot by ablation
			const abl = await evaluate(pool, subject, [{label: 'base', set: base},
				...base.moves.map((m, k) => ({label: `drop ${m}`, set: withMove(base, k, null)}))], Math.round(N / 2));
			slot = abl.slice(1).reduce((b, r, k) => (r.diff > abl[b + 1].diff ? k : b), 0);
			report.subjects.push({id: subject.id, ablation: abl});
		}
		variants.push({label: `drop ${base.moves[slot]}`, set: withMove(base, slot, null)});
		for (const m of candidates(subject, base, MODE === 'redundancy' ? 14 : 16)) {
			variants.push({label: `${base.moves[slot]} -> ${dex.moves.get(m).name}`, set: withMove(base, slot, m), move: m});
		}
		const res = await evaluate(pool, subject, variants, N);
		const rec = report.subjects.find(s => s.id === subject.id) || (report.subjects.push({id: subject.id}), report.subjects.at(-1));
		Object.assign(rec, {species: subject.species, rating: subject.rating, set: base.moves, slot: base.moves[slot], results: res});
		const best = res.slice(2).sort((a, b) => b.diff - a.diff)[0];
		console.log(`${subject.id.padEnd(28)} slot ${base.moves[slot].padEnd(16)} drop ${(100 * res[1].diff).toFixed(1).padStart(5)} ± ${(100 * res[1].se).toFixed(1)}` +
			`   best: ${best ? `${best.label} ${(100 * best.diff).toFixed(1)} ± ${(100 * best.se).toFixed(1)}` : '-'}   [${((Date.now() - t0) / 1000).toFixed(0)}s, ${pool.battles} battles]`);
		save();
	};

	if (MODE === 'pairs') {
		// explicit variant lists: [{id, variants: [[moves...], ...]}] with variants[0] the base
		const spec = JSON.parse(fs.readFileSync(arg('pairs'), 'utf8'));
		await Promise.all(spec.map(async s => {
			const subject = entries.find(e => e.id === s.id);
			const base = toPokemonSet(subject, subject.set);
			const variants = s.variants.map(moves => ({label: moves.join('/'), set: {...base, moves}}));
			const res = await evaluate(pool, subject, variants, N);
			report.subjects.push({id: s.id, results: res});
			console.log(s.id, res.map(r => `${r.label}: ${(100 * r.diff).toFixed(1)} ± ${(100 * r.se).toFixed(1)}`).join(' | '));
			save();
		}));
	} else {
		const conc = Number(arg('parallel', 8));
		let i = 0;
		await Promise.all(Array.from({length: conc}, async () => { while (i < subjects.length) await work(subjects[i++]); }));
	}
	save();
	console.log(`done: ${pool.battles} battles in ${((Date.now() - t0) / 1000).toFixed(0)}s; failed ${pool.failed || 0}`);
	if (pool.errorSamples && pool.errorSamples.length) console.log(pool.errorSamples.join('\n'));
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
