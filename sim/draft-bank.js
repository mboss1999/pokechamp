'use strict';
// Drill bank for Draft practice: team preview matchups analysed ahead of time, so practice is instant and every
// verdict is the strong AI's. Your teams are the Strongest teams (web/data/strategies.json); the opponents are real
// teams top players brought on the ladder (Showdown replays, team preview species only).
//
//   node sim/draft-bank.js --replays out/team-bench/replays --chaos out/ladder-bench/chaos-2026-10-1760.json \
//     --per-team 25 --budget strong --out out/draft-bank/draft-bank.json --checkpoint out/draft-bank/bank.ckpt
//   then copy the output to web/data/draft-bank.json
//
// Also writes web/data/ladder-teams.json (or --ladder-out): the real teams' species, which live drills (your own
// team, analysed on demand) draw their opponents from.
//
// --budget strong runs StrongDraft (sim/draft.js) and then grades every option outside its corner with --grade-rest
// strong battles per reply (default 16), so any pick you make has a strong-AI value. --budget normal / quick use the
// heuristic analysis (all options valued). Resumable: finished drills are kept in --out and skipped; --checkpoint
// replays the battles of a drill that was interrupted (sim/checkpoint.js). --pool lambda plays on Lambda.

const fs = require('fs');
const path = require('path');
const {mulberry32, hash, clean} = require('./util');
const {toPokemonSet} = require('./refine');
const {solveDraft, solveDraftStrong, draftResult} = require('./draft');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.join(__dirname, '..');
const RESULTS = path.resolve(arg('results', path.join(ROOT, 'web', 'data', 'results.json')));
const BUDGETS = {
	quick: {screen: 2, refine: 8, grade: 24},
	normal: {screen: 4, refine: 16, grade: 48},
	strong: {hybrid: true, policy: 'rollout4all', screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48},
};

function writeJson(file, data) {
	fs.mkdirSync(path.dirname(file), {recursive: true});
	fs.writeFileSync(file + '.tmp', JSON.stringify(data));
	fs.renameSync(file + '.tmp', file);
}

/** Round the numbers of an analysis so the bank stays small. */
function compact(r) {
	const round = x => typeof x === 'number' ? Math.round(x * 1e4) / 1e4 : x;
	// options graded after the solve can come out above the solve's best: losses are to the top option shown
	const top = Math.max(...r.options.map(o => o.value));
	return {
		...r,
		value: round(r.value),
		options: r.options.map(o => ({option: o.option, lead: o.lead, back: o.back, value: round(o.value), se: round(o.se),
			loss: round(top - o.value), lossSe: round(o.lossSe), mix: round(o.mix), vsTheirs: o.vsTheirs.map(round)})),
		theirMix: r.theirMix.map(t => ({option: t.option, lead: t.lead, back: t.back, p: round(t.p)})),
	};
}

