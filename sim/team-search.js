'use strict';
// Team search by simulation: find the six that win most against a given field, judged by full 6v6 bring-3 battles.
//
// The Team Builder (web/team.js) scores teams with a static model (1v1 matchups of best sets, weighted by threat).
// This searches teams directly on the objective: win rate against a field of opponent teams. Each step tries every
// single-member swap (any of the top candidate entries, with whichever of its sets keeps Item Clause) and every
// alternative set of the current members, all on identical battles:
//   screen   every neighbour, fast pilot (heuristic2), small paired sample
//   refine   the best few, strong pilot, fresh paired sample
//   confirm  the best against the current team, strong pilot, fresh sample; switch only on a one-sided 95% win
// until a whole round over the six slots changes nothing. The pilot study (README, Pilot convergence) found that
// a stronger pilot than rollout4all does not change team choices, so it decides.
//
// Fields:
//   ladder      sim/field.js: the real ladder (in-game Champions ranked data, Showdown stats and replay teams)
//   population  a JSON file of weighted teams [{team: PokemonSet[6], w}] (sim/double-oracle.js passes its mix)
//
//   node sim/team-search.js --field ladder --ingame out/field/ingame-20261115 --chaos chaos.json \
//     --replays out/team-bench/replays --starts 3 --pool lambda --out out/team-search/ladder.json

const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const F = require('./format');
const {dex} = F;
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');
const {toPokemonSet} = require('./refine');

const mean = xs => { const f = xs.filter(Number.isFinite); return f.reduce((a, b) => a + b, 0) / (f.length || 1); };
function paired(a, b) {
	const d = a.map((x, i) => x - b[i]).filter(Number.isFinite);
	const m = d.reduce((x, y) => x + y, 0) / (d.length || 1);
	const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length - 1));
	return {diff: m, se: sd / Math.sqrt(d.length || 1), n: d.length};
}

/** A team: [{entryId, setIndex}] -> PokemonSet[] (setIndex 0 = best set, k = k-th alternative). */
function teamSets(results, team) {
	const byId = new Map(results.entries.map(e => [e.id, e]));
	return team.map(m => {
		const e = byId.get(m.entryId);
		return clean(toPokemonSet(e, [e.set, ...e.alts][m.setIndex]));
	});
}
const teamKey = team => team.map(m => `${m.entryId}#${m.setIndex}`).sort().join(',');

class TeamSearch {
	/**
	 * @param {object} o
	 * @param {object} o.pool     sim/pool.js Pool or LambdaPool
	 * @param {object} o.results  results.json
	 * @param {function} o.opponent (rng) -> PokemonSet[6], the field
	 * @param {string[]} o.candidates entry ids a swap may bring in
	 * @param {object} [o.size]   sample sizes {screen, refine, confirm, keep}
	 */
	constructor({pool, results, opponent, candidates, fast = 'heuristic2', strong = 'rollout4all', size = {}, maxMegas = 2, log = () => {}}) {
		Object.assign(this, {pool, results, opponent, candidates, fast, strong, maxMegas, log});
		this.size = {screen: 120, keep: 4, refine: 400, confirm: 1000, ...size};
		this.byId = new Map(results.entries.map(e => [e.id, e]));
		this.battles = {fast: 0, strong: 0};
	}

	valid(team) {
		const species = new Set(), items = new Set();
		let megas = 0;
		for (const m of team) {
			const e = this.byId.get(m.entryId);
			const d = [e.set, ...e.alts][m.setIndex];
			if (!d || species.has(e.species) || (d.item && items.has(d.item))) return false;
			species.add(e.species); items.add(d.item);
			if (e.megaItem) megas++;
		}
		return megas <= this.maxMegas;
	}

	/** The set of entry `id` that keeps Item Clause with the rest of the team, or -1. */
	fitSet(team, slot, id) {
		const e = this.byId.get(id);
		const items = new Set(team.filter((_, j) => j !== slot).map(m => { const x = this.byId.get(m.entryId); return [x.set, ...x.alts][m.setIndex].item; }));
		return [e.set, ...e.alts].findIndex(d => !d.item || !items.has(d.item));
	}

	contexts(rng, n) {
		return Array.from({length: n}, () => ({opp: this.opponent(rng), seed: seedFrom(rng), flip: rng() < 0.5}));
	}

