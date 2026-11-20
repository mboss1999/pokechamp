'use strict';
// Tune the best teams from a ladder team search (sim/team-search.js --field ladder) against the same real-ladder
// field (sim/field.js), with the app's team tuning (sim/refine.js refineTeam, rigorous budget). Writes
// [{key, team, result}] for sim/strategies.js --tuned.
//
//   node sim/tune-field.js --search out/team-search/ladder.json --ingame out/field/ingame-20261115 --chaos chaos.json \
//     --replays out/team-bench/replays --top 3 --pool lambda --out out/team-search/ladder-tuned.json

const fs = require('fs');
const path = require('path');
const {refineTeam} = require('./refine');
const {Field} = require('./field');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

(async () => {
	const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
	const search = JSON.parse(fs.readFileSync(path.resolve(arg('search')), 'utf8'));
	const replayTeams = arg('replays') ? require('./team-bench-lib').realTeams(path.resolve(arg('replays')), results, arg('chaos'), Number(arg('min-rating', 1250))).map(t => t.team) : [];
	const field = new Field({results, ingame: arg('ingame'), chaos: arg('chaos'), replayTeams, replayShare: Number(arg('replay-share', 0.5))});
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
		pool.speculate = 3;
	} else pool = new (require('./pool').Pool)();
	pool = require('./checkpoint').wrap(pool, arg('checkpoint')); // --checkpoint file: resumable (sim/checkpoint.js)
	const byId = new Map(results.entries.map(e => [e.id, e]));
	const seen = new Set(), picks = [];
	for (const t of search.teams.slice().sort((a, b) => b.winRate - a.winRate)) {
		const key = t.sets.map(s => s.species).sort().join();
		if (seen.has(key)) continue;
		seen.add(key);
		picks.push({key, team: t.members.map(m => { const e = byId.get(m.entryId); return {entryId: m.entryId, set: [e.set, ...e.alts][m.setIndex]}; })});
		if (picks.length >= Number(arg('top', 3))) break;
	}
	const out = [];
	const OUT = path.resolve(arg('out', 'out/team-search/ladder-tuned.json'));
	for (const p of picks) {
		const t0 = Date.now();
		console.log(`tuning ${p.key}`);
		const result = await refineTeam(pool, results, p.team, {budget: arg('budget', 'rigorous'), opponents: rng => field.sample(rng)});
		out.push({...p, result});
		fs.mkdirSync(path.dirname(OUT), {recursive: true});
		fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
		console.log(`  before ${(100 * result.before.winRate).toFixed(1)}%  after ${(100 * result.after.winRate).toFixed(1)}%` +
			`${result.revertedTuning ? ' (tuning rejected)' : ''}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
		for (const m of result.members) if (m.changes.length) console.log(`  ${m.entryId}: ${m.changes.join('; ')}`);
	}
	pool.close();
})().catch(e => { console.error(e); process.exit(1); });
