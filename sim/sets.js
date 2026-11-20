'use strict';
// Candidate set generation. Produces a broad-but-sane pool of sets per roster
// entry; the simulator decides which of them is actually best.

const fs = require('fs');
const path = require('path');
const F = require('./format');
const {dex} = F;

const TYPE_ITEM = {
	Fire: 'Charcoal', Water: 'Mystic Water', Grass: 'Miracle Seed', Electric: 'Magnet', Ice: 'Never-Melt Ice',
	Fighting: 'Black Belt', Poison: 'Poison Barb', Ground: 'Soft Sand', Flying: 'Sharp Beak', Psychic: 'Twisted Spoon',
	Bug: 'Silver Powder', Rock: 'Hard Stone', Ghost: 'Spell Tag', Dragon: 'Dragon Fang', Dark: 'Black Glasses',
	Steel: 'Metal Coat', Normal: 'Silk Scarf', Fairy: 'Fairy Feather',
};

// Status moves the agent knows how to use, by role.
const ROLE = {
	setupPhys: ['swordsdance', 'dragondance', 'bulkup', 'shiftgear', 'victorydance', 'tidyup', 'coil', 'curse', 'howl', 'bellydrum'],
	setupSpec: ['nastyplot', 'calmmind', 'quiverdance', 'tailglow', 'workup', 'growth'],
	setupMixed: ['shellsmash', 'filletaway', 'clangoroussoul'],
	recovery: ['recover', 'roost', 'softboiled', 'slackoff', 'moonlight', 'synthesis', 'morningsun', 'milkdrink', 'shoreup', 'strengthsap', 'healorder'],
	status: ['spore', 'sleeppowder', 'willowisp', 'thunderwave', 'glare', 'toxic', 'yawn', 'hypnosis', 'leechseed'],
	hazard: ['stealthrock', 'spikes', 'toxicspikes', 'stickyweb'],
	utility: ['trickroom', 'reflect', 'lightscreen', 'auroraveil', 'taunt', 'encore', 'painsplit', 'partingshot', 'defog', 'haze', 'substitute', 'trick', 'destinybond'],
};
const SETUP_ORDER = [...ROLE.setupMixed, 'quiverdance', 'dragondance', 'shiftgear', 'victorydance', 'tidyup',
	'swordsdance', 'nastyplot', 'tailglow', 'calmmind', 'bulkup', 'coil', 'curse', 'workup', 'growth', 'howl'];
const STATUS_ORDER = ['spore', 'sleeppowder', 'willowisp', 'glare', 'thunderwave', 'toxic', 'yawn', 'leechseed', 'hypnosis'];

