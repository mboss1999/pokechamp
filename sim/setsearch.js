'use strict';
// Set search by coordinate descent with paired races (replaces the sets stage's random hill climb).
//
// The old search tried 6 random single changes twice per pass and kept whichever measured best on a noisy
// sample. The move-choice audit (sim/audit-moves.js, 2026-11-14) found that left dead move slots (Dragapult
// with Dragon Darts and Dragon Claw) and single-move changes worth 2-7 points of win rate. This search instead
// sweeps every dimension of a set in turn, with every alternative:
//
//   dimensions  each move slot, item, ability, spread (nature + stat points)
//   race        all alternatives and the current choice play the same battles (same partners, opponents, dice)
//               1. screen:  every alternative, small sample; keep the top few
//               2. refine:  those few on a fresh, larger sample; keep the best
//               3. confirm: best vs current on another fresh sample; switch only if it wins by a one-sided
//                  95% margin. Fresh samples at each step remove the winner's curse of picking a noisy maximum.
//   rounds      repeat the sweep until a whole round changes nothing (at most `rounds`)
//   redundancy  a move may not join an attack of the same type, category and priority (Dragon Darts + Dragon
//               Claw); a set that already has such a pair drops its weaker member unless that is clearly worse
//   strong      with a strong pilot (checkAgent, e.g. rollout4all), which the fast one can't replace on status moves
//   pilot       (on 12 test sets the fast pilot wanted to drop Swords Dance / Dragon Dance that rollout4all
//               valued at 5-7 points):
//               - a change that adds or removes a status move must also win with the strong pilot
//               - status pass: the 3 best-screened status moves get a strong-pilot race in the slot that was
//                 easiest to replace (the fast pilot's screen is biased against them too)
//               - final check: the result against the starting set; if clearly worse, the start is kept
//
// Battles: the subject plus 2 partners (fixed, so the subject always plays) against 6 opponents that pick 3,
// as in the sets stage. The caller supplies the context sampler.

const F = require('./format');
const {dex} = F;
const S = require('./sets');
const {clean, setKey, seedFrom, isFailed, mulberry32, hash} = require('./util');
const {knownStatus} = require('./agent');

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const ITEMS = ['Life Orb', 'Choice Scarf', 'Focus Sash', 'Leftovers', 'Sitrus Berry', 'Lum Berry', 'Expert Belt',
	'Shell Bell', 'Muscle Band', 'Wise Glasses', 'Scope Lens', 'Quick Claw', "King's Rock", 'Rocky Helmet', 'White Herb',
	'Mental Herb', 'Black Sludge', 'Light Clay', 'Air Balloon', 'Bright Powder', 'Wide Lens', 'Red Card'];

const sameRole = (a, b) => a.category !== 'Status' && b.category !== 'Status' && a.type === b.type &&
	a.category === b.category && a.priority === b.priority && !!a.selfSwitch === !!b.selfSwitch;

