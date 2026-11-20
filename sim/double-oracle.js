'use strict';
// "Theoretically strongest" teams: an approximate equilibrium of the team-choice game, by double oracle.
//
// Team choice is a symmetric zero-sum game (both players pick six from the same roster, then play), so the strongest
// strategy is an equilibrium mix of teams, not one team against a fixed field. Double oracle builds it:
//   1. a population of teams, and their payoff matrix: each pair's value as a team-preview game (which three each
//      side brings, sim/preview-game.js), strong pilot
//   2. solve the matrix game (sim/nash.js): the equilibrium mix over the population; its value is 50% by symmetry
//   3. best response: team search (sim/team-search.js) against opponents drawn from that mix
//   4. if the best response beats the mix by more than --eps (default 1 point), add it and repeat; else stop
// At the stop, no team the search can find beats the equilibrium mix by more than eps: the mix is an eps-equilibrium
// with respect to that search (a local search: a team it can't reach could still do better).
//
// Sets are each entry's sets from --results (the self-consistent simulated meta), so this answers "which teams are
// strongest if everyone plays the simulation's best sets and adapts to each other", independent of today's ladder.
//
//   node sim/double-oracle.js --pool lambda --iters 15 --out out/double-oracle/run.json

const fs = require('fs');
const path = require('path');
const {mulberry32, hash, seedFrom, isFailed} = require('./util');
const {TeamSearch, teamSets, teamKey, builderTeams} = require('./team-search');
const {solve} = require('./nash');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };

