'use strict';
// Ladder benchmark for the singles sets: do our precomputed sets beat what strong ladder players actually run?
//
// Reads Showdown's usage statistics for the same format (the "chaos" JSON at
// https://www.smogon.com/stats/<month>/chaos/gen9championsbssregmc-<cutoff>.json) and, for each of the most used
// Pokémon, builds the ladder's modal set: its 4 most used moves, most used item, nature + stat points. Then it
// races variants of the subject on identical battles (same partners, opponents and dice), like sim/audit-moves.js:
//
//   ours         our precomputed best set (web/data/results.json)
//   ladder       the ladder's modal set
//   ladderMoves  our item, ability and spread with the ladder's moves (separates moves from item / spread)
//   compare      with --compare other-results.json, that file's set (e.g. from sim/setsearch-run.js)
//
// in one of two fields:
//   --field sim     partners and opponents drawn from our own results (weighted by rating), as in the sets stage
//   --field ladder  partners and opponents drawn by ladder usage, each with its ladder modal set
//
// A ladder set that beats ours under our own pilot and field means our search missed it (a search issue). Ours
// beating the ladder set under the strong pilot in the ladder field is a simulation finding, unless the ladder
// set's edge rests on something the pilot can't play (see the pilot-coverage column: moves the heuristic has no
// rule for are almost never clicked).
//
//   node sim/ladder-bench.js --stats chaos.json --top 40 --field ladder --agent heuristic2 --n 3000 --pool lambda
//   node sim/ladder-bench.js --stats chaos.json --print           # just list the ladder sets next to ours

const fs = require('fs');
const path = require('path');
const F = require('./format');
const {dex} = F;
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');
const {toPokemonSet} = require('./refine');
const {knownStatus} = require('./agent');
const {loadLadder, STAT_KEYS} = require('./ladderstats');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const flag = name => argv.includes('--' + name);
const STATS_PATH = arg('stats');
const RESULTS = require(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))));
const TOP = Number(arg('top', 40));
const N = Number(arg('n', 2000));
const AGENT = arg('agent', 'heuristic2');
const FIELD = arg('field', 'ladder');
const ONLY = arg('subjects', '') ? new Set(arg('subjects').split(',')) : null; // entry ids
const OUT = path.resolve(arg('out', `out/ladder-bench/${FIELD}-${AGENT}.json`));

// --compare other-results.json adds that file's set for each subject (e.g. a re-searched set) as a fourth variant
const COMPARE = arg('compare', '') ? JSON.parse(fs.readFileSync(path.resolve(arg('compare')), 'utf8')) : null;
const entries = RESULTS.entries;
const LADDER = loadLadder(STATS_PATH, entries);
const invalid = LADDER.list.filter(x => x.problems);
const ladderOk = LADDER.list.filter(x => !x.problems);

// ---- fields -----------------------------------------------------------------------------------------------
function sampler(list, weightOf) {
	const w = list.map(weightOf), total = w.reduce((a, b) => a + b, 0);
	return rng => {
		let r = rng() * total;
		for (let i = 0; i < list.length; i++) if ((r -= w[i]) <= 0) return list[i];
		return list[list.length - 1];
	};
}
const drawSim = sampler(entries, e => Math.exp((e.rating - 1500) / 120));
const drawLadder = sampler(ladderOk, x => x.usage);

/** k sets with distinct species (not in `species`) and items (not in `items`). */
function drawSets(rng, k, species, items) {
	const out = [];
	let guard = 0;
	while (out.length < k && guard++ < 2000) {
		let set;
		if (FIELD === 'sim') {
			const e = drawSim(rng);
			if (species.has(e.species)) continue;
			const desc = [e.set, ...e.alts].find(s => !s.item || !items.has(s.item));
			if (!desc) continue;
			set = clean(toPokemonSet(e, desc));
		} else {
			const x = drawLadder(rng);
			if (species.has(x.set.species) || items.has(x.set.item)) continue;
			set = clean(x.set);
		}
		species.add(set.species); items.add(set.item);
		out.push(set);
	}
	return out;
}

function contexts(subject, n, items) {
	const rng = mulberry32(hash(subject.id) + 11 + (FIELD === 'sim' ? 0 : 1000) + 7919 * Number(arg('salt', 0)));
	return Array.from({length: n}, () => {
		// partners may not share an item with any variant, so every variant keeps Item Clause
		const partners = drawSets(rng, 2, new Set([subject.species]), new Set(items));
		const opps = drawSets(rng, 6, new Set(), new Set());
		return {partners, opps, seed: seedFrom(rng), flip: rng() < 0.5};
	});
}