(async () => {
	const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
	const byId = new Map(results.entries.map(e => [e.id, e]));

	// --- my teams: the Strongest teams, ladder first, then the equilibrium mix by weight
	const strat = JSON.parse(fs.readFileSync(path.resolve(arg('strategies', path.join(ROOT, 'web', 'data', 'strategies.json'))), 'utf8'));
	const seen = new Set();
	const teams = [];
	const addTeam = (label, members) => {
		const k = members.map(m => m.entryId).sort().join();
		if (seen.has(k) || members.some(m => !byId.has(m.entryId))) return;
		seen.add(k);
		teams.push({label, members});
	};
	(strat.ladder?.teams || []).forEach((t, i) => addTeam(`Ladder team ${i + 1} (${t.kind})`, t.members));
	(strat.equilibrium?.teams || []).filter(t => t.weight >= Number(arg('min-weight', 0.05)))
		.forEach((t, i) => addTeam(`Equilibrium team ${i + 1} (${Math.round(t.weight * 100)}%)`, t.members));
	const maxTeams = Number(arg('teams', 99));
	teams.splice(maxTeams);

	// --- opponents: real ladder teams, species only (all you see at team preview)
	const real = require('./team-bench-lib').realTeams(path.resolve(arg('replays')), results, arg('chaos'), Number(arg('min-rating', 1250)));
	const ladderTeams = real.map(t => ({species: t.team.map(s => s.species), rating: t.rating}));
	const ladderOut = path.resolve(arg('ladder-out', path.join(ROOT, 'web', 'data', 'ladder-teams.json')));
	writeJson(ladderOut, {generatedAt: new Date().toISOString(), source: 'Showdown replays of top-100 ladder players, [Gen 9 Champions] BSS Reg M-C', teams: ladderTeams});
	console.log(`${ladderTeams.length} real ladder teams -> ${path.relative(ROOT, ladderOut)}`);

	const budgetName = arg('budget', 'strong');
	const budget = BUDGETS[budgetName];
	if (!budget) throw new Error(`--budget quick|normal|strong`);
	const perTeam = Number(arg('per-team', 25));
	const drills = [];
	teams.forEach((t, ti) => {
		const rng = mulberry32(hash(`draft-bank|${t.label}|${arg('salt', 0)}`));
		const order = ladderTeams.map((x, i) => ({i, r: rng()})).sort((a, b) => a.r - b.r).map(x => x.i);
		for (const i of order.slice(0, perTeam)) drills.push({team: ti, theirs: ladderTeams[i].species, rating: ladderTeams[i].rating});
	});
	const keyOf = d => `${d.team}|${d.theirs.join(',')}|${budgetName}`;

	// --- resume
	const outFile = path.resolve(arg('out', path.join(ROOT, 'out', 'draft-bank', 'draft-bank.json')));
	const bank = {generatedAt: null, results: results.meta.generatedAt, budget: budgetName,
		teams: teams.map(t => ({label: t.label, members: t.members})), drills: []};
	if (fs.existsSync(outFile)) {
		const old = JSON.parse(fs.readFileSync(outFile, 'utf8'));
		if (old.results === bank.results && old.budget === budgetName && JSON.stringify(old.teams) === JSON.stringify(bank.teams)) bank.drills = old.drills;
	}
	const done = new Set(bank.drills.map(d => keyOf(d)));
	const todo = drills.filter(d => !done.has(keyOf(d)));
	console.log(`${teams.length} teams x ${perTeam} opponents = ${drills.length} drills (${budgetName}); ${todo.length} to analyse`);

	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
	pool = require('./checkpoint').wrap(pool, arg('checkpoint'));

	const t0 = Date.now();
	let finished = 0;
	const one = async d => {
		const t1 = Date.now();
		const mine = teams[d.team].members.map(m => clean(toPokemonSet(byId.get(m.entryId), m.set)));
		const opts = {...budget, resultsPath: RESULTS};
		let r;
		if (budget.hybrid) {
			r = await solveDraftStrong(pool, mine, d.theirs, opts);
			// every option gets a strong-AI value, so whatever the player picks can be graded instantly
			const all = [...Array(r.solver.h.M).keys()];
			const g = await r.solver.gradeOptions(all, Number(arg('grade-rest', 16)));
			r = {...g, matrix: r.solver.s};
		} else {
			r = await solveDraft(pool, mine, d.theirs, opts);
		}
		if (r.failed > 0.02 * r.battles) throw new Error(`${r.failed} of ${r.battles} battles failed (${d.theirs.join(', ')})`);
		bank.drills.push({team: d.team, theirs: d.theirs, rating: d.rating, result: compact(draftResult(r, budgetName, mine, d.theirs)), failed: r.failed});
		bank.generatedAt = new Date().toISOString();
		writeJson(outFile, bank);
		finished++;
		const el = (Date.now() - t0) / 1000;
		console.log(`[${finished}/${todo.length}] ${teams[d.team].label} vs ${d.theirs.join(', ')}: ${r.battles} battles` +
			`${r.strongBattles ? ` (${r.strongBattles} strong)` : ''}${r.failed ? `, ${r.failed} failed` : ''} in ${Math.round((Date.now() - t1) / 1000)}s;` +
			` eta ${Math.round(el / finished * (todo.length - finished) / 60)} min`);
	};
	// a few drills at once keep every core busy through each drill's sequential stages
	const parallel = Number(arg('parallel', 4));
	let next = 0;
	await Promise.all(Array.from({length: parallel}, async () => { while (next < todo.length) await one(todo[next++]); }));
	pool.close();
	console.log(`done: ${bank.drills.length} drills -> ${path.relative(ROOT, outFile)}`);
	process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
