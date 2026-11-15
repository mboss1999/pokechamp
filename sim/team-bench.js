'use strict';
// Team-level benchmark: are the Team Builder's teams as strong as the teams strong ladder players actually bring?
//
// Field: real teams from Showdown replays of the format (team preview gives the 6 species; Mega Evolution, moves
// and items are filled in from what the replay reveals, the rest from the ladder's modal set, sim/ladderstats.js).
// Only the side of each replay whose ladder rating is at least --min-rating is used.
//
// Every team (ours and the real ones) plays a round robin against the real teams, both sides piloted by the same AI
// (bring 6, pick 3), sides swapped every other game. A real team scores ~50% against its own field by symmetry,
// so our teams' score against it says how they compare with a typical strong ladder team, and the real teams' spread
// says how far above typical they are.
//
//   curl replays: https://replay.pokemonshowdown.com/search.json?user=<id>&format=<format>, then <id>.log
//   node sim/team-bench.js --replays dir --stats chaos.json --agent rollout4all --games 2 --pool lambda
//   --results other/results.json benchmarks the teams built from other simulation results.

const fs = require('fs');
const path = require('path');
const {pathToFileURL} = require('url');
const F = require('./format');
const {dex, toID} = F;
const {mulberry32, hash, seedFrom, clean, isFailed} = require('./util');
const {toPokemonSet} = require('./refine');
const {loadLadder} = require('./ladderstats');

const argv = process.argv.slice(2);
const arg = (name, def) => {
	const i = argv.indexOf('--' + name);
	return i >= 0 ? argv[i + 1] : def;
};
const RESULTS_PATH = path.resolve(arg('results', path.join(__dirname, '..', 'web', 'data', 'results.json')));
const RESULTS = JSON.parse(fs.readFileSync(RESULTS_PATH, 'utf8'));
const AGENT = arg('agent', 'heuristic2');
const GAMES = Number(arg('games', 2));
const MIN_RATING = Number(arg('min-rating', 1250));
const OUT = path.resolve(arg('out', `out/team-bench/${AGENT}.json`));
// --no-rr skips the real teams' own round robin (their percentiles), which is most of the battles
const NO_RR = argv.includes('--no-rr');
const entries = RESULTS.entries;
const ladder = loadLadder(path.resolve(arg('stats')), entries);
const ladderBy = new Map(ladder.list.filter(x => !x.problems).map(x => [toID(x.name), x]));
const entryBy = new Map(entries.map(e => [toID(e.mega || e.species), e]));

/** One real team from a replay side: [{species (battle forme), moves:Set, item}] */
function parseReplay(text) {
	const lines = text.split('\n');
	const sides = {p1: {rating: 0, team: [], nick: new Map()}, p2: {rating: 0, team: [], nick: new Map()}};
	for (const l of lines) {
		const p = l.split('|');
		if (p[1] === 'player' && sides[p[2]] && p[5]) sides[p[2]].rating = Number(p[5]) || 0;
		if (p[1] === 'poke' && sides[p[2]]) sides[p[2]].team.push({species: p[3].split(',')[0], moves: new Set(), item: null});
		const who = p[2] && /^p[12]a: /.test(p[2]) ? p[2].slice(0, 2) : null;
		if (!who) continue;
		const nick = p[2].slice(5);
		const side = sides[who];
		if (p[1] === 'switch' || p[1] === 'drag' || p[1] === 'detailschange') {
			const sp = p[3].split(',')[0];
			const base = dex.species.get(sp).baseSpecies;
			let m = side.team.find(t => t.species === sp || dex.species.get(t.species).baseSpecies === base);
			if (m) {
				if (p[1] === 'detailschange') m.species = sp; // Mega Evolution
				side.nick.set(nick, m);
			}
		}
		const m = side.nick.get(nick);
		if (!m) continue;
		if (p[1] === 'move' && !l.includes('[from]')) m.moves.add(toID(p[3]));
		if ((p[1] === '-enditem' || p[1] === '-item') && !l.includes('[from] move:')) m.item = m.item || p[3];
	}
	return Object.values(sides).filter(s => s.rating >= MIN_RATING && s.team.length === 6);
}

/** A PokemonSet for one real team member, or null. */
function realSet(m, usedItems) {
	const x = ladderBy.get(toID(m.species));
	const e = entryBy.get(toID(m.species));
	if (!e) return null;
	const base = x ? x.set : clean(toPokemonSet(e, e.set));
	const learn = new Set(F.learnableMoves(dex.species.get(e.species)).map(mv => mv.id));
	const moves = [...m.moves].filter(id => learn.has(id)).slice(0, 4);
	const fill = x ? Object.keys(x.moveShare) : base.moves.map(toID);
	for (const id of fill) if (moves.length < 4 && !moves.includes(toID(id))) moves.push(toID(id));
	const set = {...base, moves: moves.map(id => dex.moves.get(id).name)};
	if (e.megaItem) set.item = e.megaItem;
	else if (m.item && dex.items.get(m.item).exists) set.item = dex.items.get(m.item).name;
	if (usedItems.has(set.item)) {
		const alt = x && Object.keys(x.itemShare).map(i => dex.items.get(i)).find(i => i.exists && !usedItems.has(i.name) && !i.megaStone);
		set.item = alt ? alt.name : '';
	}
	if (F.validateSet(JSON.parse(JSON.stringify(set)))) return x && !usedItems.has(x.set.item) ? clean(x.set) : null;
	return clean(set);
}

