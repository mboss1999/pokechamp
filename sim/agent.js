'use strict';
// A heuristic battle agent that reads the live Battle object. It sees the full
// state (both sides' sets), which is fine here: both players get the same
// information, and we care about relative strength, not hidden-info play.

const {PRNG} = require('pokemon-showdown');

const scratchPRNG = new PRNG([1, 2, 3, 4]);
const noop = () => {};

const ABSORB = {
	Water: ['waterabsorb', 'stormdrain', 'dryskin'],
	Electric: ['voltabsorb', 'lightningrod', 'motordrive'],
	Fire: ['flashfire', 'wellbakedbody'],
	Grass: ['sapsipper'],
	Ground: ['eartheater'],
};

const SETUP = {
	swordsdance: {atk: 2}, nastyplot: {spa: 2}, dragondance: {atk: 1, spe: 1}, calmmind: {spa: 1, spd: 1},
	bulkup: {atk: 1, def: 1}, quiverdance: {spa: 1, spd: 1, spe: 1}, shellsmash: {atk: 2, spa: 2, spe: 2},
	coil: {atk: 1, def: 1}, shiftgear: {atk: 1, spe: 2}, victorydance: {atk: 1, def: 1, spe: 1},
	tidyup: {atk: 1, spe: 1}, irondefense: {def: 2}, amnesia: {spd: 2}, agility: {spe: 2},
	rockpolish: {spe: 2}, curse: {atk: 1, def: 1}, growth: {atk: 1, spa: 1}, workup: {atk: 1, spa: 1},
	tailglow: {spa: 3}, bellydrum: {atk: 6}, cosmicpower: {def: 1, spd: 1}, howl: {atk: 1},
	filletaway: {atk: 2, spa: 2, spe: 2}, clangoroussoul: {atk: 1, spa: 1, spe: 1},
};
const RECOVERY = new Set([
	'recover', 'roost', 'softboiled', 'slackoff', 'moonlight', 'synthesis', 'morningsun', 'milkdrink',
	'shoreup', 'strengthsap', 'healorder', 'rest', 'junglehealing', 'lunarblessing',
]);
const SLEEP = new Set(['spore', 'sleeppowder', 'hypnosis', 'sing', 'lovelykiss', 'darkvoid', 'grasswhistle', 'yawn']);
const HAZARDS = {stealthrock: 'stealthrock', spikes: 'spikes', toxicspikes: 'toxicspikes', stickyweb: 'stickyweb'};
const SCREENS = {reflect: 'reflect', lightscreen: 'lightscreen', auroraveil: 'auroraveil'};
const PHAZE = new Set(['roar', 'whirlwind', 'haze', 'clearsmog', 'dragontail', 'circlethrow']);

/** Expected damage (HP points) of `moveId` from src to tgt, without touching the battle's RNG or log. */
function estDamage(battle, src, tgt, moveId) {
	const move = battle.dex.getActiveMove(moveId);
	if (move.category === 'Status') return 0;
	const savedPRNG = battle.prng, savedRand = battle.randomizer, savedAdd = battle.add;
	const savedDebug = battle.debug, savedHint = battle.hint, savedAttrLast = battle.attrLastMove;
	const savedMove = battle.activeMove, savedPoke = battle.activePokemon, savedTarget = battle.activeTarget;
	battle.prng = scratchPRNG;
	battle.randomizer = d => Math.floor(d * 0.925);
	battle.add = battle.debug = battle.hint = battle.attrLastMove = noop;
	// Mark the move as "in flight" so Mold Breaker-style ability suppression applies.
	battle.activeMove = move; battle.activePokemon = src; battle.activeTarget = tgt;
	let dmg = 0;
	try {
		move.willCrit = false;
		battle.runEvent('ModifyType', src, tgt, move, move);
		const absorbers = ABSORB[move.type];
		if (absorbers && absorbers.includes(tgt.ability) && !tgt.ignoringAbility()) return 0;
		const per = battle.actions.getDamage(src, tgt, move, true);
		dmg = typeof per === 'number' ? per : 0;
		if (move.multihit) {
			const hits = Array.isArray(move.multihit)
				? (src.hasAbility('skilllink') ? move.multihit[1] : (move.multihit[1] === 5 ? 3.1 : 2.5))
				: move.multihit;
			dmg *= hits;
		}
		if (move.accuracy !== true) dmg *= Math.min(100, move.accuracy) / 100;
	} catch (e) {
		dmg = 0;
	} finally {
		battle.prng = savedPRNG; battle.randomizer = savedRand; battle.add = savedAdd;
		battle.debug = savedDebug; battle.hint = savedHint; battle.attrLastMove = savedAttrLast;
		battle.activeMove = savedMove; battle.activePokemon = savedPoke; battle.activeTarget = savedTarget;
	}
	return dmg;
}

function bestDamage(battle, src, tgt) {
	let best = 0, bestId = null;
	for (const slot of src.moveSlots) {
		const d = estDamage(battle, src, tgt, slot.id);
		if (d > best) { best = d; bestId = slot.id; }
	}
	return {dmg: best, frac: tgt.hp ? best / tgt.hp : 0, move: bestId};
}