const BANNED_ATTACKS = new Set([
	'struggle', 'beatup', 'counter', 'mirrorcoat', 'metalburst', 'endeavor', 'dreameater', 'fling', 'naturalgift',
	'lastresort', 'belch', 'steelroller', 'burnup', 'doubleshock', 'futuresight', 'doomdesire', 'skydrop', 'bide',
	'synchronoise', 'spitup', 'focuspunch', 'shelltrap', 'snore', 'sleeptalk', 'present', 'magnitude', 'round',
	'echoedvoice', 'fusionflare', 'fusionbolt', 'uproar', 'thrash', 'outrage', 'petaldance', 'ragingfury', 'rollout',
	'iceball', 'furycutter', 'hyperspacefury', 'superfang', 'naturesmadness', 'ruination', 'finalgambit',
	'nightshade', 'seismictoss', 'psywave', 'dragonrage', 'sonicboom', 'electroball', 'gyroball', 'grassknot',
	'lowkick', 'heavyslam', 'heatcrash', 'reversal', 'flail', 'punishment', 'crushgrip', 'wringout', 'trumpcard',
	'storedpower', 'powertrip', 'payback', 'avalanche', 'revenge', 'assurance', 'retaliate', 'fishiousrend',
	'boltbeak', 'pursuit', 'smellingsalts', 'wakeupslap', 'venoshock', 'hex', 'brine', 'acrobatics', 'facade',
	'eruption', 'waterspout', 'dragonenergy', 'lashout', 'temperflare', 'stompingtantrum', 'ragefist',
	'lastrespects', 'comeuppance', 'bodypress', 'foulplay', 'electroshot', 'meteorbeam', 'solarblade', 'solarbeam',
	'skyattack', 'razorwind', 'freezeshock', 'iceburn', 'geomance', 'skullbash', 'dig', 'dive', 'fly', 'bounce',
	'phantomforce', 'shadowforce', 'selfdestruct', 'explosion', 'mistyexplosion', 'mindblown', 'chloroblast',
	'gigatondhammer', 'bloodmoon', 'hyperbeam', 'gigaimpact', 'blastburn', 'hydrocannon', 'frenzyplant',
	'rockwrecker', 'roaroftime', 'prismaticlaser', 'eternabeam', 'meteorassault', 'hyperdrill', 'headsmash',
	'uturn', 'voltswitch', 'flipturn', 'teleport',
]);
// Re-allow a few situational attacks with a fixed effective power estimate.
const SPECIAL_POWER = {
	knockoff: 90, bodypress: 80, foulplay: 85, facade: 70, acrobatics: 85, lowkick: 75, grassknot: 75,
	heavyslam: 80, gyroball: 70, storedpower: 60, hex: 75, eruption: 120, waterspout: 120, ragefist: 75,
	lastrespects: 70, temperflare: 75, stompingtantrum: 75, uturn: 70, voltswitch: 70, flipturn: 60,
	headsmash: 120, solarbeam: 60, phantomforce: 75, electroshot: 90,
};
const DRAWBACK = {
	closecombat: 0.93, superpower: 0.9, dracometeor: 0.85, overheat: 0.85, leafstorm: 0.85, fleurcannon: 0.85,
	psychoboost: 0.85, makeitrain: 0.92, armorcannon: 0.92, headlongrush: 0.93, hammerarm: 0.9, icehammer: 0.9,
	vcreate: 0.85, clangingscales: 0.9, spinout: 0.9, steelbeam: 0.6, wavecrash: 0.9, bravebird: 0.9,
	flareblitz: 0.9, doubleedge: 0.88, woodhammer: 0.9, volttackle: 0.9, headsmash: 0.85, takedown: 0.85,
	submission: 0.8, wildcharge: 0.92, highjumpkick: 0.85, jumpkick: 0.85, axekick: 0.85,
};

function hitsOf(move) {
	if (!move.multihit) return 1;
	if (Array.isArray(move.multihit)) return move.multihit[1] === 5 ? 3.1 : 2.5;
	return move.multihit;
}

/** Rough per-turn value of an attacking move for this mon (before matchup / coverage). */
function attackPower(move, ctx) {
	let bp = SPECIAL_POWER[move.id] ?? move.basePower;
	if (!bp) return 0;
	if (!SPECIAL_POWER[move.id]) bp *= hitsOf(move);
	if (move.id === 'populationbomb') bp = 20 * 6;
	if (move.id === 'surgingstrikes') bp = 25 * 3 * 1.5;
	const acc = move.accuracy === true ? 1 : move.accuracy / 100;
	let v = bp * acc * (DRAWBACK[move.id] ?? 1);
	if (ctx.types.includes(move.type)) v *= ctx.stab;
	let stat = move.category === 'Physical' ? ctx.atk : ctx.spa;
	if (move.id === 'bodypress') stat = ctx.def;
	if (move.id === 'foulplay') stat = 120;
	v *= stat / 100;
	if (move.priority > 0) v *= 0.8; // weaker, but valued separately as priority
	return v;
}