function realTeams(dir) {
	const out = [], seen = new Set();
	for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.log'))) {
		for (const side of parseReplay(fs.readFileSync(path.join(dir, f), 'utf8'))) {
			const used = new Set();
			const team = [];
			// Megas first so their stones are placed before items are deduplicated
			for (const m of side.team.slice().sort((a, b) => (/-Mega/.test(b.species) ? 1 : 0) - (/-Mega/.test(a.species) ? 1 : 0))) {
				const s = realSet(m, used);
				if (!s) break;
				used.add(s.item);
				team.push(s);
			}
			if (team.length !== 6 || F.validateTeam(team)) continue;
			const key = team.map(s => s.species + (s.item.endsWith('ite') ? '*' : '')).sort().join();
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({label: `${f.replace('.log', '')} (${side.rating})`, rating: side.rating, team});
		}
	}
	return out;
}

async function main() {
	const real = realTeams(path.resolve(arg('replays')));
	const {buildTeams, assignSets, makeScorer} = await import(pathToFileURL(path.join(__dirname, '..', 'web', 'team.js')).href);
	const all = new Set(entries.map(e => e.species)); // the whole roster as the collection
	const ours = buildTeams(RESULTS, all, {scorer: makeScorer(RESULTS), teams: Number(arg('teams', 5)), includeMegas: true})
		.filter(t => t.members.length === 6)
		.map((t, k) => ({label: `builder #${k + 1}`, ours: true,
			team: assignSets(RESULTS, t.members).map(m => clean(toPokemonSet(m.entry, m.set)))}));
	console.log(`${real.length} real teams (rating >= ${MIN_RATING}), ${ours.length} builder teams`);
	for (const t of ours) console.log(`  ${t.label}: ${t.team.map(s => s.species + (s.item.match(/ite( [XYZ])?$/) ? '-Mega' : '')).join(', ')}`);
	if (argv.includes('--print')) {
		for (const t of real.slice(0, 10)) console.log(`  ${t.label}: ${t.team.map(s => `${s.species}@${s.item}`).join(', ')}`);
		return;
	}
	let pool;
	if (arg('pool', 'local') === 'lambda') {
		const {LambdaPool} = require('./lambdapool');
		pool = new LambdaPool({concurrency: Number(arg('concurrency', 500))});
		await pool.check();
	} else pool = new (require('./pool').Pool)();

	const teams = [...ours, ...real];
	const rng = mulberry32(hash('team-bench') + Number(arg('salt', 0)));
	const jobs = [], meta = [];
	// every team against every real team (a real team doesn't play itself)
	for (let i = 0; i < teams.length; i++) {
		for (let j = ours.length; j < teams.length; j++) {
			if (i === j || (i >= ours.length && j < i)) continue; // real pairs once
			if (NO_RR && i >= ours.length) continue; // --no-rr: only our teams against the real ones
			for (let g = 0; g < GAMES; g++) {
				const flip = g % 2 === 1;
				jobs.push({a: flip ? teams[j].team : teams[i].team, b: flip ? teams[i].team : teams[j].team,
					seed: seedFrom(rng), agents: [AGENT, AGENT]});
				meta.push({i, j, flip});
			}
		}
	}
	const t0 = Date.now();
	console.log(`${jobs.length} battles with ${AGENT}`);
	const res = await pool.run(jobs, AGENT.startsWith('rollout') ? 2 : 8);
	const score = teams.map(() => ({w: 0, g: 0}));
	res.forEach((r, k) => {
		if (isFailed(r)) return;
		const {i, j, flip} = meta[k];
		const iWon = r === null ? 0.5 : (r === (flip ? 1 : 0) ? 1 : 0);
		score[i].w += iWon; score[i].g++;
		if (j >= ours.length && i >= ours.length) { score[j].w += 1 - iWon; score[j].g++; }
	});
	const rate = s => s.w / (s.g || 1);
	const realRates = real.map((t, k) => rate(score[ours.length + k])).sort((a, b) => a - b);
	const pct = x => NO_RR ? null : realRates.filter(r => r < x).length / realRates.length;
	const report = {agent: AGENT, games: GAMES, results: RESULTS.meta.generatedAt, realTeams: real.length, minRating: MIN_RATING,
		ours: ours.map((t, k) => ({label: t.label, team: t.team, winRate: +rate(score[k]).toFixed(4), games: score[k].g,
			se: +Math.sqrt(rate(score[k]) * (1 - rate(score[k])) / (score[k].g || 1)).toFixed(4), percentile: pct(rate(score[k]))})),
		real: real.map((t, k) => ({label: t.label, species: t.team.map(s => s.species), winRate: +rate(score[ours.length + k]).toFixed(4), games: score[ours.length + k].g})),
		realQuantiles: NO_RR ? null : [0.1, 0.25, 0.5, 0.75, 0.9].map(q => +realRates[Math.floor(q * (realRates.length - 1))].toFixed(3)),
		failed: pool.failed || 0};
	fs.mkdirSync(path.dirname(OUT), {recursive: true});
	fs.writeFileSync(OUT, JSON.stringify(report, null, 1));
	for (const o of report.ours) console.log(`${o.label}: ${(100 * o.winRate).toFixed(1)}% ± ${(100 * o.se).toFixed(1)} vs real teams (${o.games} games)` +
		(o.percentile === null ? '' : `, percentile ${(100 * o.percentile).toFixed(0)} among real teams`));
	if (report.realQuantiles) console.log(`real teams' win rate quantiles (10/25/50/75/90%): ${report.realQuantiles.map(x => (100 * x).toFixed(1)).join(' / ')}`);
	console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s; failed ${pool.failed || 0}`);
	pool.close();
}

main().catch(e => { console.error(e); process.exit(1); });
