'use strict';
// Run the coordinate-descent set search (sim/setsearch.js) on chosen entries against the current meta in
// web/data/results.json, without re-running the whole pipeline. Writes the searched sets, and a copy of
// results.json with them swapped in (so sim/audit-moves.js --results can re-audit them).
//
//   node sim/setsearch-run.js --ids dragapult,toxicroak --pool lambda --scale 4 --check rollout4all

const fs = require('fs');
const path = require('path');
const {SetSearch} = require('./setsearch');
const {toPokemonSet} = require('./refine');
const {clean, setKey} = require('./util');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const RESULTS_PATH = path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json')));
const results = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const OUT = path.resolve(arg('out', 'out/setsearch'));
const IDS = arg('ids', '').split(',').filter(Boolean);
const entries = results.entries;

const weights = entries.map(e => Math.exp((e.rating - 1500) / 120));
const totalW = weights.reduce((a, b) => a + b, 0);
const draw = rng => {
	let r = rng() * totalW;
	for (let i = 0; i < entries.length; i++) if ((r -= weights[i]) <= 0) return entries[i];
	return entries[entries.length - 1];
};
const optionsOf = e => [e.set, ...e.alts].map(d => clean(toPokemonSet(e, d)));

/** Meta context: 2 partners (each a list of its sets) and 6 opponents, rating-weighted, Item Clause respected. */
function metaContext(rng, subject) {
	const species = new Set([subject.species]);
	const partners = [];
	const used = new Set();
	while (partners.length < 2) {
		const e = draw(rng);
		if (species.has(e.species)) continue;
		const opts = optionsOf(e).filter(s => !s.item || !used.has(s.item));
		if (!opts.length) continue;
		species.add(e.species); used.add(opts[0].item);
		partners.push(opts);
	}
	const opps = [], oppSpecies = new Set(), oppItems = new Set();
	while (opps.length < 6) {
		const e = draw(rng);
		if (oppSpecies.has(e.species)) continue;
		const s = optionsOf(e).find(x => !x.item || !oppItems.has(x.item));
		if (!s) continue;
		oppSpecies.add(e.species); oppItems.add(s.item);
		opps.push(s);
	}
	return {partners, opps};
}

async function main() {
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 700))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
	const t0 = Date.now();
	const search = new SetSearch({
		pool, context: metaContext, agent: arg('agent', 'heuristic2'), checkAgent: arg('check', null),
		scale: Number(arg('scale', 1)), rounds: Number(arg('rounds', 3)),
		log: m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`),
	});
	fs.mkdirSync(OUT, {recursive: true});
	const found = {};
	await Promise.all(IDS.map(async id => {
		const e = entries.find(x => x.id === id);
		if (!e) throw new Error(`unknown id ${id}`);
		const start = toPokemonSet(e, e.set);
		start.key = setKey(start);
		const r = await search.search({id: e.id, species: e.species, megaItem: e.megaItem, battleSpecies: e.mega || e.species}, start);
		found[id] = {start: start.moves, ...r};
		console.log(`${id}: ${start.moves.join('/')} @ ${start.item}  =>  ${r.best.moves.join('/')} @ ${r.best.item} ${r.best.ability} ${r.best.nature}` +
			`  wr ${r.wr}  changes ${r.history.length}${r.check ? `  ${r.check.agent} ${(100 * r.check.diff).toFixed(1)} ± ${(100 * r.check.se).toFixed(1)}${r.check.reverted ? ' REVERTED' : ''}` : ''}`);
	}));
	fs.writeFileSync(path.join(OUT, 'sets.json'), JSON.stringify(found, null, 1));
	const desc = s => ({item: s.item, ability: s.ability, nature: s.nature, moves: s.moves,
		statPoints: Object.fromEntries(Object.entries(s.evs).filter(([, v]) => v > 0)), archetype: 'descent'});
	const swapped = JSON.parse(JSON.stringify(results));
	for (const e of swapped.entries) {
		const f = found[e.id];
		if (!f) continue;
		e.set = desc(f.best);
		if (f.alts.length) e.alts = f.alts.map(a => ({...desc(a.set), winRate: a.wr}));
	}
	fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(swapped));
	console.log(`done: ${search.battles} battles in ${((Date.now() - t0) / 1000).toFixed(0)}s; failed ${pool.failed || 0}`);
	if (pool.errorSamples && pool.errorSamples.length) console.log(pool.errorSamples.join('\n'));
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
