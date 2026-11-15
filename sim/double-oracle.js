'use strict';
// "Theoretically strongest" teams: an approximate equilibrium of the team-choice game, by double oracle.
//
// Team choice is a symmetric zero-sum game (both players pick six from the same roster, then play), so the strongest
// strategy is an equilibrium mix of teams, not one team against a fixed field. Double oracle builds it:
//   1. a population of teams, and their payoff matrix (each pair's win rate, strong pilot, mirrored games)
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
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();
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
	const save = (extra = {}) => {
		fs.mkdirSync(path.dirname(OUT), {recursive: true});
		const mix = pop.length ? solveMix() : {x: []};
		fs.writeFileSync(OUT, JSON.stringify({results: results.meta.generatedAt, pairGames: PAIR_GAMES, eps: EPS, strongBattles,
			population: pop.map((p, i) => ({label: p.label, team: p.team, sets: p.sets, weight: +(mix.x[i] || 0).toFixed(4)})),
			matrix: M.map(r => r.map(v => +v.toFixed(4))), ...extra}, null, 1));
	};

	// seed population: the Team Builder's teams (with and without its Mega preferences)
	const seeds = await builderTeams(results, Number(arg('seeds', 6)));
	const candidates = [...results.entries].sort((a, b) => b.rating - a.rating).slice(0, Number(arg('candidates', 80))).map(e => e.id);
	let ts = null;
	for (const t of seeds) { await addTeam(t, 'builder'); }
	log(`seeded ${pop.length} builder teams`);
	const iters = Number(arg('iters', 15));
	const scale = Number(arg('scale', 1));
	for (let it = 0; it < iters; it++) {
		const mix = solveMix();
		const support = pop.map((p, i) => ({i, w: mix.x[i]})).filter(s => s.w > 0.01).sort((a, b) => b.w - a.w);
		log(`iter ${it}: population ${pop.length}, support ${support.map(s => `#${s.i}:${(100 * s.w).toFixed(0)}%`).join(' ')}`);
		save({iteration: it});
		const sample = rng => {
			let r = rng();
			for (const s of support) if ((r -= s.w) <= 0) return pop[s.i].sets;
			return pop[support[0].i].sets;
		};
		ts = new TeamSearch({pool, results, opponent: sample, candidates, log: m => log('  ' + m),
			size: {screen: Math.round(120 * scale), refine: Math.round(400 * scale), confirm: Math.round(1000 * scale)}});
		// best response from the strongest support team (and the best builder team not in the support)
		const r = await ts.search(pop[support[0].i].team, it, Number(arg('steps', 12)));
		const br = r.team;
		if (pop.some(p => teamKey(p.team) === teamKey(br))) {
			log(`best response is already in the population (${ts.describe(br)}): no improving team found`);
			save({iteration: it, converged: true, reason: 'search found no improving team'});
			break;
		}
		await addTeam(br, `br${it}`);
		const i = pop.length - 1;
		const brValue = support.reduce((a, s) => a + s.w * M[i][s.i], 0);
		log(`best response ${ts.describe(br)}: ${(100 * brValue).toFixed(1)}% against the mix`);
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
	log(`done: ${strongBattles} strong battles for the matrix${ts ? ` + search battles` : ''}; failed ${pool.failed || 0}`);
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
