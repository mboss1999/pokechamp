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

// Damage estimates are pure functions of the battle state, and one decision asks for the same ones many times
// (the foe's threat, each matchup score, the lookahead's candidate list). They are memoized per battle until
// its state changes; every state change (a turn, a switch, a faint) appends to battle.log, which estDamage
// itself never does, so the log length is the cache stamp.
const damageMemo = new WeakMap();
const CHECK_MEMO = !!process.env.CHECK_DAMAGE_MEMO; // debug: recompute every cached estimate and count mismatches
let memoMismatches = 0;

// Everything about a Pokémon that the damage formula can read. Species is unique per side (Species Clause), so
// side + species identifies the set and its stats.
function pokeKey(p) {
	const b = p.boosts, side = p.side;
	return `${side.n}${p.species.id}|${p.types.join('')}${p.addedType || ''}|${p.hp}|${p.status}|${p.item}|${p.ability}|${b.atk}${b.def}${b.spa}${b.spd}${b.spe}${b.accuracy}${b.evasion}|` +
		`${Object.keys(p.volatiles).join(',')}|${p.timesAttacked}|${p.lastMove ? p.lastMove.id : ''}|${p.moveLastTurnResult}|` +
		`${p.isActive ? 1 : 0}|${side.totalFainted}|${side.faintedLastTurn ? 1 : 0}|${Object.keys(side.sideConditions).join(',')}`;
}
// Field-wide effects, including the active Pokémon's abilities: auras (Fairy Aura) and Ruin abilities change
// every Pokémon's damage, even a benched attacker's.
function fieldKey(battle) {
	const f = battle.field;
	let k = `${f.weather}|${f.terrain}|${Object.keys(f.pseudoWeather).join(',')}`;
	for (const side of battle.sides) for (const p of side.active) k += p ? `|${p.species.id}:${p.ability}` : '|-';
	return k;
}
// The shared level only pays off inside the rollout AI's lookahead (sim/lookahead.js sets `active` for the length of
// a decision), where many battle copies revisit the same positions. In plain heuristic battles it made each battle
// ~13% slower and grew ~1.7 KB per entry: at the old 400k-entry cap ~690 MB per thread, which on a 64-thread machine
// exhausted 128 GB of RAM (2026-11-15). Values are identical either way, so this changes no decision.
const sharedMemo = {enabled: process.env.SHARED_DAMAGE_MEMO !== '0', active: false,
	max: Number(process.env.SHARED_DAMAGE_MEMO_MAX) || 100000, map: new Map(), hits: 0, misses: 0};

/** Expected damage (HP points) of `moveId` from src to tgt, without touching the battle's RNG or log. */
function estDamage(battle, src, tgt, moveId) {
	let memo = damageMemo.get(battle);
	const stamp = battle.log.length;
	if (!memo || memo.stamp !== stamp || memo.turn !== battle.turn) {
		memo = {stamp, turn: battle.turn, map: new Map()};
		damageMemo.set(battle, memo);
	}
	let bySrc = memo.map.get(src);
	if (!bySrc) memo.map.set(src, bySrc = new Map());
	let byTgt = bySrc.get(tgt);
	if (!byTgt) bySrc.set(tgt, byTgt = new Map());
	let dmg = byTgt.get(moveId);
	if (dmg === undefined) {
		if (sharedMemo.enabled && sharedMemo.active) {
			// second level: the same matchup in another battle copy (the lookahead's simulations revisit the
			// same Pokémon in the same condition constantly)
			const k = `${moveId}|${pokeKey(src)}|${pokeKey(tgt)}|${fieldKey(battle)}`;
			dmg = sharedMemo.map.get(k);
			if (dmg === undefined) {
				dmg = computeDamage(battle, src, tgt, moveId);
				if (sharedMemo.map.size >= sharedMemo.max) sharedMemo.map.clear();
				sharedMemo.map.set(k, dmg);
				sharedMemo.misses++;
			} else {
				sharedMemo.hits++;
				if (CHECK_MEMO) {
					const fresh = computeDamage(battle, src, tgt, moveId);
					if (fresh !== dmg) {
						memoMismatches++;
						if (memoMismatches <= 5) console.error('shared memo mismatch', k, dmg, fresh);
					}
				}
			}
		} else {
			dmg = computeDamage(battle, src, tgt, moveId);
		}
		byTgt.set(moveId, dmg);
	} else if (CHECK_MEMO) {
		const fresh = computeDamage(battle, src, tgt, moveId);
		if (fresh !== dmg) memoMismatches++;
	}
	return dmg;
}