let defenderTypes = null;
function rosterDefenderTypes() {
	if (defenderTypes) return defenderTypes;
	const counts = new Map();
	for (const s of F.legalRoster()) {
		const key = s.types.join('/');
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	defenderTypes = [...counts.entries()].map(([k, n]) => ({types: k.split('/'), w: n}));
	return defenderTypes;
}

function effectiveness(moveType, defTypes) {
	let mult = 1;
	for (const t of defTypes) {
		if (!dex.getImmunity(moveType, t)) return 0;
		mult *= 2 ** dex.getEffectiveness(moveType, t);
	}
	return mult;
}

/** Greedily pick `n` attacks maximizing average best damage across the roster's type combos. */
function pickCoverage(attacks, n, ctx, preset = []) {
	const defs = rosterDefenderTypes();
	const chosen = [...preset];
	const score = set => {
		let total = 0, wsum = 0;
		for (const d of defs) {
			let best = 0;
			for (const m of set) best = Math.max(best, attackPower(m, ctx) * effectiveness(m.type, d.types));
			total += best * d.w; wsum += d.w;
		}
		return total / wsum;
	};
	while (chosen.length < n) {
		let best = null, bestS = -1;
		for (const m of attacks) {
			if (chosen.some(c => c.id === m.id)) continue;
			// at most one move per type per category, so coverage stays varied
			if (chosen.some(c => c.type === m.type && c.category === m.category && c.priority === m.priority)) continue;
			const s = score([...chosen, m]);
			if (s > bestS) { bestS = s; best = m; }
		}
		if (!best) break;
		chosen.push(best);
	}
	// small movepools: relax the one-move-per-type rule rather than leave slots empty
	for (const m of attacks) {
		if (chosen.length >= n) break;
		if (!chosen.some(c => c.id === m.id)) chosen.push(m);
	}
	return chosen;
}

function statsFor(species) {
	const b = species.baseStats;
	return {hp: b.hp, atk: b.atk, def: b.def, spa: b.spa, spd: b.spd, spe: b.spe};
}

const SPREADS = {
	fastPhys: {nature: 'Jolly', evs: {hp: 2, atk: 32, spe: 32}},
	strongPhys: {nature: 'Adamant', evs: {hp: 2, atk: 32, spe: 32}},
	fastSpec: {nature: 'Timid', evs: {hp: 2, spa: 32, spe: 32}},
	strongSpec: {nature: 'Modest', evs: {hp: 2, spa: 32, spe: 32}},
	bulkyPhys: {nature: 'Adamant', evs: {hp: 32, atk: 32, def: 2}},
	bulkySpec: {nature: 'Modest', evs: {hp: 32, spa: 32, spd: 2}},
	wallDefPhys: {nature: 'Impish', evs: {hp: 32, def: 32, spd: 2}},
	wallDefSpec: {nature: 'Bold', evs: {hp: 32, def: 32, spd: 2}},
	wallSpdPhys: {nature: 'Careful', evs: {hp: 32, spd: 32, def: 2}},
	wallSpdSpec: {nature: 'Calm', evs: {hp: 32, spd: 32, def: 2}},
	trPhys: {nature: 'Brave', evs: {hp: 32, atk: 32, def: 2}},
	trSpec: {nature: 'Quiet', evs: {hp: 32, spa: 32, spd: 2}},
};

function fullEvs(evs) {
	return {hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...evs};
}

function makeSet(species, {ability, item, moves, spread}) {
	const s = SPREADS[spread];
	return {
		name: species.baseSpecies === species.name ? species.name : species.name,
		species: species.name,
		item: item || '',
		ability,
		nature: s.nature,
		evs: fullEvs(s.evs),
		ivs: {hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31},
		moves: moves.map(m => m.name),
		level: 50,
		spread,
	};
}

/** Roster entries: each species, plus one entry per Mega Stone it can hold. */
function rosterEntries() {
	const out = [];
	for (const species of F.legalRoster()) {
		out.push({id: species.id, species: species.name, megaItem: null, battleSpecies: species.name});
		for (const opt of F.megaOptions(species)) {
			out.push({
				id: `${species.id}-${F.toID(opt.item)}`, species: species.name, megaItem: opt.item,
				battleSpecies: opt.mega.name,
			});
		}
	}
	// collapse formes that are identical in battle to an earlier entry (e.g. Vivillon patterns)
	const seen = new Set();
	return out.filter(e => {
		const s = dex.species.get(e.species);
		const key = [e.megaItem, s.types.join(), Object.values(s.baseStats).join(), Object.values(s.abilities).join(),
			s.baseSpecies].join('|');
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** Candidate sets for one roster entry. */
function candidateSets(entry, opts = {}) {
	const species = dex.species.get(entry.species);
	const battleSpecies = dex.species.get(entry.battleSpecies);
	const st = statsFor(battleSpecies);
	const learn = F.learnableMoves(species);
	const learnIds = new Set(learn.map(m => m.id));
	const abilities = [...new Set(Object.values(species.abilities))].map(a => dex.abilities.get(a))
		.filter(a => a.exists).sort((a, b) => b.rating - a.rating);
	const topAbilities = abilities.filter(a => a.rating >= abilities[0].rating - 1).slice(0, 2);

	const ctxFor = ability => ({
		types: battleSpecies.types,
		stab: ['adaptability'].includes(F.toID(ability.name)) ? 2 : 1.5,
		atk: st.atk * (['hugepower', 'purepower'].includes(F.toID(ability.name)) ? 2 : 1),
		spa: st.spa, def: st.def,
	});
	const attacksFor = (category, ctx) => learn.filter(m => m.category !== 'Status' &&
		(category === 'any' || m.category === category || m.id === 'bodypress') &&
		(!BANNED_ATTACKS.has(m.id) || SPECIAL_POWER[m.id]) &&
		(m.basePower >= 50 || m.priority > 0 || SPECIAL_POWER[m.id] || m.multihit) &&
		(!m.flags.charge || SPECIAL_POWER[m.id]) && !m.isZ)
		.sort((a, b) => attackPower(b, ctx) - attackPower(a, ctx)).slice(0, 18);
	const has = id => learnIds.has(id);
	const firstOf = list => list.find(has);

	const physical = st.atk >= st.spa * 0.9;
	const special = st.spa >= st.atk * 0.9;
	const cats = [];
	if (physical) cats.push('Physical');
	if (special) cats.push('Special');
	const fast = st.spe >= 85;
	const bulky = st.hp + st.def + st.spd >= 270;

	const out = [];
	const push = (archetype, cfg) => {
		const set = makeSet(species, cfg);
		if (entry.megaItem) set.item = entry.megaItem;
		set.archetype = archetype;
		const key = JSON.stringify([set.ability, set.item, set.spread, [...set.moves].sort()]);
		if (out.some(s => s.key === key)) return;
		if (set.moves.length < 2) return;
		if (choiceWaste(set).length) return;
		const problems = F.validateSet(JSON.parse(JSON.stringify(set)));
		if (problems) return;
		set.key = key;
		out.push(set);
	};
	const items = (extra = []) => entry.megaItem ? [entry.megaItem] : extra;

	for (const ability of topAbilities) {
		const ctx = ctxFor(ability);
		for (const cat of cats) {
			const phys = cat === 'Physical';
			const attacks = attacksFor(cat, ctx);
			if (!attacks.length) continue;
			const four = pickCoverage(attacks, 4, ctx);
			const stabType = four[0] && four[0].type;
			const offSpreads = phys ? (fast ? ['fastPhys', 'strongPhys'] : ['strongPhys', 'bulkyPhys'])
				: (fast ? ['fastSpec', 'strongSpec'] : ['strongSpec', 'bulkySpec']);

			// 1. all-out attacker
			for (const item of items(['Life Orb', 'Choice Scarf', 'Focus Sash', TYPE_ITEM[stabType], 'Expert Belt'])) {
				const moves = item === 'Choice Scarf' && has('trick') && !phys
					? [...pickCoverage(attacks, 3, ctx), dex.moves.get('trick')] : four;
				push('attacker', {ability: ability.name, item, moves, spread: offSpreads[0]});
			}
			push('attacker', {ability: ability.name, item: items(['Life Orb'])[0], moves: four, spread: offSpreads[1]});

			// 2. setup sweeper
			const setupList = phys ? [...ROLE.setupMixed, ...ROLE.setupPhys] : [...ROLE.setupMixed, ...ROLE.setupSpec];
			const setup = SETUP_ORDER.filter(id => setupList.includes(id)).find(has);
			if (setup) {
				const moves = [dex.moves.get(setup), ...pickCoverage(attacks, 3, ctx)];
				for (const item of items(['Life Orb', 'Lum Berry', 'Focus Sash', 'Sitrus Berry', 'White Herb'])) {
					if (item === 'White Herb' && !['shellsmash', 'filletaway'].includes(setup)) continue;
					push('setup', {ability: ability.name, item, moves, spread: offSpreads[0]});
				}
				if (bulky) {
					const rec = firstOf(ROLE.recovery);
					const bulkMoves = rec ? [dex.moves.get(setup), dex.moves.get(rec), ...pickCoverage(attacks, 2, ctx)] : moves;
					push('setup', {ability: ability.name, item: items(['Leftovers'])[0], moves: bulkMoves,
						spread: phys ? 'bulkyPhys' : 'bulkySpec'});
				}
			}

			// 3. bulky attacker with one utility move
			const util = firstOf(ROLE.recovery) || firstOf(STATUS_ORDER) || firstOf(['stealthrock', 'spikes', 'taunt']);
			if (util) {
				const moves = [...pickCoverage(attacks, 3, ctx), dex.moves.get(util)];
				for (const item of items(['Leftovers', 'Sitrus Berry'])) {
					push('bulky', {ability: ability.name, item, moves, spread: phys ? 'bulkyPhys' : 'bulkySpec'});
				}
			}
		}

		// 4. defensive support
		const rec = firstOf(ROLE.recovery);
		const stat = firstOf(STATUS_ORDER);
		const hazard = firstOf(ROLE.hazard);
		if (bulky && (rec || stat || hazard)) {
			const anyAttacks = attacksFor(st.atk >= st.spa ? 'Physical' : 'Special', ctx);
			const support = [rec, stat, hazard].filter(Boolean).map(id => dex.moves.get(id));
			const moves = [...support, ...pickCoverage(anyAttacks, 4 - support.length, ctx)].slice(0, 4);
			const physWall = st.def >= st.spd;
			const spread = (physWall ? 'wallDef' : 'wallSpd') + (st.atk >= st.spa ? 'Phys' : 'Spec');
			for (const item of items(['Leftovers', 'Sitrus Berry'])) push('support', {ability: ability.name, item, moves, spread});
		}

		// 5. Trick Room attacker for slow, strong mons
		if (st.spe <= 50 && has('trickroom')) {
			const cat = st.atk >= st.spa ? 'Physical' : 'Special';
			const attacks = attacksFor(cat, ctx);
			const moves = [dex.moves.get('trickroom'), ...pickCoverage(attacks, 3, ctx)];
			for (const item of items(['Life Orb', 'Sitrus Berry'])) {
				push('trickroom', {ability: ability.name, item, moves, spread: cat === 'Physical' ? 'trPhys' : 'trSpec'});
			}
		}
	}
	// Seeds from Showdown's hand-curated Champions random-battle movepools (by role).
	for (const role of curatedRoles(battleSpecies.id) || curatedRoles(species.id) || []) {
		const moves = role.movepool.map(m => dex.moves.get(m)).filter(m => m.exists && has(m.id));
		const roleAbilities = (role.abilities || []).filter(a => Object.values(species.abilities).includes(a));
		const ability = roleAbilities[0] || topAbilities[0].name;
		const ctx = ctxFor(dex.abilities.get(ability));
		const phys = moves.filter(m => m.category === 'Physical').length >= moves.filter(m => m.category === 'Special').length;
		const R = ROLE_STYLE[role.role] || ROLE_STYLE['Bulky Attacker'];
		const spread = R.spread + (phys ? 'Phys' : 'Spec');
		for (let combo of bestCombos(moves, ctx, 2)) {
			// small curated movepools: top up with coverage attacks so the set uses all four slots
			if (combo.length < 4) {
				const attacks = attacksFor(phys ? 'Physical' : 'Special', ctx).filter(m => !combo.some(c => c.id === m.id));
				combo = [...combo, ...pickCoverage(attacks, 4 - combo.length, ctx, combo.filter(m => m.category !== 'Status'))
					.filter(m => !combo.some(c => c.id === m.id))].slice(0, 4);
			}
			for (const item of items(R.items.slice(0, 2))) push('curated', {ability, item, moves: combo, spread});
		}
	}
	if (species.id === 'ditto') {
		for (const spread of ['wallDefPhys', 'wallSpdPhys']) {
			push('imposter', {ability: 'Imposter', item: 'Choice Scarf', moves: [dex.moves.get('transform')], spread});
		}
		if (!out.length) {
			// validation rejects one-move sets only via our own length guard; Ditto is the exception
			const set = makeSet(species, {ability: 'Imposter', item: 'Choice Scarf', moves: [dex.moves.get('transform')], spread: 'wallDefPhys'});
			set.archetype = 'imposter';
			set.key = 'ditto';
			out.push(set);
		}
	}
	if (species.id === 'pikachu') {
		for (const s of out) if (s.item === 'Life Orb') s.item = 'Light Ball';
	}
	const limit = opts.limit || 30;
	// curated seeds first so the cap never drops them
	out.sort((a, b) => (b.archetype === 'curated') - (a.archetype === 'curated'));
	return out.slice(0, limit);
}

// Moves that only pay off if the user keeps acting afterwards (setup, recovery, Substitute, Protect): under a Choice
// item they lock the holder into a move that does nothing more, so a Choice set must not carry them. One-shot moves
// that work before a switch (status, hazards, Taunt, screens, pivots, Destiny Bond, Trick, Wish) stay allowed.
const CHOICE_WASTE = new Set(['substitute', 'rest', 'focusenergy', 'bellydrum', 'stockpile', 'swallow', 'curse',
	'strengthsap', 'painsplit', 'ingrain', 'aquaring', 'magnetrise', 'laserfocus', 'charge', 'autotomize', 'minimize',
	'defensecurl', 'doubleteam', 'acupressure', 'shoreup', 'howl', 'milkdrink', 'moonlight', 'morningsun', 'synthesis',
	'lifedew', 'tidyup', 'stuffcheeks', 'powershift', 'victorydance', 'takeheart', 'burningbulwark', 'silktrap',
	'obstruct', 'junglehealing', 'lunarblessing']);
const wastedOnChoice = m => m.category === 'Status' &&
	(CHOICE_WASTE.has(m.id) || !!m.stallingMove || (m.target === 'self' && (!!m.boosts || !!m.heal)));
const isChoice = item => /^choice /i.test(item || '');
/** Moves of `set` that a Choice item would waste (none unless it holds one). */
function choiceWaste(set) {
	if (!isChoice(set.item)) return [];
	return set.moves.map(m => dex.moves.get(m)).filter(wastedOnChoice).map(m => m.name);
}

const ROLE_STYLE = {
	'Fast Attacker': {spread: 'fast', items: ['Life Orb', 'Focus Sash', 'Choice Scarf']},
	'Wallbreaker': {spread: 'strong', items: ['Life Orb', 'Expert Belt']},
	'Setup Sweeper': {spread: 'fast', items: ['Life Orb', 'Lum Berry', 'Sitrus Berry']},
	'Fast Support': {spread: 'fast', items: ['Focus Sash', 'Leftovers']},
	'Bulky Attacker': {spread: 'bulky', items: ['Leftovers', 'Sitrus Berry']},
	'Bulky Setup': {spread: 'bulky', items: ['Leftovers', 'Sitrus Berry']},
	'Bulky Support': {spread: 'wallDef', items: ['Leftovers', 'Sitrus Berry']},
	// doubles roles (doubles-sets.json)
	'Doubles Support': {spread: 'bulky', items: ['Sitrus Berry', 'Focus Sash']},
	'Offensive Protect': {spread: 'strong', items: ['Life Orb', 'Sitrus Berry']},
	'Doubles Bulky Setup': {spread: 'bulky', items: ['Sitrus Berry', 'Leftovers']},
	'Doubles Setup Sweeper': {spread: 'fast', items: ['Life Orb', 'Focus Sash']},
	'Doubles Fast Attacker': {spread: 'fast', items: ['Life Orb', 'Focus Sash']},
	'Doubles Bulky Attacker': {spread: 'bulky', items: ['Sitrus Berry', 'Life Orb']},
	'Doubles Wallbreaker': {spread: 'strong', items: ['Life Orb', 'Expert Belt']},
	'Choice Item user': {spread: 'fast', items: ['Choice Scarf', 'Expert Belt']}, // Champions has no Band or Specs
};

let curated = null;
function curatedRoles(id) {
	if (curated === null) {
		curated = {};
		try {
			const name = F.GAME_TYPE === 'doubles' ? 'doubles-sets.json' : 'sets.json';
			const file = path.join(path.dirname(require.resolve('pokemon-showdown')), '..', 'data', 'random-battles', 'champions', name);
			curated = JSON.parse(fs.readFileSync(file, 'utf8'));
		} catch {}
	}
	return curated[id] && curated[id].sets;
}

const USEFUL_STATUS = new Set(Object.values(ROLE).flat());
/** Top-k 4-move combinations from a movepool: coverage of attacks plus value of known status moves. */
function bestCombos(moves, ctx, k) {
	if (moves.length <= 4) return moves.length ? [moves] : [];
	const defs = rosterDefenderTypes();
	const combos = [];
	const n = moves.length;
	for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
		const set = [moves[a], moves[b], moves[c], moves[d]];
		const attacks = set.filter(m => m.category !== 'Status');
		const status = set.filter(m => m.category === 'Status');
		if (!attacks.length) continue;
		if (set.filter(m => SETUP_ORDER.includes(m.id)).length > 1) continue;
		let cov = 0, w = 0;
		for (const def of defs) {
			let best = 0;
			for (const m of attacks) best = Math.max(best, attackPower(m, ctx) * effectiveness(m.type, def.types));
			cov += best * def.w; w += def.w;
		}
		const score = cov / w + status.reduce((s, m) => s + (USEFUL_STATUS.has(m.id) ? 35 : 5), 0) - (status.length > 2 ? 40 : 0);
		combos.push({set, score});
	}
	combos.sort((x, y) => y.score - x.score);
	return combos.slice(0, k).map(c => c.set);
}

/** Small local edits of a set, used for hill-climbing after the archetype search. */
function neighbours(entry, set, rng) {
	const species = dex.species.get(entry.species);
	const battleSpecies = dex.species.get(entry.battleSpecies);
	const st = statsFor(battleSpecies);
	const ability = dex.abilities.get(set.ability);
	const ctx = {types: battleSpecies.types, stab: 1.5, atk: st.atk, spa: st.spa, def: st.def};
	const learn = F.learnableMoves(species);
	const pool = learn.filter(m => {
		if (m.category === 'Status') return Object.values(ROLE).some(list => list.includes(m.id));
		return (!BANNED_ATTACKS.has(m.id) || SPECIAL_POWER[m.id]) && (m.basePower >= 50 || m.priority > 0 || SPECIAL_POWER[m.id]);
	}).sort((a, b) => attackPower(b, ctx) - attackPower(a, ctx)).slice(0, 30);
	const out = [];
	const tryAdd = s => {
		s.key = JSON.stringify([s.ability, s.item, s.spread, [...s.moves].sort()]);
		if (s.key === set.key || out.some(o => o.key === s.key)) return;
		if (choiceWaste(s).length) return;
		if (F.validateSet(JSON.parse(JSON.stringify(s)))) return;
		out.push(s);
	};
	const clone = () => JSON.parse(JSON.stringify(set));
	// swap one move
	for (let k = 0; k < 10; k++) {
		const s = clone();
		const i = Math.floor(rng() * s.moves.length);
		const m = pool[Math.floor(rng() * pool.length)];
		if (!m || s.moves.some(x => F.toID(x) === m.id)) continue;
		s.moves[i] = m.name;
		s.archetype = set.archetype + '+';
		tryAdd(s);
	}
	// change item
	if (!entry.megaItem) {
		const itemPool = ['Life Orb', 'Choice Scarf', 'Focus Sash', 'Leftovers', 'Sitrus Berry', 'Lum Berry', 'Expert Belt',
			'Shell Bell', 'Muscle Band', 'Wise Glasses', 'Scope Lens', 'Quick Claw', "King's Rock",
			...Object.values(TYPE_ITEM)];
		for (let k = 0; k < 4; k++) {
			const s = clone();
			s.item = itemPool[Math.floor(rng() * itemPool.length)];
			tryAdd(s);
		}
	}
	// change spread / nature
	for (const spread of Object.keys(SPREADS)) {
		if (rng() > 0.35) continue;
		const s = clone();
		s.spread = spread; s.nature = SPREADS[spread].nature; s.evs = fullEvs(SPREADS[spread].evs);
		tryAdd(s);
	}
	// change ability
	for (const a of Object.values(species.abilities)) {
		if (a === ability.name) continue;
		const s = clone(); s.ability = a; tryAdd(s);
	}
	return out;
}

module.exports = {choiceWaste, wastedOnChoice, isChoice, rosterEntries, candidateSets, neighbours, SPREADS, TYPE_ITEM, curatedRoles, ROLE, BANNED_ATTACKS, SPECIAL_POWER, attackPower, effectiveness};