function speed(p) {
	return p.getActionSpeed ? Math.abs(p.getActionSpeed()) : p.getStat('spe');
}

function outspeeds(battle, a, b) {
	const sa = speed(a), sb = speed(b);
	const tr = !!battle.field.getPseudoWeather('trickroom');
	return tr ? sa < sb : sa > sb;
}

/** How good it is for `me` (healthy) to face `foe` from scratch: positive favours me. */
function matchupScore(battle, me, foe) {
	// Imposter copies the foe, so it starts every matchup roughly even (and wins speed ties via Scarf).
	if (me.ability === 'imposter') return 0.1;
	if (foe.ability === 'imposter') return 0;
	const myOff = Math.min(bestDamage(battle, me, foe).dmg / foe.maxhp, 1.2);
	const theirOff = Math.min(bestDamage(battle, foe, me).dmg / me.maxhp, 1.2);
	const fast = outspeeds(battle, me, foe) ? 0.15 : -0.15;
	return myOff - theirOff + fast;
}

function chooseTeamPreview(battle, side) {
	const mine = side.pokemon, theirs = side.foe.pokemon;
	const scored = mine.map((p, i) => {
		let s = 0;
		for (const f of theirs) s += matchupScore(battle, p, f);
		return {i, s};
	}).sort((a, b) => b.s - a.s);
	const picks = scored.slice(0, 3).map(x => x.i + 1);
	const rest = scored.slice(3).map(x => x.i + 1);
	return 'team ' + picks.concat(rest).join('');
}

function moveValue(battle, me, foe, moveId, ctx) {
	const move = battle.dex.moves.get(moveId);
	const hpFrac = me.hp / me.maxhp;
	const foeSide = foe.side;
	if (move.category !== 'Status') {
		if (move.id === 'fakeout' || move.id === 'firstimpression') {
			if (me.activeMoveActions > 0) return 0;
		}
		const dmg = estDamage(battle, me, foe, moveId);
		let v = Math.min(dmg / foe.hp, 1);
		if (dmg >= foe.hp) {
			v += 0.4;
			if (move.priority > 0 || ctx.iAmFaster) v += 0.4;
		}
		if (move.self && move.self.volatileStatus === 'mustrecharge' && dmg < foe.hp) v *= 0.5;
		if (move.selfdestruct) v = hpFrac < 0.3 ? v : v * 0.3;
		if (move.id === 'suckerpunch' || move.id === 'thunderclap') v *= 0.75;
		if (move.id === 'focuspunch' && !me.volatiles['substitute']) v *= 0.2;
		if (move.selfSwitch && ctx.threatFrac > 0.6 && ctx.benchCount > 0) v += 0.15;
		if (move.priority > 0 && !ctx.iAmFaster && ctx.threatFrac >= 1) v += 0.2;
		return v;
	}
	const st = foe.status;
	if (SETUP[move.id]) {
		const boosts = SETUP[move.id];
		const already = Object.keys(boosts).some(k => me.boosts[k] >= 2);
		if (already || move.id === 'bellydrum' && hpFrac < 0.6) return 0;
		return (hpFrac > 0.55 && ctx.threatFrac < 0.45) ? 0.6 : 0.05;
	}
	if (RECOVERY.has(move.id)) {
		if (move.id === 'rest') return hpFrac < 0.35 && ctx.threatFrac < 0.5 ? 0.45 : 0;
		return hpFrac < 0.55 && ctx.threatFrac < 0.5 ? 0.6 : (hpFrac < 0.75 ? 0.1 : 0);
	}
	if (SLEEP.has(move.id)) {
		if (st || foeSide.pokemon.some(p => p.status === 'slp') || foe.volatiles['yawn']) return 0;
		if (move.flags.powder && (foe.hasType('Grass') || foe.hasAbility('overcoat'))) return 0;
		return 0.65 * (move.accuracy === true ? 1 : move.accuracy / 100);
	}
	if (HAZARDS[move.id]) {
		const remaining = foeSide.pokemon.filter(p => !p.fainted && !p.isActive).length;
		const cond = foeSide.sideConditions[HAZARDS[move.id]];
		if (remaining < 1 || (cond && (move.id !== 'spikes' || cond.layers >= 2))) return 0;
		return 0.25 + 0.12 * remaining;
	}
	if (SCREENS[move.id]) {
		if (me.side.sideConditions[SCREENS[move.id]]) return 0;
		if (move.id === 'auroraveil' && !battle.field.isWeather(['hail', 'snowscape', 'snow'])) return 0;
		return 0.35;
	}
	if (PHAZE.has(move.id)) {
		const boosted = Object.values(foe.boosts).some(b => b > 0);
		return boosted ? 0.7 : 0;
	}
	switch (move.id) {
	case 'willowisp':
		// unmodified stats: running the Modify events outside a move crashes abilities like Torrent
		return !st && !foe.hasType('Fire') && foe.getStat('atk', false, true) > foe.getStat('spa', false, true) ? 0.5 : 0;
	case 'thunderwave': case 'glare': case 'stunspore':
		if (st || (move.id === 'thunderwave' && (foe.hasType('Ground') || foe.hasType('Electric')))) return 0;
		return outspeeds(battle, foe, me) ? 0.45 : 0.15;
	case 'toxic': case 'poisonpowder':
		return !st && !foe.hasType('Steel') && !foe.hasType('Poison') ? 0.4 : 0;
	case 'leechseed':
		return !foe.volatiles['leechseed'] && !foe.hasType('Grass') ? 0.35 : 0;
	case 'substitute':
		return !me.volatiles['substitute'] && hpFrac > 0.6 && ctx.threatFrac < 0.25 ? 0.3 : 0;
	case 'taunt': case 'encore':
		return 0.15;
	case 'trick': case 'switcheroo':
		return me.item && /choice/.test(me.item) && foe.item && !/choice/.test(foe.item) ? 0.4 : 0;
	case 'trickroom':
		return !battle.field.getPseudoWeather('trickroom') && !ctx.iAmFaster ? 0.45 : 0;
	case 'painsplit':
		return foe.hp / foe.maxhp - hpFrac > 0.3 ? 0.45 : 0;
	case 'destinybond':
		return ctx.threatFrac >= 1 && !ctx.iAmFaster ? 0 : (ctx.threatFrac >= 1 ? 0.7 : 0);
	case 'defog': case 'rapidspin': case 'mortalspin': case 'tidyup': {
		const sc = me.side.sideConditions;
		return sc.stealthrock || sc.spikes || sc.toxicspikes || sc.stickyweb ? 0.4 : 0;
	}
	case 'partingshot':
		return ctx.benchCount > 0 ? 0.2 : 0;
	case 'protect': case 'detect': case 'spikyshield': case 'kingsshield': case 'banefulbunker': case 'silktrap':
		return me.hasAbility('speedboost') && me.activeMoveActions === 0 ? 0.5 : 0.02;
	case 'sunnyday': case 'raindance': case 'sandstorm': case 'snowscape': case 'hail':
		return battle.field.weather ? 0 : 0.2;
	default:
		return 0.05;
	}
}

