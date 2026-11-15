'use strict';
// Format constants and the legal roster for Pokémon Champions ranked singles
// (Showdown: [Gen 9 Champions] BSS Reg M-C — bring 6, pick 3, level 50).

const {Dex, TeamValidator, toID} = require('pokemon-showdown');

const FORMAT_ID = process.env.FORMAT || 'gen9championsbssregmc';
const format = Dex.formats.get(FORMAT_ID);
const dex = Dex.forFormat(format);
const validator = new TeamValidator(format);

const STAT_POINT_TOTAL = 66;
const STAT_POINT_MAX = 32;
const TEAM_SIZE = 6;
const PICK_SIZE = Dex.formats.getRuleTable(format).pickedTeamSize || 3; // 3 in singles (BSS), 4 in doubles (VGC)
const GAME_TYPE = format.gameType; // 'singles' | 'doubles'

// Collapse purely cosmetic formes (Vivillon patterns, Alcremie flavours, ...)
// into their base species so the roster lists each "real" Pokémon once.
function isCosmetic(species) {
	const base = dex.species.get(species.baseSpecies);
	return species.forme && base.cosmeticFormes && base.cosmeticFormes.includes(species.name);
}

let rosterCache = null;
/** Selectable species (what you can own); Mega formes are reached through items. */
function legalRoster() {
	if (rosterCache) return rosterCache;
	const out = [];
	for (const s of dex.species.all()) {
		if (s.isNonstandard || s.battleOnly || isCosmetic(s)) continue;
		if (s.isMega || s.forme === 'Gmax' || s.isTotem) continue;
		if (validator.ruleTable.isBannedSpecies(s)) continue;
		const problem = validator.checkSpecies(
			{name: s.name, species: s.name, moves: [], ability: '', item: '', evs: {}, ivs: {}}, s, s, {}
		);
		if (problem) continue;
		out.push(s);
	}
	rosterCache = out;
	return out;
}

let itemCache = null;
function legalItems() {
	if (itemCache) return itemCache;
	itemCache = dex.items.all().filter(i => !i.isNonstandard && !validator.ruleTable.isBanned('item:' + i.id));
	return itemCache;
}

/** Mega stones usable by this species, with the resulting Mega forme. */
function megaOptions(species) {
	const out = [];
	for (const item of legalItems()) {
		if (!item.megaStone) continue;
		const map = typeof item.megaStone === 'string' ? {[item.megaEvolves]: item.megaStone} : item.megaStone;
		for (const [from, to] of Object.entries(map)) {
			if (toID(from) === species.id) out.push({item: item.name, mega: dex.species.get(to)});
		}
	}
	return out;
}

const learnCache = new Map();
function learnableMoves(species) {
	if (learnCache.has(species.id)) return learnCache.get(species.id);
	const moves = [];
	for (const m of dex.moves.all()) {
		if (m.isNonstandard || m.isZ || m.isMax) continue;
		if (validator.ruleTable.isBanned('move:' + m.id)) continue;
		if (!validator.checkCanLearn(m, species)) moves.push(m);
	}
	learnCache.set(species.id, moves);
	return moves;
}

function validateSet(set) {
	return validator.validateSet(set, {});
}

function validateTeam(team) {
	return validator.validateTeam(team);
}

module.exports = {
	Dex, dex, format, FORMAT_ID, toID, validator,
	STAT_POINT_TOTAL, STAT_POINT_MAX, TEAM_SIZE, PICK_SIZE, GAME_TYPE,
	legalRoster, legalItems, megaOptions, learnableMoves, validateSet, validateTeam,
};