// move handlers that change the user's state when run (everything else is a pure function of the position)
const STATEFUL_MODIFY = new Set(['rollout', 'iceball', 'present', 'struggle', 'beatup']);

/** Probability that `move` hits, as in BattleActions.hitStepAccuracy (No Guard, accuracy items and abilities,
 * accuracy / evasion stages), without the random roll. */
function hitChance(battle, src, tgt, move) {
	let accuracy = move.accuracy;
	if (accuracy === true || move.alwaysHit) return 1;
	accuracy = battle.runEvent('ModifyAccuracy', tgt, src, move, accuracy);
	if (accuracy === true) return 1;
	if (typeof accuracy !== 'number') return 1;
	let boost = 0;
	if (!move.ignoreAccuracy) boost = battle.clampIntRange(battle.runEvent('ModifyBoost', src, null, null, {...src.boosts}).accuracy, -6, 6);
	if (!move.ignoreEvasion) boost = battle.clampIntRange(boost - battle.runEvent('ModifyBoost', tgt, null, null, {...tgt.boosts}).evasion, -6, 6);
	if (boost > 0) accuracy = accuracy * (3 + boost) / 3;
	else if (boost < 0) accuracy = accuracy * 3 / (3 - boost);
	// No Guard and the like return true here
	accuracy = battle.runEvent('Accuracy', tgt, src, move, accuracy);
	if (accuracy === true) return 1;
	return Math.max(0, Math.min(100, Number(accuracy) || 0)) / 100;
}