async function evaluate(pool, subject, variants, n) {
	const ctxs = contexts(subject, n, variants.map(v => v.set.item));
	const jobs = [];
	for (const v of variants) for (const c of ctxs) {
		const team = [clean(v.set), ...c.partners];
		jobs.push({a: c.flip ? c.opps : team, b: c.flip ? team : c.opps, seed: c.seed, agents: [AGENT, AGENT]});
	}
	const res = await pool.run(jobs, AGENT.startsWith('rollout') ? 2 : 8);
	const wins = variants.map((v, vi) => ctxs.map((c, k) => {
		const r = res[vi * n + k];
		if (isFailed(r)) return NaN;
		const w = r && typeof r === 'object' && 'winner' in r ? r.winner : r;
		if (w === null || w === undefined) return 0.5;
		return w === (c.flip ? 1 : 0) ? 1 : 0;
	}));
	return variants.map((v, vi) => {
		const d = wins[vi].map((x, k) => x - wins[0][k]).filter(Number.isFinite);
		const m = d.reduce((a, b) => a + b, 0) / (d.length || 1);
		const sd = Math.sqrt(d.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, d.length - 1));
		const w = wins[vi].filter(Number.isFinite);
		return {label: v.label, set: v.set, wr: +(w.reduce((a, b) => a + b, 0) / (w.length || 1)).toFixed(4),
			diff: +m.toFixed(4), se: +(sd / Math.sqrt(d.length || 1)).toFixed(4), n: d.length};
	});
}

const unruled = set => set.moves.filter(m => { const mv = dex.moves.get(m); return mv.category === 'Status' && !knownStatus(mv.id); });
const fmtSet = s => `${s.item} / ${s.ability} / ${s.nature} ${STAT_KEYS.map(k => s.evs[k]).join('/')} / ${s.moves.join(', ')}`;

async function main() {
	const subjects = ladderOk.slice(0, TOP).filter(x => !ONLY || ONLY.has(x.entry.id))
		.filter(x => x.set.moves.join() !== 'Transform');
	if (flag('print')) {
		for (const x of subjects) {
			const ours = toPokemonSet(x.entry, x.entry.set);
			console.log(`${x.name} (${(100 * x.usage).toFixed(1)}%)\n  ladder: ${fmtSet(x.set)}${unruled(x.set).length ? `   [no pilot rule: ${unruled(x.set).join(', ')}]` : ''}\n  ours:   ${fmtSet(ours)}`);
		}
		if (invalid.length) console.log('ladder sets failing validation:', invalid.map(x => `${x.name}: ${x.problems.join('; ')}`).join('\n'));
		return;
	}
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 400))});
		await pool.check();
	} else {
		pool = new (require('./pool').Pool)();
	}
	const report = {stats: LADDER.info, field: FIELD, agent: AGENT, n: N, results: RESULTS.meta.generatedAt,
		generatedAt: new Date().toISOString(), subjects: []};
	const save = () => { fs.mkdirSync(path.dirname(OUT), {recursive: true}); fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); };
	const t0 = Date.now();
	let i = 0;
	const work = async x => {
		const ours = toPokemonSet(x.entry, x.entry.set);
		const variants = [{label: 'ours', set: ours}, {label: 'ladder', set: x.set}];
		if (x.set.moves.slice().sort().join() !== ours.moves.slice().sort().join()) {
			variants.push({label: 'ladderMoves', set: {...ours, moves: x.set.moves}});
		}
		const other = COMPARE && COMPARE.entries.find(e => e.id === x.entry.id);
		if (other) variants.push({label: 'compare', set: toPokemonSet(other, other.set)});
		const res = await evaluate(pool, x.entry, variants, N);
		report.subjects.push({id: x.entry.id, name: x.name, usage: x.usage, rating: x.entry.rating,
			ladderUnruled: unruled(x.set), results: res});
		const f = r => r ? `${(100 * r.diff).toFixed(1).padStart(5)} ± ${(100 * r.se).toFixed(1)}` : '   -     ';
		const byLabel = l => res.find(r => r.label === l);
		console.log(`${x.name.padEnd(20)} ours ${(100 * res[0].wr).toFixed(1)}%  ladder ${f(byLabel('ladder'))}  ladderMoves ${f(byLabel('ladderMoves'))}` +
			(COMPARE ? `  compare ${f(byLabel('compare'))}` : '') +
			`  ${unruled(x.set).length ? 'unruled: ' + unruled(x.set).join(',') : ''}  [${((Date.now() - t0) / 1000).toFixed(0)}s, ${pool.battles} battles]`);
		save();
	};
	await Promise.all(Array.from({length: Number(arg('parallel', 8))}, async () => { while (i < subjects.length) await work(subjects[i++]); }));
	save();
	console.log(`done: ${pool.battles} battles in ${((Date.now() - t0) / 1000).toFixed(0)}s; failed ${pool.failed || 0}`);
	if (pool.errorSamples && pool.errorSamples.length) console.log(pool.errorSamples.join('\n'));
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