	/** Win of every team in every context (identical battles across teams). */
	async play(teams, ctxs, agent) {
		const jobs = [];
		for (const t of teams) {
			const mine = teamSets(this.results, t);
			for (const c of ctxs) jobs.push({a: c.flip ? c.opp : mine, b: c.flip ? mine : c.opp, seed: c.seed, agents: [agent, agent]});
		}
		this.battles[agent === this.strong ? 'strong' : 'fast'] += jobs.length;
		const res = await this.pool.run(jobs, agent.startsWith('rollout') ? 2 : 8);
		return teams.map((t, ti) => ctxs.map((c, k) => {
			const r = res[ti * ctxs.length + k];
			if (isFailed(r)) return NaN;
			if (r === null) return 0.5;
			return r === (c.flip ? 1 : 0) ? 1 : 0;
		}));
	}

	neighbours(team) {
		const out = [], seen = new Set([teamKey(team)]);
		const push = t => { const k = teamKey(t); if (!seen.has(k) && this.valid(t)) { seen.add(k); out.push(t); } };
		team.forEach((m, slot) => {
			const e = this.byId.get(m.entryId);
			// another set of the same member
			for (let k = 0; k <= e.alts.length; k++) if (k !== m.setIndex) push(team.map((x, j) => j === slot ? {entryId: x.entryId, setIndex: k} : x));
			// another member
			for (const id of this.candidates) {
				const c = this.byId.get(id);
				if (!c || team.some((x, j) => j !== slot && this.byId.get(x.entryId).species === c.species)) continue;
				const k = this.fitSet(team, slot, id);
				if (k >= 0) push(team.map((x, j) => j === slot ? {entryId: id, setIndex: k} : x));
			}
		});
		return out;
	}

	describe(team) {
		return team.map(m => { const e = this.byId.get(m.entryId); return `${e.mega || e.species}${m.setIndex ? `(alt${m.setIndex})` : ''}`; }).join(', ');
	}

	/** Local search from `start`. Returns {team, history}. */
	async search(start, salt = 0, maxSteps = 12) {
		const rng = mulberry32(hash(teamKey(start)) + 7919 * salt);
		let cur = start;
		const history = [];
		for (let step = 0; step < maxSteps; step++) {
			const nb = this.neighbours(cur);
			if (!nb.length) break;
			let ctxs = this.contexts(rng, this.size.screen);
			let w = await this.play([cur, ...nb], ctxs, this.fast);
			const screened = nb.map((t, i) => ({t, d: mean(w[i + 1]) - mean(w[0])})).sort((a, b) => b.d - a.d);
			const top = screened.slice(0, this.size.keep).map(x => x.t);
			ctxs = this.contexts(rng, this.size.refine);
			w = await this.play([cur, ...top], ctxs, this.strong);
			const refined = top.map((t, i) => ({t, ...paired(w[i + 1], w[0])})).sort((a, b) => b.diff - a.diff);
			const best = refined[0];
			ctxs = this.contexts(rng, this.size.confirm);
			w = await this.play([cur, best.t], ctxs, this.strong);
			const conf = paired(w[1], w[0]);
			const ok = conf.diff - 1.645 * conf.se > 0;
			this.log(`step ${step}: ${nb.length} neighbours; best ${this.describe(best.t)} ${(100 * conf.diff).toFixed(1)} ± ${(100 * conf.se).toFixed(1)}` +
				` (cur ${(100 * mean(w[0])).toFixed(1)}%) ${ok ? 'ACCEPT' : 'stop'}  [fast ${this.battles.fast}, strong ${this.battles.strong}]`);
			if (!ok) break;
			history.push({from: this.describe(cur), to: this.describe(best.t), diff: +conf.diff.toFixed(4), se: +conf.se.toFixed(4), wr: +mean(w[1]).toFixed(4)});
			cur = best.t;
		}
		return {team: cur, history};
	}

	/** Strong-pilot win rates of several teams on one fresh paired sample. */
	async judge(teams, n, salt = 99) {
		const rng = mulberry32(hash('judge') + salt);
		const ctxs = this.contexts(rng, n);
		const w = await this.play(teams, ctxs, this.strong);
		return teams.map((t, i) => ({wr: +mean(w[i]).toFixed(4), se: +(Math.sqrt(mean(w[i]) * (1 - mean(w[i])) / n)).toFixed(4), vsFirst: i ? paired(w[i], w[0]) : null}));
	}
}