function chooseSwitchTarget(battle, side, foe) {
	let best = null, bestScore = -Infinity;
	for (let i = 0; i < side.pokemon.length; i++) {
		const p = side.pokemon[i];
		if (p.fainted || p.isActive) continue;
		const s = foe ? matchupScore(battle, p, foe) + 0.3 * (p.hp / p.maxhp) : p.hp / p.maxhp;
		if (s > bestScore) { bestScore = s; best = i; }
	}
	return best === null ? null : {slot: best + 1, score: bestScore};
}

function chooseMove(battle, side) {
	const req = side.activeRequest;
	const me = side.active[0];
	const foe = side.foe.active[0];
	const active = req.active[0];
	const canSwitch = !active.trapped && !active.maybeTrapped;
	const bench = side.pokemon.filter(p => !p.fainted && !p.isActive);
	const threat = bestDamage(battle, foe, me);
	const ctx = {
		iAmFaster: outspeeds(battle, me, foe),
		threatFrac: threat.frac,
		benchCount: bench.length,
	};
	let best = null, bestV = -1;
	active.moves.forEach((m, i) => {
		if (m.disabled || (m.pp !== undefined && m.pp <= 0)) return;
		const v = moveValue(battle, me, foe, m.id, ctx);
		if (v > bestV) { bestV = v; best = i + 1; }
	});
	const megaSuffix = active.canMegaEvo ? ' mega' : '';

	// Switch out when we'd be KO'd before acting (or can do nothing) and a teammate handles the foe better.
	if (canSwitch && bench.length && !me.volatiles['substitute']) {
		const doomed = threat.frac >= 1 && !ctx.iAmFaster && bestV < 1.4;
		const useless = bestV < 0.1;
		const lowValue = bestV < 0.35 && threat.frac > 0.5;
		if (doomed || useless || lowValue) {
			const target = chooseSwitchTarget(battle, side, foe);
			const stay = matchupScore(battle, me, foe);
			if (target && target.score > stay + 0.35 && (me.switchCount || 0) < 3) {
				me.switchCount = (me.switchCount || 0) + 1;
				return `switch ${target.slot}`;
			}
		}
	}
	if (best === null) return 'default';
	return `move ${best}${megaSuffix}`;
}

/** Return the choice string for this side's pending request, or null when nothing is pending. */
function decide(battle, side) {
	const req = side.activeRequest;
	if (!req || req.wait) return null;
	if (req.teamPreview) return chooseTeamPreview(battle, side);
	if (req.forceSwitch) {
		const foe = side.foe.active[0];
		const target = chooseSwitchTarget(battle, side, foe && !foe.fainted ? foe : null);
		return target ? `switch ${target.slot}` : 'pass';
	}
	return chooseMove(battle, side);
}

module.exports = {decide, estDamage, bestDamage, matchupScore, moveValue, outspeeds};
