'use strict';
// Robustness of team results to team preview. Team search and the team benchmarks play 6v6 battles where both
// pilots pick their three by a fixed heuristic, so a team can look strong by beating predictable picks. This scores
// teams against a fixed sample of field teams as team-preview games (sim/preview-game.js: both sides choose their
// three by equilibrium), next to the plain-battle score on the same opponents.
//
//   node sim/preview-check.js --teams out/strongest/ladder-search.json --field ladder --ingame ... --chaos ... \
//     --replays ... --opponents 100 --pool lambda --out out/strongest/preview-check.json

const fs = require('fs');
const path = require('path');
const {mulberry32, hash, seedFrom, isFailed} = require('./util');
const {previewValue} = require('./preview-game');
const {Field} = require('./field');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

(async () => {
	const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
	const search = JSON.parse(fs.readFileSync(path.resolve(arg('teams')), 'utf8'));
	const seen = new Set();
	const teams = search.teams.slice().sort((a, b) => b.winRate - a.winRate).filter(t => {
		const k = t.sets.map(s => s.species).sort().join();
		if (seen.has(k)) return false;
		seen.add(k); return true;
	}).slice(0, Number(arg('top', 4)));
	// always include the builder's first start for reference
	const builder = search.teams.find(t => t.kind === 'builder');
	if (builder && !teams.includes(builder)) teams.unshift(builder);
	else if (builder) teams.splice(teams.indexOf(builder), 1), teams.unshift(builder);
	const replayTeams = arg('replays') ? require('./team-bench-lib').realTeams(path.resolve(arg('replays')), results, arg('chaos'), 1250).map(t => t.team) : [];
	const field = new Field({results, ingame: arg('ingame'), chaos: arg('chaos'), replayTeams, replayShare: 0.5});
	const rng = mulberry32(hash('preview-check') + Number(arg('salt', 0)));
	const opps = Array.from({length: Number(arg('opponents', 100))}, () => field.sample(rng));
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
	const STRONG = arg('strong', 'rollout4all'); // plain battles' pilot (e.g. rollout4all~v); preview games enumerate the picks
	const BATTLE_GAMES = Number(arg('battle-games', 20));
	const report = {opponents: opps.length, teams: []};
	for (const t of teams) {
		const t0 = Date.now();
		// plain battles (fixed preview heuristic on both sides), same opponents
		const jobs = [], meta = [];
		opps.forEach((o, k) => { for (let g = 0; g < BATTLE_GAMES; g++) { const flip = g % 2 === 1; jobs.push({a: flip ? o : t.sets, b: flip ? t.sets : o, seed: seedFrom(rng), agents: [STRONG, STRONG]}); meta.push({k, flip}); } });
		const res = await pool.run(jobs, 2);
		const plain = opps.map(() => ({w: 0, g: 0}));
		res.forEach((r, i) => { if (isFailed(r)) return; const {k, flip} = meta[i]; plain[k].w += r === null ? 0.5 : (r === (flip ? 1 : 0) ? 1 : 0); plain[k].g++; });
		const plainV = plain.map(p => p.g ? p.w / p.g : 0.5);
		// preview games
		const pv = await Promise.all(opps.map((o, k) => previewValue(pool, t.sets, o, mulberry32(hash(t.team) + k), {
			strong: STRONG, screenGames: Number(arg('screen-games', 4)), strongGames: Number(arg('strong-games', 12)), keep: 6})));
		const prevV = pv.map(r => r.value);
		const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
		const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)); };
		const d = prevV.map((v, k) => v - plainV[k]);
		const row = {team: t.team, kind: t.kind, searchWinRate: t.winRate, plain: +mean(plainV).toFixed(4), plainSe: +(sd(plainV) / Math.sqrt(opps.length)).toFixed(4),
			preview: +mean(prevV).toFixed(4), previewSe: +(sd(prevV) / Math.sqrt(opps.length)).toFixed(4), diff: +mean(d).toFixed(4), diffSe: +(sd(d) / Math.sqrt(opps.length)).toFixed(4)};
		row.perOpponent = {plain: plainV.map(v => +v.toFixed(4)), preview: prevV.map(v => +v.toFixed(4))};
		// paired against the first team (the Team Builder's) on the same opponents
		const first = report.teams[0];
		if (first) {
			const dd = prevV.map((v, k) => v - first.perOpponent.preview[k]);
			row.previewVsFirst = {diff: +mean(dd).toFixed(4), se: +(sd(dd) / Math.sqrt(opps.length)).toFixed(4)};
		}
		report.teams.push(row);
		console.log(`${t.kind.padEnd(9)} plain ${(100 * row.plain).toFixed(1)}% ± ${(100 * row.plainSe).toFixed(1)}  preview game ${(100 * row.preview).toFixed(1)}% ± ${(100 * row.previewSe).toFixed(1)}` +
			`  (diff ${(100 * row.diff).toFixed(1)} ± ${(100 * row.diffSe).toFixed(1)})` +
			(row.previewVsFirst ? `  preview vs first team ${(100 * row.previewVsFirst.diff).toFixed(1)} ± ${(100 * row.previewVsFirst.se).toFixed(1)}` : '') +
			`  ${t.team}  [${((Date.now() - t0) / 1000).toFixed(0)}s]`);
		fs.mkdirSync(path.dirname(path.resolve(arg('out', 'out/preview-check.json'))), {recursive: true});
		fs.writeFileSync(path.resolve(arg('out', 'out/preview-check.json')), JSON.stringify(report, null, 1));
	}
	pool.close();
})().catch(e => { console.error(e); process.exit(1); });
