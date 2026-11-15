'use strict';
// Convergence study for team tuning (sim/refine.js): how big must the samples be before tuning harder stops
// changing the result? Tunes realistic teams at several sample scales, then judges every resulting team (and
// the untuned original) on one large fresh gauntlet, paired battles for all of them.
//
//   node sim/tune-study.js [--teams 12] [--scales 1,2.5,5,10] [--rounds 4] [--judge-teams 1000] [--judge-seeds 20]
//                          [--out out/tune-study.json]
//
// Regret of a scale = judged win rate of the best team any scale found for that team minus its own. The
// rigorous budget should be the smallest scale whose regret is well under the project's 1 pp bar and that the
// next scale up doesn't beat by more than noise.

const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const {Pool} = require('./pool');
const {refineTeam, makeGauntlet, playGauntlet, seedsFor, pairedDiff} = require('./refine');
const {mulberry32, hash, clean} = require('./util');
const {toPokemonSet} = require('./refine');

const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, all) =>
	(x.startsWith('--') ? a.concat([[x.slice(2), all[i + 1]]]) : a), []));
const TEAMS = Number(args.teams || 12);
const SCALES = (args.scales || '1,2.5,5,10').split(',').map(Number);
const ROUNDS = Number(args.rounds || 4);
const JUDGE_TEAMS = Number(args['judge-teams'] || 1000), JUDGE_SEEDS = Number(args['judge-seeds'] || 20);
const OUT = args.out || 'out/tune-study.json';
const ROOT = path.join(__dirname, '..');
const log = msg => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

(async () => {
	const results = JSON.parse(fs.readFileSync(path.join(ROOT, 'web', 'data', 'results.json'), 'utf8'));
	const {buildTeams, assignSets, makeScorer} = await import(pathToFileURL(path.join(ROOT, 'web', 'team.js')).href);
	const scorer = makeScorer(results);
	const rng = mulberry32(hash('tune-study'));
	const species = [...new Set(results.entries.map(e => e.species))];

	// Realistic teams: the Team Builder's best team for random collections of 45 species, Megas on and off.
	const teams = [];
	while (teams.length < TEAMS) {
		const owned = new Set(species.slice().sort(() => rng() - 0.5).slice(0, 45));
		const built = buildTeams(results, owned, {scorer, teams: 1, includeMegas: teams.length % 2 === 0});
		if (!built.length || built[0].members.length < 6) continue;
		teams.push(assignSets(results, built[0].members).map(m => ({entryId: m.entry.id, set: m.set})));
	}
	const pool = new Pool();
	log(`${TEAMS} teams x scales ${SCALES.join('/')} (up to ${ROUNDS} rounds) on ${pool.size} workers`);
	const state = {scales: SCALES, rounds: ROUNDS, judge: {teams: JUDGE_TEAMS, seeds: JUDGE_SEEDS}, teams: []};
	const save = () => fs.writeFileSync(OUT, JSON.stringify(state, null, 1));

	const judgeRng = mulberry32(hash('tune-study-judge'));
	const judge = makeGauntlet(results, judgeRng, JUDGE_TEAMS);
	const judgeSeeds = seedsFor(judgeRng, judge, JUDGE_SEEDS);
	const byId = new Map(results.entries.map(e => [e.id, e]));
	const toSets = members => members.map(m => clean(toPokemonSet(byId.get(m.entryId), m.set)));

	await Promise.all(teams.map(async (team, t) => {
		const rec = {members: team.map(m => m.entryId), levels: {}};
		state.teams[t] = rec;
		const tuned = await Promise.all(SCALES.map(scale => {
			const t0 = Date.now();
			return refineTeam(pool, results, team, {scale, rounds: ROUNDS, priority: -scale}).then(r => {
				log(`team ${t} scale ${scale}: ${r.members.filter(m => m.changes.length).length} set(s) changed, ` +
					`${r.battles} battles, ${Math.round((Date.now() - t0) / 1000)}s`);
				return r;
			});
		}));
		// judge each distinct outcome once, all on the same battles (paired)
		const variants = new Map([[JSON.stringify(team.map(m => m.set)), {members: team, games: null}]]);
		const keyOf = r => JSON.stringify(r.members.map(m => m.refined));
		tuned.forEach(r => {
			const k = keyOf(r);
			if (!variants.has(k)) variants.set(k, {members: r.members.map(m => ({entryId: m.entryId, set: {...m.refined}})), games: null});
		});
		for (const v of variants.values()) {
			v.games = (await playGauntlet(pool, toSets(v.members), judge, judgeSeeds)).map(g => g.win);
		}
		const original = variants.get(JSON.stringify(team.map(m => m.set))).games;
		const mean = xs => { const f = xs.filter(Number.isFinite); return f.reduce((a, b) => a + b, 0) / f.length; };
		let bestRate = -1;
		for (const v of variants.values()) bestRate = Math.max(bestRate, mean(v.games));
		SCALES.forEach((scale, i) => {
			const r = tuned[i], v = variants.get(keyOf(r));
			const vsOriginal = pairedDiff(v.games, original);
			rec.levels[scale] = {
				changes: r.members.reduce((a, m) => a + m.changes.length, 0), battles: r.battles,
				reportedGain: r.improvement.diff, judged: +mean(v.games).toFixed(4),
				judgedGain: +vsOriginal.diff.toFixed(4), judgedGainSe: +vsOriginal.se.toFixed(4),
				regret: +(bestRate - mean(v.games)).toFixed(4),
			};
		});
		log(`team ${t} judged: ${SCALES.map(s => `${s}x ${(rec.levels[s].judgedGain * 100).toFixed(2)}pp`).join(', ')}`);
		save();
	}));

	const summary = {};
	for (const s of SCALES) {
		const ls = state.teams.map(r => r.levels[s]);
		const avg = f => ls.reduce((a, l) => a + f(l), 0) / ls.length;
		summary[s] = {
			meanRegretPp: +(avg(l => l.regret) * 100).toFixed(3), maxRegretPp: +(Math.max(...ls.map(l => l.regret)) * 100).toFixed(3),
			meanJudgedGainPp: +(avg(l => l.judgedGain) * 100).toFixed(3), meanBattles: Math.round(avg(l => l.battles)),
		};
	}
	state.summary = summary;
	save();
	log('summary ' + JSON.stringify(summary));
	pool.close();
})().catch(e => { console.error(e); process.exit(1); });
