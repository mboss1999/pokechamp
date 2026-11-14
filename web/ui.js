// Display helpers shared by the tabs.
import {showdownText} from './team.js';

export const TYPE_COLORS = {
	Normal: '#9a9a6e', Fire: '#e8742d', Water: '#5585e8', Electric: '#e3b81e', Grass: '#5fae3e', Ice: '#6cc8c8',
	Fighting: '#b32e28', Poison: '#9040a0', Ground: '#cfa94f', Flying: '#9580e8', Psychic: '#ee4f80', Bug: '#97a520',
	Rock: '#ae9636', Ghost: '#6a5394', Dragon: '#6a3cf0', Dark: '#6a5446', Steel: '#a5a5c4', Fairy: '#e489a3',
};
export const STAT_LABEL = {hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe'};

export const $ = sel => document.querySelector(sel);
export const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const pct = p => `${Math.round(p * 100)}%`;
export const pctClass = p => p >= 0.6 ? 'good' : p >= 0.45 ? 'ok' : 'bad';
// 1v1 matchup values are 0.5 ± half the HP the winner keeps; show them as a signed HP margin.
export const margin = p => {
	const m = Math.round((p - 0.5) * 200);
	return `<span class="pct ${pctClass(p)}" title="Average HP left after the 1v1 (+ wins, − loses)">${m > 0 ? '+' : m < 0 ? '−' : '±'}${Math.abs(m)}</span>`;
};

export function sprite(entry, cls = '') {
	const base = 'https://play.pokemonshowdown.com/sprites';
	const id = entry.sprite || entry.species.toLowerCase().replace(/[^a-z0-9-]/g, '');
	const baseId = entry.species.toLowerCase().replace(/[^a-z0-9]/g, '');
	// newer Champions Megas have no sprite yet: fall back to the dex sprite, then the base species
	const chain = [`${base}/dex/${id}.png`, `${base}/gen5/${baseId}.png`].join(' ');
	return `<img class="${cls}" src="${base}/gen5/${id}.png" alt="" loading="lazy" data-fallbacks="${chain}" ` +
		`onerror="const f=this.dataset.fallbacks.split(' ').filter(Boolean);if(f.length){this.src=f.shift();this.dataset.fallbacks=f.join(' ')}else{this.onerror=null}">`;
}
export const typeBadges = types => `<span class="types">${types.map(t =>
	`<span class="type" style="background:${TYPE_COLORS[t] || '#888'}">${t}</span>`).join('')}</span>`;
export const displayName = e => e.mega || e.species;
export const spText = sp => Object.entries(sp).map(([k, v]) => `${v} ${STAT_LABEL[k]}`).join(' / ');

export function setBox(entry, set, {copy = true, note = ''} = {}) {
	return `<div class="setbox">
		${copy ? `<button class="copy" data-copy="${esc(showdownText(entry, set))}">Copy</button>` : ''}
		<div class="line"><b>${esc(set.item || 'No item')}</b> · ${esc(set.ability)}</div>
		<div class="line">${esc(set.nature)} · ${esc(spText(set.statPoints))}</div>
		<ul>${set.moves.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
		${note ? `<div class="alt-note">${esc(note)}</div>` : ''}
	</div>`;
}
