'use strict';
// Doubles heuristic pilot ('dheuristic'): the singles agent's damage estimates and move values (sim/agent.js),
// plus what doubles adds: picking a target, spread moves (0.75x to each target, some also hit the partner),
// coordinating the two active Pokémon (no wasted attacks into a foe the partner already KOs, double-target KOs),
// and the doubles staples: Fake Out, Protect, Follow Me / Rage Powder, Helping Hand, Tailwind, Trick Room, Wide
// Guard, speed control. Like the singles agent it reads the live Battle (open team sheets: both sides see sets).
//
// 'dgreedy' is a baseline for tests: each slot clicks its most damaging attack into the foe it hurts most.

const A = require('./agent');
const {estDamage, moveValue, outspeeds, matchupScore, bestDamage} = A;

const PROTECT = new Set(['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'obstruct']);
const REDIRECT = new Set(['followme', 'ragepowder', 'spotlight']);
const SPEED_DROP = new Set(['icywind', 'electroweb', 'bulldoze', 'rocktomb', 'lowsweep', 'scaryface', 'stringshot']);
const FLINCH_IMMUNE = new Set(['innerfocus', 'shielddust', 'steadfast']);
// Single-target ranges (a target slot must be named)
const TARGETED = new Set(['normal', 'any', 'adjacentFoe']);

const alive = p => p && !p.fainted && p.hp > 0;
/** The target suffix a move needs when it isn't aimed at a foe ('' if none): allies and self are negative slots. */
function ownTarget(target, me, ally) {
	if (target === 'adjacentAlly') return ally ? ` -${ally.position + 1}` : null; // no partner: unusable
	if (target === 'adjacentAllyOrSelf') return ` -${me.position + 1}`;
	return '';
}
/** Locked into a move (charging, Outrage, ...): the request lists just that move, with no PP and no target. */
const locked = active => active.moves.length === 1 && active.moves[0].pp === undefined;
const foesOf = side => side.foe.active.filter(alive);
const allyOf = (side, me) => side.active.find(p => alive(p) && p !== me) || null;
const loc = p => p.position + 1; // a foe's target slot in a choice (allies are negative)

/** Fraction of `foe`'s current HP that `dmg` takes, and the KO bonus the singles agent gives. */
function hitValue(battle, me, foe, move, dmg, ctx) {
	let v = Math.min(dmg / foe.hp, 1);
	if (dmg >= foe.hp) {
		v += 0.4;
		if (move.priority > 0 || outspeeds(battle, me, foe)) v += 0.4;
	}
	return v;
}

/** Largest share of `me`'s current HP a single foe can take this turn, and the sum over both foes. */
function threatOn(battle, me, foes) {
	let max = 0, sum = 0;
	for (const f of foes) {
		const d = Math.min(bestDamage(battle, f, me).dmg / Math.max(1, me.hp), 1.5);
		max = Math.max(max, d); sum += d;
	}
	return {max, sum};
}

/** Every option for one active Pokémon: {choice, v, kind, target, dmg: Map foe -> damage}. */
function slotOptions(battle, side, i, req) {
	const me = side.active[i];
	const active = req.active[i];
	const foes = foesOf(side);
	const ally = allyOf(side, me);
	const myThreat = threatOn(battle, me, foes);
	const bench = side.pokemon.filter(p => alive(p) && !p.isActive);
	const ourSlow = foes.length && [me, ally].filter(Boolean).every(p => foes.some(f => outspeeds(battle, f, p)));
	const firstTurn = me.activeMoveActions === 0;
	const opts = [];
	if (locked(active)) return [{choice: 'move 1', v: 0, kind: 'locked'}];
	active.moves.forEach((m, j) => {
		if (m.disabled || (m.pp !== undefined && m.pp <= 0)) return;
		const move = battle.dex.moves.get(m.id);
		const n = j + 1;
		const target = m.target || move.target;
		if (move.category !== 'Status') {
			if ((move.id === 'fakeout' || move.id === 'firstimpression') && !firstTurn) return;
			if (TARGETED.has(target)) {
				for (const f of foes) {
					const ctx = {iAmFaster: outspeeds(battle, me, f), threatFrac: myThreat.max, benchCount: bench.length, v2: true};
					let v = moveValue(battle, me, f, move.id, ctx);
					const dmg = estDamage(battle, me, f, move.id);
					if (move.id === 'fakeout' && !FLINCH_IMMUNE.has(f.ability) && !f.hasType('Ghost')) {
						// a free turn: worth most against the foe that threatens us most
						v += 0.35 + 0.4 * Math.min(1, threatOn(battle, me, [f]).max + (ally ? threatOn(battle, ally, [f]).max : 0));
					}
					if (SPEED_DROP.has(move.id) && outspeeds(battle, f, me)) v += 0.1;
					opts.push({choice: `move ${n} ${loc(f)}`, v, kind: 'hit', target: f, dmg: new Map([[f, dmg]]), move});
				}
				return;
			}
			// spread moves: 0.75x to each target when there is more than one
			const hitsAlly = target === 'allAdjacent' && ally;
			const targets = (target === 'allAdjacentFoes' || target === 'allAdjacent') ? foes : foes.slice(0, 1);
			const nTargets = targets.length + (hitsAlly ? 1 : 0);
			const mult = nTargets > 1 ? 0.75 : 1;
			let v = 0;
			const dmgMap = new Map();
			for (const f of targets) {
				const d = estDamage(battle, me, f, move.id) * mult;
				dmgMap.set(f, d);
				v += hitValue(battle, me, f, move, d);
				if (SPEED_DROP.has(move.id) && outspeeds(battle, f, me)) v += 0.1;
			}
			if (hitsAlly) {
				const d = estDamage(battle, me, ally, move.id) * mult;
				const frac = Math.min(d / ally.hp, 1);
				v -= 1.3 * frac + (d >= ally.hp ? 1 : 0);
				opts.push({choice: `move ${n}`, v, kind: 'spread', dmg: dmgMap, move, allyDmg: d});
			} else {
				opts.push({choice: `move ${n}`, v, kind: 'spread', dmg: dmgMap, move});
			}
			return;
		}
		// status moves
		const id = move.id;
		const sc = side.sideConditions, fieldTR = !!battle.field.getPseudoWeather('trickroom');
		let v;
		if (PROTECT.has(id)) {
			const last = me.lastMove && PROTECT.has(me.lastMove.id) && me.moveLastTurnResult !== false;
			if (last) v = 0;
			else if (me.hasAbility('speedboost') && firstTurn) v = 0.5;
			else v = myThreat.sum >= 1.2 ? 0.55 : myThreat.max >= 1 ? 0.45 : myThreat.sum > 0.6 ? 0.2 : 0.03;
		} else if (REDIRECT.has(id)) {
			const allyThreat = ally ? threatOn(battle, ally, foes) : {max: 0, sum: 0};
			v = ally && allyThreat.sum >= 0.8 && myThreat.sum < 1 ? 0.5 : 0.05;
		} else if (id === 'helpinghand') {
			v = ally ? 0.15 : 0; // raised below once the partner's choice is known
		} else if (id === 'tailwind') {
			v = sc.tailwind ? 0 : (ourSlow && !fieldTR ? 0.7 : 0.2);
		} else if (id === 'trickroom') {
			v = fieldTR ? (ourSlow ? 0 : 0.4) : (ourSlow ? 0.75 : 0);
		} else if (id === 'wideguard') {
			const spread = foes.some(f => f.moveSlots.some(s => ['allAdjacentFoes', 'allAdjacent'].includes(battle.dex.moves.get(s.id).target)));
			v = spread && !(me.lastMove && me.lastMove.id === 'wideguard') ? 0.35 : 0;
		} else if (id === 'quickguard') {
			v = foes.some(f => f.moveSlots.some(s => battle.dex.moves.get(s.id).priority > 0)) ? 0.25 : 0;
		} else if (id === 'allyswitch' || id === 'coaching' || id === 'decorate' || id === 'aromaticmist') {
			v = 0.05;
		}
		if (v !== undefined) {
			const suffix = ownTarget(target, me, ally);
			if (suffix !== null) opts.push({choice: `move ${n}${suffix}`, v, kind: id, move});
			return;
		}
		// everything else: the singles rules against each foe it could target
		if (TARGETED.has(target) && foes.length) {
			for (const f of foes) {
				const ctx = {iAmFaster: outspeeds(battle, me, f), threatFrac: myThreat.max, benchCount: bench.length, v2: true};
				opts.push({choice: `move ${n} ${loc(f)}`, v: moveValue(battle, me, f, id, ctx), kind: 'status', target: f, move});
			}
		} else if (foes.length) {
			const f = foes[0];
			const ctx = {iAmFaster: outspeeds(battle, me, f), threatFrac: myThreat.max, benchCount: bench.length, v2: true};
			const suffix = ownTarget(target, me, ally);
			if (suffix !== null) opts.push({choice: `move ${n}${suffix}`, v: moveValue(battle, me, f, id, ctx), kind: 'status', move});
		}
	});
	// Switching: only when this Pokémon can do almost nothing and a benched one matches up clearly better.
	const canSwitch = !active.trapped && !active.maybeTrapped;
	const bestV = opts.reduce((b, o) => Math.max(b, o.v), 0);
	if (canSwitch && bench.length && bestV < 0.15 && foes.length) {
		const stay = foes.reduce((s, f) => s + matchupScore(battle, me, f), 0);
		bench.forEach(p => {
			const s = foes.reduce((t, f) => t + matchupScore(battle, p, f), 0);
			if (s > stay + 0.5) opts.push({choice: `switch ${side.pokemon.indexOf(p) + 1}`, v: 0.1 + 0.1 * (s - stay), kind: 'switch', pokemon: p});
		});
	}
	if (!opts.length) {
		// nothing scores (e.g. only Fake Out after the first turn): any usable move, aimed at a foe if it needs one
		opts.push({choice: anyMove(battle, me, active, foes, ally), v: 0, kind: 'default'});
	}
	return opts;
}

/** Any usable move with a legal target, for when nothing else applies. */
function anyMove(battle, me, active, foes, ally) {
	for (let j = 0; j < active.moves.length; j++) {
		const m = active.moves[j];
		if (m.disabled || (m.pp !== undefined && m.pp <= 0)) continue;
		const target = m.target || battle.dex.moves.get(m.id).target;
		if (TARGETED.has(target)) return `move ${j + 1} ${foes.length ? loc(foes[0]) : 1}`;
		const suffix = ownTarget(target, me, ally);
		if (suffix !== null) return `move ${j + 1}${suffix}`;
	}
	return 'move 1';
}

/** Value of a pair of options, one per active slot. */
function jointValue(battle, a, b) {
	let v = a.v + b.v;
	if (a.kind === 'switch' && b.kind === 'switch' && a.pokemon === b.pokemon) return -Infinity;
	// Both attacking one foe: an attack after the KO is wasted; two that KO only together earn the KO bonus.
	if (a.dmg && b.dmg) {
		for (const [f, da] of a.dmg) {
			const db = b.dmg.get(f);
			if (db === undefined) continue;
			if (da >= f.hp || db >= f.hp) {
				// one alone KOs: the other's damage there is mostly wasted
				v -= 0.7 * Math.min((da >= f.hp ? db : da) / f.hp, 1);
			} else if (da + db >= f.hp) {
				v += 0.5;
			}
		}
	}
	// Helping Hand is worth half the partner's attack
	for (const [x, y] of [[a, b], [b, a]]) {
		if (x.kind === 'helpinghand' && y.dmg) v += 0.5 * Math.max(0, y.v);
		// a spread move that hits the partner costs nothing if the partner protects (or switches out)
		if (x.allyDmg && (PROTECT.has(y.kind) || y.kind === 'switch')) v += 1.3 * 0.5;
		// redirection protects a partner who is setting up or setting speed control
		if (REDIRECT.has(x.kind) && ['tailwind', 'trickroom', 'status'].includes(y.kind)) v += 0.15;
	}
	if (PROTECT.has(a.kind) && PROTECT.has(b.kind)) v -= 0.3;
	return v;
}

function chooseMoves(battle, side, req) {
	const n = req.active.length;
	const per = [];
	for (let i = 0; i < n; i++) {
		const me = side.active[i];
		per.push(alive(me) && !req.active[i].commanding ? slotOptions(battle, side, i, req) : null);
	}
	let mega = req.active.findIndex(a => a && a.canMegaEvo);
	const pick = (o, i) => (o.choice.startsWith('move') && i === mega ? o.choice + ' mega' : o.choice);
	if (n < 2 || !per[0] || !per[1]) {
		return per.map((opts, i) => {
			if (!opts) return 'pass';
			return pick(opts.reduce((b, o) => (o.v > b.v ? o : b)), i);
		}).join(', ');
	}
	let best = null, bestV = -Infinity;
	for (const a of per[0]) {
		for (const b of per[1]) {
			const v = jointValue(battle, a, b);
			if (v > bestV) { bestV = v; best = [a, b]; }
		}
	}
	return best.map((o, i) => pick(o, i)).join(', ');
}

function chooseTeamPreview(battle, side) {
	const mine = side.pokemon, theirs = side.foe.pokemon;
	const leadBonus = p => {
		let s = 0;
		for (const m of p.moveSlots) {
			if (m.id === 'fakeout') s += 0.6;
			if (m.id === 'tailwind' || m.id === 'trickroom') s += 0.4;
			if (REDIRECT.has(m.id)) s += 0.3;
		}
		if (p.ability === 'intimidate') s += 0.4;
		return s;
	};
	const scored = mine.map((p, i) => {
		let s = 0;
		for (const f of theirs) s += matchupScore(battle, p, f);
		return {i, s, lead: s + leadBonus(p)};
	}).sort((a, b) => b.s - a.s);
	const picked = scored.slice(0, 4).sort((a, b) => b.lead - a.lead);
	const rest = scored.slice(4);
	return 'team ' + picked.concat(rest).map(x => x.i + 1).join('');
}

function chooseForceSwitch(battle, side, req) {
	const foes = foesOf(side);
	const used = new Set();
	return req.forceSwitch.map((must, i) => {
		if (!must) return 'pass';
		let best = null, bestS = -Infinity;
		side.pokemon.forEach((p, k) => {
			if (!alive(p) || p.isActive || used.has(k)) return;
			const s = foes.reduce((t, f) => t + matchupScore(battle, p, f), 0) + 0.3 * p.hp / p.maxhp;
			if (s > bestS) { bestS = s; best = k; }
		});
		if (best === null) return 'pass';
		used.add(best);
		return `switch ${best + 1}`;
	}).join(', ');
}

function decideDoubles(battle, side) {
	const req = side.activeRequest;
	if (!req || req.wait) return null;
	if (req.teamPreview) return chooseTeamPreview(battle, side);
	if (req.forceSwitch) return chooseForceSwitch(battle, side, req);
	return chooseMoves(battle, side, req);
}

/** Baseline: every slot uses its most damaging attack into the foe it hurts most (default team order). */
function decideGreedy(battle, side) {
	const req = side.activeRequest;
	if (!req || req.wait) return null;
	if (req.teamPreview) return 'default';
	if (req.forceSwitch) return chooseForceSwitch(battle, side, req);
	const foes = foesOf(side);
	return req.active.map((active, i) => {
		const me = side.active[i];
		if (!alive(me)) return 'pass';
		if (locked(active)) return 'move 1';
		let best = anyMove(battle, me, active, foes, allyOf(side, me)), bestD = -1;
		active.moves.forEach((m, j) => {
			if (m.disabled || (m.pp !== undefined && m.pp <= 0)) return;
			const move = battle.dex.moves.get(m.id);
			if (move.category === 'Status') return;
			for (const f of foes) {
				const d = Math.min(estDamage(battle, me, f, m.id) / f.hp, 1);
				if (d > bestD) { bestD = d; best = TARGETED.has(m.target || move.target) ? `move ${j + 1} ${loc(f)}` : `move ${j + 1}`; }
			}
		});
		return best;
	}).join(', ');
}

// Status moves the doubles pilot has a rule for (the set search tries these besides the singles ones).
const DOUBLES_STATUS = new Set([...PROTECT, ...REDIRECT, 'helpinghand', 'tailwind', 'trickroom', 'wideguard', 'quickguard']);

module.exports = {decideDoubles, decideGreedy, slotOptions, jointValue, DOUBLES_STATUS};