function computeDamage(battle, src, tgt, moveId) {
	const move = battle.dex.getActiveMove(moveId);
	if (move.category === 'Status') return 0;
	const savedPRNG = battle.prng, savedRand = battle.randomizer, savedAdd = battle.add;
	const savedDebug = battle.debug, savedHint = battle.hint, savedAttrLast = battle.attrLastMove;
	const savedMove = battle.activeMove, savedPoke = battle.activePokemon, savedTarget = battle.activeTarget;
	// fresh dice on every call: an estimate must not depend on how many were made before it
	scratchPRNG.setSeed('1,2,3,4');
	battle.prng = scratchPRNG;
	battle.randomizer = d => Math.floor(d * 0.925);
	battle.add = battle.debug = battle.hint = battle.attrLastMove = noop;
	// Mark the move as "in flight" so Mold Breaker-style ability suppression applies.
	battle.activeMove = move; battle.activePokemon = src; battle.activeTarget = tgt;
	let dmg = 0;
	try {
		// moves that always crit (Flower Trick, Wicked Blow, Surging Strikes...) keep it; others are estimated
		// without crits
		if (move.willCrit !== true) move.willCrit = false;
		// the move's own handlers run first, as in BattleActions.useMoveInner: Weather Ball and Terrain Pulse
		// change type and power, Blizzard / Hurricane / Thunder can't miss in their weather. Without them Weather
		// Ball in sun was estimated as a 50-power Normal move (2026-11-15 ladder benchmark).
		if (!STATEFUL_MODIFY.has(move.id)) {
			battle.singleEvent('ModifyType', move, null, src, tgt, move, move);
			battle.singleEvent('ModifyMove', move, null, src, tgt, move, move);
		}
		battle.runEvent('ModifyType', src, tgt, move, move);
		const absorbers = ABSORB[move.type];
		if (absorbers && absorbers.includes(tgt.ability) && !tgt.ignoringAbility()) return 0;
		const acc = hitChance(battle, src, tgt, move);
		if (move.multiaccuracy && typeof move.multihit === 'number') {
			// Triple Axel / Triple Kick / Population Bomb: power grows per hit and each hit rolls accuracy
			const skill = src.hasAbility('skilllink');
			let reach = 1;
			for (let h = 1; h <= move.multihit; h++) {
				move.hit = h;
				reach *= skill ? 1 : acc;
				const per = battle.actions.getDamage(src, tgt, move, true);
				dmg += reach * (typeof per === 'number' && per > 0 ? per : 0);
			}
		} else {
			move.hit = 1;
			const per = battle.actions.getDamage(src, tgt, move, true);
			dmg = typeof per === 'number' && per > 0 ? per : 0;
			if (move.multihit) {
				const hits = Array.isArray(move.multihit)
					? (src.hasAbility('skilllink') ? move.multihit[1] : (move.multihit[1] === 5 ? 3.1 : 2.5))
					: move.multihit;
				dmg *= hits;
			}
			dmg *= acc;
		}
		// Protean / Libero: the user becomes the move's type before it hits, once per switch-in
		if (src.hasAbility(['protean', 'libero']) && !src.abilityState[src.ability] && move.type !== '???' &&
			!src.hasType(move.type) && !src.ignoringAbility()) dmg *= 1.5;
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
		// v2: Fake Out's flinch takes away the foe's turn (worth more the harder it hits me)
		if (ctx.v2 && move.id === 'fakeout' && dmg > 0 && !off(ctx, 'fakeout') &&
			!foe.hasAbility(['innerfocus', 'shielddust']) && foe.item !== 'covertcloak' && dmg < foe.hp) {
			v += Math.min(0.5, 0.15 + 0.35 * Math.min(1, ctx.threatFrac));
		}
		return v;
	}
	if (ctx.v2) {
		const v = tacticalValue(battle, me, foe, move, ctx);
		if (v !== undefined) return v;
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

// ---------------------------------------------------------------------------------------------------------
// v2 tactical valuations (agent 'heuristic2'). The v1 rules above give Protect 0.02 and Taunt/Encore a flat
// 0.15, so the pilot almost never clicks them and the set search can't value them (sim/audit-moves.js,
// 2026-11-14). These rules look at what the move actually achieves in the current position. Returns
// undefined to fall back to the v1 rule.

const PROTECT = new Set(['protect', 'detect', 'spikyshield', 'kingsshield', 'banefulbunker', 'silktrap', 'burningbulwark', 'obstruct']);

/** HP fraction (of max HP) `p` loses at the end of a turn from status and volatiles, net of its own healing. */
function residual(battle, p) {
	let loss = 0;
	const magic = p.hasAbility('magicguard');
	if (!magic) {
		if (p.status === 'brn') loss += 1 / 16;
		if (p.status === 'psn' && !p.hasAbility('poisonheal')) loss += 1 / 8;
		if (p.status === 'tox' && !p.hasAbility('poisonheal')) loss += Math.min(15, (p.statusState.stage || 0) + 1) / 16;
		if (p.volatiles['leechseed']) loss += 1 / 8;
		if (p.volatiles['saltcure']) loss += p.hasType('Water') || p.hasType('Steel') ? 1 / 4 : 1 / 8;
		if (battle.field.isWeather('sandstorm') && !['Rock', 'Ground', 'Steel'].some(t => p.hasType(t)) &&
			!p.hasAbility(['sandveil', 'sandrush', 'sandforce', 'overcoat'])) loss += 1 / 16;
	}
	if (p.hp < p.maxhp) {
		if (p.item === 'leftovers') loss -= 1 / 16;
		if (p.item === 'blacksludge' && p.hasType('Poison')) loss -= 1 / 16;
		if (p.hasAbility('poisonheal') && (p.status === 'psn' || p.status === 'tox')) loss -= 1 / 8;
		if (battle.field.isTerrain('grassyterrain') && p.isGrounded()) loss -= 1 / 16;
	}
	return loss;
}

const statusMoves = p => p.moveSlots.map(m => p.battle.dex.moves.get(m.id)).filter(m => m.category === 'Status');
const aliveFoes = foe => foe.side.pokemon.filter(p => !p.fainted && p.hp > 0).length;

// V2_OFF=protect,substitute,... turns rule groups back to v1 (for ablation studies)
const V2_OFF = new Set((process.env.V2_OFF || '').split(',').filter(Boolean));
const groupOf = move => PROTECT.has(move.id) ? 'protect' : SETUP[move.id] ? 'setup' : RECOVERY.has(move.id) ? 'recovery'
	: PHAZE.has(move.id) ? 'phaze' : move.id;

// a rule group switched off for one agent (battle.js 'heuristic2!group', for ablations) or globally (V2_OFF)
const off = (ctx, group) => V2_OFF.has(group) || !!(ctx.off && ctx.off.has(group));

function tacticalValue(battle, me, foe, move, ctx) {
	if (V2_OFF.size && V2_OFF.has(groupOf(move))) return undefined;
	if (ctx.off && ctx.off.has(groupOf(move))) return undefined;
	const hpFrac = me.hp / me.maxhp;
	const subbed = !!me.volatiles['substitute'];
	// foe's best hit as a fraction of my current HP; nothing gets through a Substitute that holds
	const threat = subbed ? 0 : ctx.threatFrac;
	const lastWasProtect = me.lastMove && PROTECT.has(me.lastMove.id) && me.moveLastTurnResult !== false;
	if (PROTECT.has(move.id)) {
		if (lastWasProtect) return 0;
		let v = 0.02;
		if (me.hasAbility('speedboost') && me.activeMoveActions === 0) v = 0.5;
		// a free turn of residual damage on the foe (poison, burn, Leech Seed...) and of my own recovery
		const net = residual(battle, foe) * foe.maxhp / Math.max(1, foe.hp) - residual(battle, me) * me.maxhp / Math.max(1, me.hp);
		if (net > 0.04) v = Math.max(v, Math.min(0.55, 0.15 + 3 * net));
		// block a first-turn Fake Out / First Impression
		if (foe.activeMoveActions === 0 && foe.moveSlots.some(m => m.id === 'fakeout' || m.id === 'firstimpression')) v = Math.max(v, 0.3);
		// wait for my pending Wish to land
		const wish = me.side.slotConditions[me.position] && me.side.slotConditions[me.position]['wish'];
		if (wish && hpFrac < 0.6 && ctx.threatFrac >= 0.3) v = Math.max(v, 0.55);
		// stall out the last turn of the foe's screens / Trick Room / Tailwind is too fine for this pilot
		return v;
	}
	if (move.id === 'wish') {
		// heals half my max HP at the end of next turn (to whoever is in this slot then)
		if (me.side.slotConditions[me.position] && me.side.slotConditions[me.position]['wish']) return 0;
		const heal = Math.min(0.5, 1 - hpFrac);
		if (heal < 0.2) return ctx.benchCount > 0 && hpFrac > 0.8 ? 0.08 : 0;
		// it lands a turn late: worth it when I survive the foe's next two hits, or with Protect to cover it
		const incoming = ctx.threatFrac * hpFrac;
		const canProtect = me.moveSlots.some(m => PROTECT.has(m.id));
		if (incoming * 2 < hpFrac + heal || (canProtect && incoming < hpFrac)) return Math.min(0.75, 0.2 + heal + (hpFrac < 0.5 ? 0.1 : 0));
		return 0.05;
	}
	if (move.id === 'substitute') {
		if (subbed || me.hp <= me.maxhp / 4 || hpFrac < 0.5) return 0;
		const foeStatus = statusMoves(foe).length;
		// a Substitute pays off when it survives the foe's hit, most of all against status and setup users
		if (ctx.threatFrac * hpFrac < 0.25) return foeStatus ? (ctx.iAmFaster ? 0.6 : 0.45) : 0.3;
		return 0.03;
	}
	if (move.id === 'taunt') {
		if (foe.volatiles['taunt']) return 0;
		const n = statusMoves(foe).filter(m => !PROTECT.has(m.id)).length;
		if (!n) return 0;
		let v = 0.2 + 0.13 * n;
		if (ctx.iAmFaster) v += 0.1;
		if (threat >= 0.6) v *= 0.5;
		return Math.min(v, 0.7);
	}
	if (move.id === 'encore') {
		const last = foe.lastMove;
		if (foe.volatiles['encore'] || !last || last.id === 'struggle' || foe.activeMoveActions === 0) return 0;
		if (last.category === 'Status') return PROTECT.has(last.id) ? 0.5 : 0.75;
		// locked into a weak attack
		const dmg = estDamage(battle, foe, me, last.id) / me.maxhp;
		return dmg < 0.15 ? 0.5 : 0;
	}
	if (move.id === 'disable') {
		const last = foe.lastMove;
		if (foe.volatiles['disable'] || !last || last.category === 'Status' || foe.activeMoveActions === 0) return 0;
		const dmg = estDamage(battle, foe, me, last.id) / Math.max(1, me.hp);
		return dmg >= threat * 0.9 && dmg > 0.3 ? Math.min(0.6, 0.3 * dmg + 0.2) : 0;
	}
	if (SETUP[move.id]) {
		const boosts = SETUP[move.id];
		// an Unaware foe ignores my boosts (all but Speed): setting up into it wastes the turn
		if (!off(ctx, 'unaware') && foe.hasAbility('unaware') && !me.hasAbility(['moldbreaker', 'teravolt', 'turboblaze'])) {
			if (!boosts.spe) return 0;
			if (ctx.iAmFaster) return 0;
		}
		if (move.id === 'bellydrum') return me.boosts.atk < 2 && hpFrac > 0.6 && threat < 0.4 ? 0.7 : 0;
		const maxed = Object.entries(boosts).every(([k, n]) => me.boosts[k] + n > 6 || (k !== 'spe' && me.boosts[k] >= 4));
		if (maxed) return 0;
		// how much of a sweep is left to set up for, and whether I survive the turn I spend
		const left = aliveFoes(foe);
		if (threat < 0.45) return Math.min(0.85, 0.4 + 0.1 * left);
		if (threat < 1 && boosts.spe && !ctx.iAmFaster) return 0.25;
		return 0.03;
	}
	if (RECOVERY.has(move.id)) {
		if (move.id === 'rest') return hpFrac < 0.35 && threat < 0.5 ? 0.45 : 0;
		const heal = Math.min(0.5, 1 - hpFrac);
		const incoming = ctx.threatFrac * hpFrac; // of max HP
		if (heal < 0.2) return 0;
		// recover only when it out-heals what the foe can do to me
		if (incoming < heal) return Math.min(0.8, 0.25 + heal + (hpFrac < 0.5 ? 0.15 : 0));
		return 0.05;
	}
	if (move.id === 'willowisp') {
		if (foe.status || foe.hasType('Fire') || foe.hasAbility(['waterveil', 'waterbubble', 'thermalexchange', 'guts', 'comatose', 'purifyingsalt', 'magicbounce'])) return 0;
		const best = bestDamage(battle, foe, me);
		const phys = best.move && battle.dex.moves.get(best.move).category === 'Physical';
		return phys ? 0.55 + Math.min(0.2, threat * 0.2) : 0.12;
	}
	if (PHAZE.has(move.id) && move.category === 'Status') {
		if (Object.values(foe.boosts).some(b => b > 0)) return 0.7;
		const benched = foe.side.pokemon.filter(p => !p.fainted && !p.isActive).length;
		const sc = foe.side.sideConditions;
		if ((move.id === 'roar' || move.id === 'whirlwind') && benched && (sc.stealthrock || sc.spikes)) return 0.3;
		return 0;
	}
	return undefined;
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

function chooseMove(battle, side, opts = {}) {
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
		v2: !!opts.v2,
		off: opts.off || null,
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
function decide(battle, side, opts = {}) {
	const req = side.activeRequest;
	if (!req || req.wait) return null;
	if (req.teamPreview) return chooseTeamPreview(battle, side);
	if (req.forceSwitch) {
		const foe = side.foe.active[0];
		const target = chooseSwitchTarget(battle, side, foe && !foe.fainted ? foe : null);
		return target ? `switch ${target.slot}` : 'pass';
	}
	return chooseMove(battle, side, opts);
}
const decideV2 = (battle, side) => decide(battle, side, {v2: true});

// Status moves the pilot has a rule for (anything else scores a flat 0.05 and is effectively never used, so the
// set search doesn't spend battles on it).
const RULED = new Set(['wish', 'willowisp', 'thunderwave', 'glare', 'stunspore', 'toxic', 'poisonpowder', 'leechseed', 'substitute',
	'taunt', 'encore', 'disable', 'trick', 'switcheroo', 'trickroom', 'painsplit', 'destinybond', 'defog', 'partingshot',
	'sunnyday', 'raindance', 'sandstorm', 'snowscape']);
const knownStatus = id => !!(SETUP[id] || RECOVERY.has(id) || SLEEP.has(id) || HAZARDS[id] || SCREENS[id] || PHAZE.has(id) ||
	PROTECT.has(id) || RULED.has(id));

module.exports = {knownStatus, decideV2, tacticalValue, memoMismatches: () => memoMismatches, sharedMemo, decide, estDamage, bestDamage, matchupScore, moveValue, outspeeds};
