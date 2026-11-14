'use strict';
// Small helpers shared by the offline pipeline and the team refiner.

function mulberry32(a) {
	return () => {
		a |= 0; a = a + 0x6D2B79F5 | 0;
		let t = Math.imul(a ^ a >>> 15, 1 | a);
		t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
		return ((t ^ t >>> 14) >>> 0) / 4294967296;
	};
}

function hash(str) {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
	return h >>> 0;
}

const seedFrom = rng => [0, 0, 0, 0].map(() => Math.floor(rng() * 65536));

/** Strip our bookkeeping fields so only a plain PokemonSet goes to the simulator. */
function clean(set) {
	const {name, species, item, ability, nature, evs, ivs, moves, level} = set;
	return {name, species, item, ability, nature, evs, ivs, moves, level};
}

/** Stable identity for a set, used to dedupe candidates. */
function setKey(set) {
	return JSON.stringify([set.ability, set.item, set.nature, set.evs, [...set.moves].sort()]);
}

/** True for the result of a battle or job that could not be played (sim/pool.js), as opposed to a drawn battle. */
const isFailed = r => !!(r && r.failed);

module.exports = {mulberry32, hash, seedFrom, clean, setKey, isFailed};