async function builderTeams(results, k) {
	const {buildTeams, makeScorer, assignSets} = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'team.js')).href);
	const all = new Set(results.entries.map(e => e.species));
	return buildTeams(results, all, {scorer: makeScorer(results), teams: k, includeMegas: true})
		.filter(t => t.members.length === 6)
		.map(t => assignSets(results, t.members).map(m => ({entryId: m.entry.id,
			setIndex: [m.entry.set, ...m.entry.alts].indexOf(m.set)})));
}

module.exports = {TeamSearch, teamSets, teamKey, builderTeams};

if (require.main === module) {
	const argv = process.argv.slice(2);
	const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
	(async () => {
		const results = JSON.parse(fs.readFileSync(path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json'))), 'utf8'));
		let opponent;
		if (arg('field', 'ladder') === 'ladder') {
			const {Field} = require('./field');
			let replayTeams = [];
			if (arg('replays')) {
				// reuse the replay parser of sim/team-bench.js through a child-free import
				replayTeams = require('./team-bench-lib').realTeams(path.resolve(arg('replays')), results, arg('chaos'), Number(arg('min-rating', 1250))).map(t => t.team);
			}
			const field = new Field({results, ingame: arg('ingame'), chaos: arg('chaos'), replayTeams, replayShare: Number(arg('replay-share', 0.5))});
			opponent = rng => field.sample(rng);
		} else {
			const pop = JSON.parse(fs.readFileSync(path.resolve(arg('population')), 'utf8'));
			const tot = pop.reduce((a, b) => a + b.w, 0);
			opponent = rng => { let r = rng() * tot; for (const p of pop) if ((r -= p.w) <= 0) return p.team; return pop[pop.length - 1].team; };
		}
		const top = Number(arg('candidates', 80));
		const candidates = [...results.entries].sort((a, b) => b.rating - a.rating).slice(0, top).map(e => e.id);
		let pool;
		if (arg('pool', 'local') === 'lambda') {
			const {LambdaPool} = require('./lambdapool');
			pool = new LambdaPool({concurrency: Number(arg('concurrency', 600))});
			await pool.check();
		} else pool = new (require('./pool').Pool)();
		const t0 = Date.now();
		const log = m => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
		const scale = Number(arg('scale', 1));
		// --fast / --strong pilots, both sides (e.g. heuristic2~v / rollout4all~v: team preview from the 1v1 matrix)
		const ts = new TeamSearch({pool, results, opponent, candidates, log, fast: arg('fast', 'heuristic2'), strong: arg('strong', 'rollout4all'),
			size: {screen: Math.round(120 * scale), refine: Math.round(400 * scale), confirm: Math.round(1000 * scale)}});
		const starts = (await builderTeams(results, Number(arg('starts', 3)) * 2)).slice(0, Number(arg('starts', 3)));
		const found = [];
		for (let s = 0; s < starts.length; s++) {
			log(`start ${s + 1}: ${ts.describe(starts[s])}`);
			const r = await ts.search(starts[s], s, Number(arg('steps', 12)));
			found.push({start: starts[s], ...r});
		}
		const finals = [...starts, ...found.map(f => f.team)];
		const j = await ts.judge(finals, Number(arg('judge', 2000)));
		const report = {field: arg('field', 'ladder'), results: results.meta.generatedAt, battles: ts.battles, generatedAt: new Date().toISOString(),
			teams: finals.map((t, i) => ({kind: i < starts.length ? 'builder' : 'searched', team: ts.describe(t), members: t,
				sets: teamSets(results, t), winRate: j[i].wr, se: j[i].se})), searches: found.map(f => f.history)};
		fs.mkdirSync(path.dirname(path.resolve(arg('out', 'out/team-search/result.json'))), {recursive: true});
		fs.writeFileSync(path.resolve(arg('out', 'out/team-search/result.json')), JSON.stringify(report, null, 1));
		for (const t of report.teams) console.log(`${t.kind.padEnd(9)} ${(100 * t.winRate).toFixed(1)}% ± ${(100 * t.se).toFixed(1)}  ${t.team}`);
		console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s; ${ts.battles.fast} fast + ${ts.battles.strong} strong battles; failed ${pool.failed || 0}`);
		pool.close();
	})().catch(e => { console.error(e); process.exit(1); });
}