/** Moves worth trying on this entry: every status move the pilot understands, and the strongest attacks per type. */
function movePool(entry) {
	const species = dex.species.get(entry.species);
	const battleSpecies = dex.species.get(entry.battleSpecies);
	const b = battleSpecies.baseStats;
	const ctx = {types: battleSpecies.types, stab: 1.5, atk: b.atk, spa: b.spa, def: b.def};
	const learn = F.learnableMoves(species);
	const curated = new Set();
	for (const r of S.curatedRoles(battleSpecies.id) || S.curatedRoles(species.id) || []) {
		for (const m of r.movepool) curated.add(F.toID(m));
	}
	const out = new Map();
	for (const m of learn) {
		if (m.category === 'Status' && (knownStatus(m.id) || curated.has(m.id))) out.set(m.id, m);
	}
	const attacks = learn.filter(m => m.category !== 'Status' && !m.isZ &&
		(!S.BANNED_ATTACKS.has(m.id) || S.SPECIAL_POWER[m.id]) &&
		(m.basePower >= 40 || m.priority > 0 || S.SPECIAL_POWER[m.id] || m.multihit) &&
		(!m.flags.charge || S.SPECIAL_POWER[m.id]));
	// per type and category: the two strongest, plus every priority move, pivot and curated attack
	const groups = new Map();
	for (const m of attacks) {
		const k = `${m.type}|${m.category}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(m);
	}
	const weakCat = b.atk < b.spa * 0.75 ? 'Physical' : b.spa < b.atk * 0.75 ? 'Special' : null;
	for (const list of groups.values()) {
		list.sort((x, y) => S.attackPower(y, ctx) - S.attackPower(x, ctx));
		list.slice(0, list[0].category === weakCat ? 1 : 2).forEach(m => out.set(m.id, m));
	}
	for (const m of attacks) if (m.priority > 0 || m.selfSwitch || curated.has(m.id) || S.SPECIAL_POWER[m.id]) out.set(m.id, m);
	return [...out.values()];
}

/** Index of the weaker move of the first same-role pair in the set, or -1. */
function redundantSlot(moves) {
	const ms = moves.map(m => dex.moves.get(m));
	for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
		if (!sameRole(ms[i], ms[j])) continue;
		const pw = m => (S.SPECIAL_POWER[m.id] ?? m.basePower) * (m.multihit ? 2 : 1) * (m.accuracy === true ? 1 : m.accuracy / 100);
		return pw(ms[i]) <= pw(ms[j]) ? i : j;
	}
	return -1;
}

function spreadSet(set, name) {
	const sp = S.SPREADS[name];
	return {...set, spread: name, nature: sp.nature, evs: Object.fromEntries(STAT_KEYS.map(k => [k, sp.evs[k] || 0]))};
}

/** Alternatives to `set` along one dimension. */
function alternatives(entry, set, dim, pool) {
	const out = [];
	const push = s => {
		if (F.validateSet(clean(JSON.parse(JSON.stringify(s))))) return;
		s.key = setKey(s);
		if (s.key !== set.key && !out.some(o => o.key === s.key)) out.push(s);
	};
	if (typeof dim === 'number') {
		const have = set.moves.map(m => dex.moves.get(m));
		for (const m of pool) {
			if (have.some(h => h.id === m.id)) continue;
			if (have.some((h, j) => j !== dim && sameRole(h, m))) continue;
			const moves = set.moves.slice();
			moves[dim] = m.name;
			push({...set, moves});
		}
	} else if (dim === 'item') {
		if (entry.megaItem) return out;
		const types = new Set(set.moves.map(m => dex.moves.get(m)).filter(m => m.category !== 'Status').map(m => m.type));
		const typeItems = Object.entries(S.TYPE_ITEM || {}).filter(([t]) => types.has(t)).map(([, i]) => i);
		for (const item of [...ITEMS, ...typeItems]) if (item !== set.item) push({...set, item});
	} else if (dim === 'ability') {
		for (const a of new Set(Object.values(dex.species.get(entry.species).abilities))) if (a !== set.ability) push({...set, ability: a});
	} else if (dim === 'spread') {
		for (const name of Object.keys(S.SPREADS)) push(spreadSet(set, name));
	}
	return out;
}

const mean = xs => { const f = xs.filter(Number.isFinite); return f.reduce((a, b) => a + b, 0) / (f.length || 1); };
function paired(a, b) {
	const d = a.map((x, i) => x - b[i]).filter(Number.isFinite);
	const m = d.reduce((x, y) => x + y, 0) / (d.length || 1);
	const sd = Math.sqrt(d.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, d.length - 1));
	return {diff: m, se: sd / Math.sqrt(d.length || 1), n: d.length};
}

class SetSearch {
	/**
	 * @param {object} o
	 * @param {object} o.pool       sim/pool.js Pool or sim/lambdapool.js LambdaPool
	 * @param {function} o.context  (rng, subjectSet) => {partners: PokemonSet[][2], opps: PokemonSet[6]}; each partner
	 *                              is a list of its sets (best first), so a candidate's item can't break Item Clause
	 * @param {string} o.agent      pilot for the races (default heuristic2)
	 * @param {string} [o.checkAgent] stronger pilot for the final check (e.g. rollout4all); none if unset
	 * @param {number} o.scale      multiplies every sample size
	 */
	constructor({pool, context, agent = 'heuristic2', checkAgent = null, scale = 1, rounds = 3, log = () => {}}) {
		Object.assign(this, {pool, context, agent, checkAgent, rounds, log});
		const n = x => Math.max(8, Math.round(x * scale));
		this.size = {screen: n(40), keep: 4, refine: n(160), confirm: n(500), check: n(250), statusRefine: n(100)};
		this.battles = 0;
	}

	contexts(rng, subject, count) {
		return Array.from({length: count}, () => ({...this.context(rng, subject), seed: seedFrom(rng), flip: rng() < 0.5}));
	}

	/** Win (1 / 0.5 / 0, NaN if failed) of every set in every context, all on identical battles. */
	async play(sets, ctxs, agent = this.agent) {
		const jobs = [];
		for (const s of sets) {
			const mine = clean(s);
			for (const c of ctxs) {
				// each partner is a list of options; take the first that keeps Item Clause with this candidate
				const team = [mine, ...c.partners.map(opts => opts.find(p => !mine.item || p.item !== mine.item) || opts[0])];
				jobs.push({a: c.flip ? c.opps : team, b: c.flip ? team : c.opps, seed: c.seed, agents: [agent, agent]});
			}
		}
		this.battles += jobs.length;
		const res = await this.pool.run(jobs, 8);
		return sets.map((s, si) => ctxs.map((c, k) => {
			const r = res[si * ctxs.length + k];
			if (isFailed(r)) return NaN;
			if (r === null) return 0.5;
			return r === (c.flip ? 1 : 0) ? 1 : 0;
		}));
	}

	/**
	 * Race `cands` against `cur` (screen -> refine -> confirm, each on fresh battles). `agent` pilots every
	 * battle; `screen: false` skips straight to refining all candidates. Returns the confirmed winner (or null),
	 * the confirmation, and every screened and refined candidate's measured difference from `cur`.
	 */
	async race(rng, cur, cands, {lenient = false, agent = this.agent, screen = true, size = this.size} = {}) {
		let screened = [];
		let top = cands;
		if (screen) {
			const ctxs = this.contexts(rng, cur, size.screen);
			const w = await this.play([cur, ...cands], ctxs, agent);
			screened = cands.map((c, i) => ({set: c, d: mean(w[i + 1]) - mean(w[0])})).sort((a, b) => b.d - a.d);
			top = screened.slice(0, size.keep).map(x => x.set);
		}
		let ctxs = this.contexts(rng, cur, size.refine);
		let w = await this.play([cur, ...top], ctxs, agent);
		const refined = top.map((c, i) => ({set: c, ...paired(w[i + 1], w[0]), wr: mean(w[i + 1])})).sort((a, b) => b.diff - a.diff);
		const best = refined[0];
		ctxs = this.contexts(rng, cur, size.confirm);
		w = await this.play([cur, best.set], ctxs, agent);
		const conf = paired(w[1], w[0]);
		return {winner: accept(conf, lenient) ? best.set : null, confirm: conf, wrCur: mean(w[0]), wrBest: mean(w[1]), refined, screened};
	}

	/** Coordinate descent from `start`. Returns {best, wr, alts, history, check}. */
	async search(entry, start, salt = 0) {
		const rng = mulberry32(hash(entry.id) + 104729 * salt);
		const pool = movePool(entry);
		let cur = {...start, moves: start.moves.slice(), key: setKey(start)};
		const history = [];
		const strong = this.checkAgent;
		const z = this.size;
		const strongSize = {refine: z.statusRefine, confirm: z.check};
		let wr = null, itemRace = null;
		const note = (round, dim, from, to, conf, agent) => {
			history.push({round, dim, change: describeDiff(from, to), diff: +conf.diff.toFixed(4), se: +conf.se.toFixed(4), agent});
			this.log(`${entry.id}: ${describeDiff(from, to)} (${(100 * conf.diff).toFixed(1)} ± ${(100 * conf.se).toFixed(1)}${agent !== this.agent ? `, ${agent}` : ''})`);
		};
		let slotRaces = [];
		for (let round = 0; round < this.rounds; round++) {
			let changed = false;
			slotRaces = [];
			const dims = [...cur.moves.keys(), 'item', 'ability', 'spread'];
			for (const dim of dims) {
				if (typeof dim === 'number' && dim >= cur.moves.length) continue;
				const cands = alternatives(entry, cur, dim, pool);
				if (!cands.length) continue;
				const lenient = typeof dim === 'number' && redundantSlot(cur.moves) === dim;
				const r = await this.race(rng, cur, cands, {lenient});
				if (typeof dim === 'number') slotRaces.push({dim, r});
				if (dim === 'item') itemRace = r;
				let winner = r.winner, conf = r.confirm, agent = this.agent;
				wr = winner ? r.wrBest : r.wrCur;
				// The fast pilot misjudges status moves (setup above all), so a change that adds or removes one
				// must also win with the strong pilot.
				if (winner && strong && touchesStatus(cur, winner)) {
					const v = await this.verify(rng, cur, winner, lenient);
					if (!v.ok) {
						this.log(`${entry.id}: ${describeDiff(cur, winner)} rejected by ${strong} (${(100 * v.conf.diff).toFixed(1)} ± ${(100 * v.conf.se).toFixed(1)})`);
						winner = null;
					} else { conf = v.conf; agent = strong; }
				}
				if (winner) {
					note(round, dim, cur, winner, conf, agent);
					cur = winner;
					changed = true;
				}
			}
			if (!changed) break;
		}
		// Status pass: the fast pilot's screen is also biased against status moves, so the most promising ones get
		// a race of their own with the strong pilot, in the slot the descent found easiest to replace.
		if (strong && slotRaces.length) {
			const weakest = slotRaces.filter(x => x.r.refined.length)
				.sort((a, b) => b.r.refined[0].diff - a.r.refined[0].diff)[0];
			if (weakest) {
				const slot = weakest.dim;
				const have = cur.moves.map(m => dex.moves.get(m));
				const statusIds = [];
				for (const x of weakest.r.screened) {
					const m = dex.moves.get(x.set.moves[slot]);
					if (m.category !== 'Status' || have.some(h => h.id === m.id) || statusIds.includes(m.id)) continue;
					statusIds.push(m.id);
					if (statusIds.length >= 3) break;
				}
				const cands = statusIds.map(id => {
					const moves = cur.moves.slice();
					moves[slot] = dex.moves.get(id).name;
					const s = {...cur, moves};
					s.key = setKey(s);
					return s;
				}).filter(s => !F.validateSet(clean(JSON.parse(JSON.stringify(s)))));
				if (cands.length) {
					const r = await this.race(rng, cur, cands, {agent: strong, screen: false, size: strongSize});
					if (r.winner) {
						note('status', slot, cur, r.winner, r.confirm, strong);
						cur = r.winner;
					}
				}
			}
		}
		let check = null;
		if (strong && history.length) {
			const ctxs = this.contexts(rng, cur, z.check);
			const w = await this.play([start, cur], ctxs, strong);
			check = paired(w[1], w[0]);
			check = {agent: strong, diff: +check.diff.toFixed(4), se: +check.se.toFixed(4), n: check.n};
			if (check.diff + 1.96 * check.se < 0) {
				this.log(`${entry.id}: ${strong} finds the searched set worse (${(100 * check.diff).toFixed(1)} ± ${(100 * check.se).toFixed(1)}); keeping the start`);
				check.reverted = true;
				cur = {...start, key: setKey(start)};
			}
		}
		// alternatives with other items (Item Clause): the best refined items from the last item race
		const alts = [];
		if (itemRace && !check?.reverted) {
			for (const r of itemRace.refined) {
				if (r.set.item === cur.item || alts.some(a => a.set.item === r.set.item)) continue;
				const set = {...cur, item: r.set.item};
				set.key = setKey(set);
				alts.push({set, wr: +((wr ?? 0) + r.diff).toFixed(4), games: r.n});
			}
		}
		return {best: cur, wr: +(wr ?? 0).toFixed(4), alts: alts.slice(0, 3), history, check};
	}

	/** Paired `cur` vs `next` with the strong pilot. */
	async verify(rng, cur, next, lenient) {
		const ctxs = this.contexts(rng, cur, this.size.check);
		const w = await this.play([cur, next], ctxs, this.checkAgent);
		const conf = paired(w[1], w[0]);
		return {ok: accept(conf, lenient), conf};
	}
}

/** One-sided 95% win; lenient (replacing a redundant move): not worse by half a point, nor significantly. */
const accept = (c, lenient) => lenient ? c.diff > -0.005 && c.diff + 1.645 * c.se > 0 : c.diff - 1.645 * c.se > 0;

/** Does going from set a to set b add or remove a status move? */
function touchesStatus(a, b) {
	const st = s => s.moves.map(m => dex.moves.get(m)).filter(m => m.category === 'Status').map(m => m.id).sort().join();
	return st(a) !== st(b);
}

function describeDiff(a, b) {
	const parts = [];
	const removed = a.moves.filter(m => !b.moves.includes(m)), added = b.moves.filter(m => !a.moves.includes(m));
	if (removed.length) parts.push(`${removed.join(', ')} -> ${added.join(', ')}`);
	if (a.item !== b.item) parts.push(`item ${a.item || 'none'} -> ${b.item || 'none'}`);
	if (a.ability !== b.ability) parts.push(`ability ${a.ability} -> ${b.ability}`);
	if (a.nature !== b.nature || JSON.stringify(a.evs) !== JSON.stringify(b.evs)) parts.push(`spread ${a.spread || a.nature} -> ${b.spread || b.nature}`);
	return parts.join('; ');
}

module.exports = {SetSearch, movePool, alternatives, redundantSlot, sameRole};