async function main() {
	const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
	const OUT = path.resolve(arg('out', 'out/double-oracle/run.json'));
	const PAIR_GAMES = Number(arg('pair-games', 300)); // per ordered pair of teams (mirrored: half from each side)
	const EPS = Number(arg('eps', 0.01));
	const STRONG = arg('strong', 'rollout4all');
	// payoff of a pair of teams: 'preview' (default) = the team-preview game's equilibrium value (sim/preview-game.js);
	// 'battle' = plain 6v6 battles, where each pilot always brings the same three against a given team
	const PAYOFF = arg('payoff', 'preview');
	// the best-response search plays with a randomized preview (sim/battle.js stochasticPreview), so it can't win by
	// beating one fixed pick; PREVIEW_TEMP 0 turns that off
	const PREVIEW_TEMP = Number(arg('preview-temp', 1));
	const {previewValue} = require('./preview-game');
	let previewBattles = {fast: 0, strong: 0};
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
	pool = require('./checkpoint').wrap(pool, arg('checkpoint')); // --checkpoint file: resumable (sim/checkpoint.js)
	const t0 = Date.now();
	const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

	const pop = []; // {team, sets, label}
	const M = []; // M[i][j] = win rate of team i against team j
	let strongBattles = 0;
	/** Play team i against every earlier team j (mirrored seeds), filling M. */
	async function addTeam(team, label) {
		const i = pop.length;
		pop.push({team, sets: teamSets(results, team), label});
		M[i] = [];
		M[i][i] = 0.5;
		if (!i) return;
		const rng = mulberry32(hash(teamKey(team)) + 17);
		if (PAYOFF === 'preview') {
			await Promise.all(pop.slice(0, i).map(async (q, j) => {
				const r = await previewValue(pool, pop[i].sets, q.sets, mulberry32(hash(teamKey(team) + '|' + teamKey(q.team))), {
					strong: STRONG, screenGames: Number(arg('screen-games', 4)), strongGames: Number(arg('strong-games', 12)), keep: Number(arg('keep', 6))});
				previewBattles.fast += r.battles.fast; previewBattles.strong += r.battles.strong;
				M[i][j] = r.value;
				M[j][i] = 1 - r.value;
			}));
			return;
		}
		const jobs = [], meta = [];
		for (let j = 0; j < i; j++) {
			for (let g = 0; g < PAIR_GAMES / 2; g++) {
				const seed = seedFrom(rng);
				// same seed from both sides cancels side and dice luck
				jobs.push({a: pop[i].sets, b: pop[j].sets, seed, agents: [STRONG, STRONG]}); meta.push({j, iIsA: true});
				jobs.push({a: pop[j].sets, b: pop[i].sets, seed, agents: [STRONG, STRONG]}); meta.push({j, iIsA: false});
			}
		}
		strongBattles += jobs.length;
		const res = await pool.run(jobs, 2);
		const acc = new Map();
		res.forEach((r, k) => {
			if (isFailed(r)) return;
			const {j, iIsA} = meta[k];
			const win = r === null ? 0.5 : (r === (iIsA ? 0 : 1) ? 1 : 0);
			const a = acc.get(j) || {w: 0, g: 0};
			a.w += win; a.g++;
			acc.set(j, a);
		});
		for (let j = 0; j < i; j++) {
			const a = acc.get(j) || {w: 0.5, g: 1};
			M[i][j] = a.w / a.g;
			M[j][i] = 1 - M[i][j];
		}
	}
	const solveMix = () => {
		const r = solve(M.map(row => row.slice()), {iters: 20000, tol: 1e-5});
		return {x: r.x, value: r.value, gap: r.gap};
	};
	let status = {}; // converged / reason, kept for the final save
	const save = (extra = {}) => {
		if ('converged' in extra) status = {converged: extra.converged, reason: extra.reason};
		fs.mkdirSync(path.dirname(OUT), {recursive: true});
		const mix = pop.length ? solveMix() : {x: []};
		fs.writeFileSync(OUT, JSON.stringify({results: results.meta.generatedAt, payoff: PAYOFF, pairGames: PAIR_GAMES, eps: EPS, strongBattles, previewBattles,
			population: pop.map((p, i) => ({label: p.label, team: p.team, sets: p.sets, weight: +(mix.x[i] || 0).toFixed(4)})),
			matrix: M.map(r => r.map(v => +v.toFixed(4))), ...status, ...extra}, null, 1));
	};

	// seed population: the Team Builder's teams (with and without its Mega preferences)
	// --resume earlier-run.json: continue from its population and payoff matrix (saved at each iteration's start),
	// e.g. after a Spot reclaim; it must come from the same --results
	const resumed = arg('resume') && fs.existsSync(path.resolve(arg('resume'))) ? JSON.parse(fs.readFileSync(path.resolve(arg('resume')), 'utf8')) : null;
	if (resumed && resumed.results !== results.meta.generatedAt) throw new Error('--resume file is from other results');
	const candidates = [...results.entries].sort((a, b) => b.rating - a.rating).slice(0, Number(arg('candidates', 80))).map(e => e.id);
	let ts = null;
	let firstIt = 0;
	if (resumed) {
		for (const p of resumed.population) pop.push({team: p.team, sets: p.sets, label: p.label});
		resumed.matrix.forEach((r, i) => { M[i] = r.slice(); });
		firstIt = resumed.iteration || 0;
		log(`resumed ${pop.length} teams at iteration ${firstIt}`);
	} else {
		const seeds = await builderTeams(results, Number(arg('seeds', 6)));
		for (const t of seeds) { await addTeam(t, 'builder'); }
		log(`seeded ${pop.length} builder teams`);
	}
	const iters = Number(arg('iters', 15));
	const scale = Number(arg('scale', 1));
	for (let it = firstIt; it < iters; it++) {
		const mix = solveMix();
		const support = pop.map((p, i) => ({i, w: mix.x[i]})).filter(s => s.w > 0.01).sort((a, b) => b.w - a.w);
		log(`iter ${it}: population ${pop.length}, support ${support.map(s => `#${s.i}:${(100 * s.w).toFixed(0)}%`).join(' ')}`);
		save({iteration: it});
		const sample = rng => {
			let r = rng();
			for (const s of support) if ((r -= s.w) <= 0) return pop[s.i].sets;
			return pop[support[0].i].sets;
		};
		// --search-suffix overrides the pilots' preview in the best-response search (e.g. ~v: the 1v1-matrix preview)
		const sfx = arg('search-suffix', PREVIEW_TEMP > 0 ? `~p${PREVIEW_TEMP}` : '');
		ts = new TeamSearch({pool, results, opponent: sample, candidates, log: m => log('  ' + m), fast: `heuristic2${sfx}`, strong: `${STRONG}${sfx}`,
			size: {screen: Math.round(120 * scale), refine: Math.round(400 * scale), confirm: Math.round(1000 * scale)}});
		// best response: search from the strongest support team, then (--br-starts K) from up to K-1 more population
		// teams, best first against the mix, until one beats the mix by more than eps
		const valueVsMix = i => support.reduce((a, s) => a + s.w * M[i][s.i], 0);
		const starts = [support[0].i, ...pop.map((p, i) => i).filter(i => i !== support[0].i).sort((a, b) => valueVsMix(b) - valueVsMix(a))]
			.slice(0, Math.max(1, Number(arg('br-starts', 1))));
		let brValue = -1, found = 0;
		for (const st of starts) {
			const r = await ts.search(pop[st].team, it, Number(arg('steps', 12)));
			const br = r.team;
			if (pop.some(p => teamKey(p.team) === teamKey(br))) {
				log(`best response from #${st} is already in the population (${ts.describe(br)})`);
				continue;
			}
			await addTeam(br, `br${it}${found ? String.fromCharCode(97 + found) : ''}`);
			found++;
			const v = valueVsMix(pop.length - 1);
			log(`best response from #${st} ${ts.describe(br)}: ${(100 * v).toFixed(1)}% against the mix`);
			brValue = Math.max(brValue, v);
			if (v - 0.5 >= EPS) break;
		}
		if (!found) {
			log('no search start found a team outside the population: no improving team found');
			save({iteration: it, converged: true, reason: 'search found no improving team'});
			break;
		}
		if (brValue - 0.5 < EPS) {
			save({iteration: it, converged: true, reason: `best response gains ${(100 * (brValue - 0.5)).toFixed(1)} pp < eps`});
			log('converged');
			break;
		}
	}
	const mix = solveMix();
	save({final: true});
	log('equilibrium mix:');
	pop.map((p, i) => ({p, w: mix.x[i], i})).filter(x => x.w > 0.01).sort((a, b) => b.w - a.w)
		.forEach(x => log(`  ${(100 * x.w).toFixed(1)}%  #${x.i} ${x.p.label}  ${ts ? ts.describe(x.p.team) : ''}`));
	log(`done: ${strongBattles + previewBattles.strong} strong battles for the matrix${ts ? ` + search battles` : ''}; failed ${pool.failed || 0}`);
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
