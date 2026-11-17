import {makeScorer, buildTeams, assignSets, showdownText} from './team.js';
import {$, esc, pct, pctClass, margin, sprite, typeBadges, displayName, setBox} from './ui.js';
import {initTrainer} from './trainer.js';

const STORE_KEY = 'champions-collection-v1';
// Singles (BSS: bring 6, pick 3) or doubles (VGC: bring 6, pick 4). Your collection is shared by both.
const MODE_KEY = 'champions-format-v1';
const MODE = (() => { try { return localStorage.getItem(MODE_KEY) === 'doubles' ? 'doubles' : 'singles'; } catch { return 'singles'; } })();
const DOUBLES = MODE === 'doubles';
// what a matchup cell means, for labels
const MATCHUP_KIND = DOUBLES ? '2v2 with a meta partner each, HP margin' : '1v1 HP margin';

let results, scorer, species, owned, openSpecies = null, trainer = null;

function loadOwned() {
	try {
		return new Set(JSON.parse(localStorage.getItem(STORE_KEY) || '[]'));
	} catch {
		return new Set();
	}
}
function saveOwned() {
	try { localStorage.setItem(STORE_KEY, JSON.stringify([...owned])); } catch {}
	$('#owned-count').textContent = owned.size;
	syncCollection();
}

// The server precomputes tunings for the teams this collection builds, so they are ready before you look.
let syncTimer = null;
function syncCollection() {
	clearTimeout(syncTimer);
	syncTimer = setTimeout(() => {
		fetch('api/collection', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({owned: [...owned], includeMegas: $('#include-megas').checked}),
		}).catch(() => {});
	}, 800);
}

/** Group roster entries (base + Mega variants) by species and assign tiers. */
function groupSpecies(entries) {
	const map = new Map();
	entries.forEach((e, i) => {
		if (!map.has(e.species)) map.set(e.species, {species: e.species, entries: []});
		map.get(e.species).entries.push(i);
	});
	const list = [...map.values()];
	for (const s of list) {
		s.entries.sort((a, b) => entries[b].rating - entries[a].rating);
		s.best = entries[s.entries[0]];
		s.base = entries[s.entries.find(i => !entries[i].megaItem) ?? s.entries[0]];
		s.types = s.base.types;
		s.search = [s.species, ...s.entries.flatMap(i => [entries[i].mega || '', entries[i].set.item, entries[i].set.ability,
			...entries[i].set.moves, ...entries[i].types])].join(' ').toLowerCase();
	}
	list.sort((a, b) => b.best.rating - a.best.rating);
	const n = list.length;
	list.forEach((s, i) => {
		const q = i / n;
		s.rank = i + 1;
		s.tier = q < 0.05 ? 'S' : q < 0.2 ? 'A' : q < 0.5 ? 'B' : q < 0.8 ? 'C' : 'D';
	});
	return list;
}

function filteredSpecies() {
	const q = $('#search').value.trim().toLowerCase();
	const type = $('#type-filter').value;
	const own = $('#owned-filter').value;
	return species.filter(s => (!q || s.search.includes(q)) &&
		(!type || s.entries.some(i => results.entries[i].types.includes(type))) &&
		(own === 'all' || (own === 'owned') === owned.has(s.species)));
}

function renderRankings() {
	const rows = filteredSpecies().map(s => {
		const e = s.best;
		const megas = s.entries.filter(i => results.entries[i].megaItem).map(i => results.entries[i]);
		const megaNote = megas.length ? `<span class="megas">${megas.map(m =>
			`${esc(m.mega)} ${m.rating}`).join(' · ')}${s.base.megaItem ? '' : ` · no Mega ${s.base.rating}`}</span>` : '';
		const isOwned = owned.has(s.species);
		const row = `<tr class="row${isOwned ? ' owned' : ''}" data-species="${esc(s.species)}">
			<td class="num">${s.rank}</td>
			<td class="own"><input type="checkbox" ${isOwned ? 'checked' : ''} aria-label="Own ${esc(s.species)}"></td>
			<td><div class="mon">${sprite(e)}<div><span class="name">${esc(s.species)}</span>${typeBadges(s.types)}${megaNote}</div></div></td>
			<td><span class="tier tier-${s.tier}">${s.tier}</span></td>
			<td class="num"><b>${e.rating}</b>${e.games < 30 ? `<span class="lowdata" title="Only ${e.games} simulated team battles; rating is uncertain">?</span>` : ''}</td>
			<td class="num">${pct(e.pickRate)}</td>
			<td class="num">${e.games ? pct(e.winRateWhenPicked) : '–'}</td>
			<td class="set"><div class="set-short"><b>${esc(e.set.item)}</b> · ${esc(e.set.ability)} · ${esc(e.set.nature)}<br>${e.set.moves.map(esc).join(' / ')}</div></td>
		</tr>`;
		return row + (openSpecies === s.species ? detailRow(s) : '');
	});
	$('#ranking-table tbody').innerHTML = rows.join('') ||
		`<tr><td colspan="8" class="empty">No Pokémon match these filters.</td></tr>`;
}

function matchupList(i, best) {
	const {M, N, W} = scorer;
	const threats = results.entries.map((e, t) => t).filter(t => results.entries[t].species !== results.entries[i].species)
		.sort((a, b) => W[b] - W[a]).slice(0, 40);
	threats.sort((a, b) => best ? M[i * N + b] - M[i * N + a] : M[i * N + a] - M[i * N + b]);
	return `<ul class="mlist">${threats.slice(0, 6).map(t => {
		const e = results.entries[t], p = M[i * N + t];
		return `<li>${sprite(e)}${esc(displayName(e))}${margin(p)}</li>`;
	}).join('')}</ul>`;
}

function detailRow(s) {
	const cards = s.entries.map(i => {
		const e = results.entries[i];
		const alts = e.alts.map(a => `<details><summary>Alternative: ${esc(a.item)} (${pct(a.winRate)} sim win rate)</summary>${setBox(e, a)}</details>`).join('');
		return `<div class="card"><h3>${esc(displayName(e))} · ${e.rating}</h3>
			${setBox(e, e.set)}
			<div class="hint">Set won ${pct(e.setWinRate)} of its tuning battles.</div>${alts}</div>
			<div class="card"><h3>${esc(displayName(e))} beats (${MATCHUP_KIND})</h3>${matchupList(i, true)}</div>
			<div class="card"><h3>${esc(displayName(e))} struggles with</h3>${matchupList(i, false)}</div>`;
	}).join('');
	return `<tr class="detail"><td colspan="8"><div class="detail-grid">${cards}</div></td></tr>`;
}

// Teams currently on screen, each with its member sets and its tuning (precomputed by the server).
let shownTeams = [];

function renderTeams(teams) {
	const box = $('#team-results');
	if (!owned.size) {
		box.innerHTML = `<div class="empty">Mark the Pokémon you own on the Rankings tab, then build teams here.</div>`;
		return;
	}
	if (!teams) {
		box.innerHTML = `<div class="empty">You own ${owned.size} Pokémon. Press <b>Build best teams</b>.</div>`;
		return;
	}
	if (!teams.length) {
		box.innerHTML = `<div class="empty">No team could be built from your collection with these settings.</div>`;
		return;
	}
	shownTeams = teams.map(t => ({team: t, members: assignSets(results, t.members), refine: null}));
	box.innerHTML = shownTeams.map((_, n) => `<section class="team" id="team-${n}">${teamHtml(n)}</section>`).join('');
	trainer?.refresh();
	if (!DOUBLES) fetchTunings(); // team tuning is singles-only so far
}

// ---- tunings: fetched from the server, which has usually finished them already ----
let tuneGen = 0;

async function fetchTunings() {
	const gen = ++tuneGen;
	const teams = shownTeams;
	const askable = teams.filter(st => st.members.length >= 3);
	if (!askable.length) return;
	let keys;
	try {
		const resp = await fetch('api/tune', {
			method: 'POST',
			headers: {'Content-Type': 'application/json'},
			body: JSON.stringify({teams: askable.map(st => st.members.map(m => ({entryId: m.entry.id, set: m.set})))}),
		});
		const body = await resp.json().catch(() => ({}));
		if (!resp.ok) throw new Error(body.error || `Simulator unavailable (HTTP ${resp.status}). Start the app with ./start.sh.`);
		keys = body.keys;
		applyTunings(askable, body.jobs);
	} catch (e) {
		for (const st of askable) st.refine = {status: 'error', error: e.message};
		redrawAllTeams();
		return;
	}
	// follow the ones still in progress until they land
	while (gen === tuneGen && askable.some(st => st.refine && !['done', 'error'].includes(st.refine.status))) {
		await new Promise(r => setTimeout(r, 1500));
		if (gen !== tuneGen) return;
		try {
			const body = await (await fetch(`api/tune?keys=${keys.join(',')}`)).json();
			applyTunings(askable, body.jobs);
		} catch {}
	}
}

function applyTunings(teams, jobs) {
	teams.forEach((st, i) => {
		const job = jobs[i], prev = st.refine;
		st.refine = job;
		const n = shownTeams.indexOf(st);
		if (n < 0) return;
		// progress only: update just the panel so the page doesn't flicker; a finished tuning changes the sets
		if (prev && prev.status === job.status && job.status !== 'done') {
			const panel = document.querySelector(`#team-${n} .refine`);
			if (panel) panel.outerHTML = refinePanel(n);
		} else if (!prev || prev.status !== job.status) {
			redrawTeam(n);
			if (job.status === 'done') trainer?.refresh();
		}
	});
}


/** The sets to show for a team: tuned ones once a refinement has finished (and kept its changes). */
function teamMembers(n) {
	const st = shownTeams[n];
	const r = st.refine?.result;
	return st.members.map((m, i) => {
		const tuned = r && !r.revertedTuning ? r.members[i] : null;
		return {
			...m,
			set: tuned ? tuned.refined : m.set,
			changes: tuned ? tuned.changes : [],
			usage: r ? r.members[i] : null,
		};
	});
}

function teamHtml(n) {
	const st = shownTeams[n];
	const t = st.team;
	const members = teamMembers(n);
	const cov = scorer.coverage(t.members, 30);
	const sum = scorer.summary(t.members);
	const weak = cov.filter(c => c.best.p < 0.5);
	const exportText = members.map(m => showdownText(m.entry, m.set)).join('\n\n');
	const tuned = st.refine?.result && !st.refine.result.revertedTuning;
	return `
		<div class="team-head">
			<h2>Team ${n + 1}</h2>
			<span class="score" title="Weighted by how strong each opponent is in the simulations">
				Two solid answers to <b>${pct(sum.covered)}</b> of the meta · average answer margin ${margin(sum.answer)}</span>
			<div class="spacer"></div>
			<button class="ghost" data-copy="${esc(exportText)}">Copy ${tuned ? 'tuned ' : ''}team (Showdown format)</button>
		</div>
		${refinePanel(n)}
		<div class="members">${members.map(m => `<div class="card member${m.changes.length ? ' tuned' : ''}">
			<div class="mon">${sprite(m.entry)}<div><span class="name">${esc(displayName(m.entry))}</span><br>${typeBadges(m.entry.types)}</div></div>
			${setBox(m.entry, m.set, {copy: true, note: m.isAlt && !m.changes.length ? 'Alternate item (Item Clause)' : ''})}
			${m.changes.length ? `<div class="changes"><b>Tuned for this team</b>${m.changes.map(c => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
			${m.usage ? `<div class="usage">Brought ${pct(m.usage.bringRate)} · Leads ${pct(m.usage.leadRate)}</div>` : ''}
		</div>`).join('')}</div>
		<div class="card cover-wrap">
			<h3>Your best answer to each top threat (${MATCHUP_KIND}) ${weak.length ? `· <span class="bad">${weak.length} weak spot${weak.length > 1 ? 's' : ''}</span>` : ''}</h3>
			<div class="cover">${cov.map(c => {
				const th = results.entries[c.threat], ans = results.entries[c.best.m];
				return `<div class="cover-row">${sprite(th)}${esc(displayName(th))}<span class="arrow">←</span>${sprite(ans)}${margin(c.best.p)}</div>`;
			}).join('')}</div>
		</div>`;
}

const pts = x => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}`;

function refinePanel(n) {
	if (DOUBLES) return '';
	const r = shownTeams[n].refine;
	if (!r || r.status === 'unknown') {
		return `<div class="refine card"><div class="refine-text"><b>Tuning…</b> Connecting to the simulator.</div></div>`;
	}
	if (r.status === 'queued' || r.status === 'running') {
		const where = {lambda: 'on AWS Lambda', cloud: 'on a 64-core cloud machine'}[r.where] || 'on this computer';
		return `<div class="refine card"><div class="refine-text"><b>Tuning this team ${where}.</b> ${esc(r.message || '')}
			<span class="hint">The tuned sets appear here by themselves; nothing to wait for.</span></div>
			<div class="bar"><div style="width:${Math.round((r.progress || 0) * 100)}%"></div></div></div>`;
	}
	if (r.status === 'error') {
		return `<div class="refine card"><div class="refine-text bad">Tuning failed: ${esc(r.error || 'unknown error')}</div>
			<button class="ghost" data-refine-retry="${n}">Try again</button></div>`;
	}
	const res = r.result;
	const changed = res.members.filter(m => m.changes.length).length;
	let headline;
	if (res.revertedTuning) {
		headline = `Tried changes didn't hold up on fresh battles, so your sets are unchanged.`;
	} else if (!changed) {
		headline = `No change beat your current sets reliably. They already suit this team.`;
	} else {
		headline = `Tuned ${changed} set${changed > 1 ? 's' : ''}: win rate vs meta teams
			<b>${pct(res.before.winRate)} → ${pct(res.after.winRate)}</b>
			<span class="${res.improvement.diff > 2 * res.improvement.se ? 'good' : 'ok'}">(${pts(res.improvement.diff)} ± ${(res.improvement.se * 196).toFixed(1)} pts)</span>`;
	}
	const threats = res.threats.map(t => {
		const e = results.entries[scorer.index.get(t.entryId)];
		return `<li>${sprite(e)}${esc(displayName(e))}<span class="pct ${pctClass(t.winRate)}">${pct(t.winRate)}</span></li>`;
	}).join('');
	const how = r.cached ? 'precomputed' :
		`simulated in ${r.seconds ?? '?'}s ${{lambda: 'on AWS Lambda', cloud: 'on a cloud machine'}[r.where] || 'on this computer'}`;
	return `<div class="refine card done">
		<div class="refine-text">${headline}<br>
			<span class="hint">Tuned and validated: your team won ${pct(res.after.winRate)} of ${res.after.games.toLocaleString()} full 6v6 battles against strong meta teams${res.strongBattles ? ', played by the strong (rollout) AI' : ''}
			(${(res.battles + (res.strongBattles || 0)).toLocaleString()} battles, ${how}).</span></div>
		${threats ? `<details><summary>Toughest opponents (your win rate when they were brought)</summary><ul class="mlist">${threats}</ul></details>` : ''}
	</div>`;
}

function redrawTeam(n) {
	const el = document.getElementById(`team-${n}`);
	if (el) el.innerHTML = teamHtml(n);
}
function redrawAllTeams() {
	shownTeams.forEach((_, n) => redrawTeam(n));
}

function build() {
	const btn = $('#build');
	btn.disabled = true;
	btn.textContent = 'Building…';
	setTimeout(() => {
		const teams = buildTeams(results, owned, {
			scorer, teams: 5, includeMegas: $('#include-megas').checked,
		});
		renderTeams(teams);
		btn.disabled = false;
		btn.textContent = 'Build best teams';
	}, 20);
}

// ---- strongest teams (web/data/strategies.json, from sim/strategies.js) ----
let strategies;

function strategyTeamHtml(t, title, score) {
	const byId = new Map(results.entries.map(e => [e.id, e]));
	const members = t.members.map(m => ({...m, entry: byId.get(m.entryId)})).filter(m => m.entry);
	const exportText = members.map(m => showdownText(m.entry, m.set)).join('\n\n');
	return `<section class="team">
		<div class="team-head"><h2>${esc(title)}</h2><span class="score">${score}</span><div class="spacer"></div>
			<button class="ghost" data-copy="${esc(exportText)}">Copy team (Showdown format)</button></div>
		<div class="members">${members.map(m => `<div class="card member${m.changes && m.changes.length ? ' tuned' : ''}">
			<div class="mon">${sprite(m.entry)}<div><span class="name">${esc(displayName(m.entry))}</span><br>${typeBadges(m.entry.types)}</div></div>
			${setBox(m.entry, m.set, {copy: true})}
			${m.changes && m.changes.length ? `<div class="changes"><b>Tuned against the ladder</b>${m.changes.map(c => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
			${m.bringRate !== undefined ? `<div class="usage">Brought ${pct(m.bringRate)} · Leads ${pct(m.leadRate)}</div>` : ''}
		</div>`).join('')}</div>
		${t.threats && t.threats.length ? `<div class="card cover-wrap"><h3>Ladder Pokémon it struggles with most (win rate when they're brought)</h3>
			<div class="cover">${t.threats.map(th => { const e = byId.get(th.entryId); return e ? `<div class="cover-row">${sprite(e)}${esc(displayName(e))} ${pct(th.winRate)}</div>` : ''; }).join('')}</div></div>` : ''}
	</section>`;
}

async function renderStrongest() {
	const box = $('#strongest-results');
	if (strategies === undefined) {
		try {
			const resp = await fetch('data/strategies.json');
			strategies = resp.ok ? await resp.json() : null;
		} catch { strategies = null; }
	}
	if (!strategies) {
		box.innerHTML = `<div class="empty">No team-level results yet. They come from sim/team-search.js, sim/double-oracle.js and sim/strategies.js.</div>`;
		return;
	}
	const pm = (x, se) => `${(100 * x).toFixed(1)}%${se ? ` ± ${(100 * se).toFixed(1)}` : ''}`;
	let html = '';
	if (strategies.ladder) {
		html += `<h2 class="section">Best against today's ladder</h2><p class="hint">${esc(strategies.ladder.fieldInfo || '')}</p>`;
		html += strategies.ladder.teams.map((t, i) => strategyTeamHtml(t, `Ladder team ${i + 1}`,
			`Wins <b>${pm(t.winRate, t.se)}</b> against ladder teams` + (t.measure === 'preview game'
				? ' (strong AI; both sides choose their three as well as possible)' : ' (strong AI on both sides)'))).join('');
	}
	if (!strategies.ladder) {
		html += `<h2 class="section">Best against today's ladder</h2><p class="hint">Being recomputed. The first search's gains came
			mostly from how the AI picks its three at team preview, not from stronger teams, so its teams are withheld until
			they're re-scored with good preview play on both sides.</p>`;
	}
	if (strategies.equilibrium) {
		const eq = strategies.equilibrium;
		html += `<h2 class="section">Theoretically strongest (equilibrium)</h2><p class="hint">${eq.converged
			? `No team the search could find beats this mix by more than ${(100 * eq.eps).toFixed(0)} point${eq.eps === 0.01 ? '' : 's'} (${esc(eq.reason)}).`
			: 'Not converged yet: a stronger team may still exist.'} Built from ${eq.population} teams. Play the teams in these proportions;
			any single one can be exploited by an opponent who knows you'll bring it.</p>`;
		html += eq.teams.map((t, i) => strategyTeamHtml(t, `Equilibrium team ${i + 1}`,
			`Weight <b>${pm(t.weight)}</b> · ${pm(t.vsMix)} against the mix`)).join('');
	}
	box.innerHTML = html;
}

function selectTab(name) {
	for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
	for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== name;
	if (name === 'teams' && !$('#team-results').innerHTML) renderTeams(null);
	if (name === 'draft') trainer?.refresh();
	if (name === 'strongest') renderStrongest();
}

function wire() {
	for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => selectTab(b.dataset.tab));
	for (const id of ['#search', '#type-filter', '#owned-filter']) $(id).addEventListener('input', renderRankings);
	$('#ranking-table tbody').addEventListener('click', ev => {
		const row = ev.target.closest('tr.row');
		if (!row) return;
		const name = row.dataset.species;
		if (ev.target.matches('input[type=checkbox]')) {
			if (ev.target.checked) owned.add(name); else owned.delete(name);
			saveOwned();
			row.classList.toggle('owned', ev.target.checked);
			$('#team-results').innerHTML = '';
			return;
		}
		openSpecies = openSpecies === name ? null : name;
		renderRankings();
	});
	$('#own-visible').addEventListener('click', () => {
		for (const s of filteredSpecies()) owned.add(s.species);
		saveOwned(); renderRankings(); $('#team-results').innerHTML = '';
	});
	$('#clear-owned').addEventListener('click', () => {
		if (!owned.size || !confirm(`Remove all ${owned.size} Pokémon from your collection?`)) return;
		owned.clear(); saveOwned(); renderRankings(); $('#team-results').innerHTML = '';
	});
	$('#io-collection').addEventListener('click', () => {
		$('#io-text').value = [...owned].sort().join('\n');
		$('#io-dialog').showModal();
	});
	$('#io-apply').addEventListener('click', ev => {
		const known = new Map(species.map(s => [s.species.toLowerCase(), s.species]));
		const lines = $('#io-text').value.split(/[\n,]+/).map(l => l.trim().toLowerCase()).filter(Boolean);
		const unknown = lines.filter(l => !known.has(l));
		if (unknown.length && !confirm(`Not recognised (will be skipped): ${unknown.join(', ')}\n\nContinue?`)) {
			ev.preventDefault();
			return;
		}
		owned = new Set(lines.filter(l => known.has(l)).map(l => known.get(l)));
		saveOwned(); renderRankings(); $('#team-results').innerHTML = '';
	});
	$('#build').addEventListener('click', build);
	$('#include-megas').addEventListener('change', syncCollection);
	$('#team-results').addEventListener('click', ev => {
		if (ev.target.closest('[data-refine-retry]')) fetchTunings();
	});
	document.addEventListener('click', ev => {
		const btn = ev.target.closest('[data-copy]');
		if (!btn) return;
		ev.stopPropagation();
		navigator.clipboard.writeText(btn.dataset.copy).then(() => {
			const old = btn.textContent;
			btn.textContent = 'Copied';
			setTimeout(() => { btn.textContent = old; }, 1200);
		});
	});
}

function wireMode() {
	for (const b of document.querySelectorAll('.mode button')) {
		b.setAttribute('aria-pressed', String(b.dataset.mode === MODE));
		b.addEventListener('click', () => {
			if (b.dataset.mode === MODE) return;
			try { localStorage.setItem(MODE_KEY, b.dataset.mode); } catch {}
			location.reload();
		});
	}
}

async function main() {
	wireMode();
	const file = DOUBLES ? 'data/doubles-results.json' : 'data/results.json';
	try {
		const resp = await fetch(file);
		if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
		results = await resp.json();
	} catch (e) {
		$('#meta').textContent = `No ${MODE} simulation results found. Run the pipeline to create web/${file}.`;
		return;
	}
	if (DOUBLES) {
		// team preview practice and team tuning run the singles simulator for now
		document.querySelector('.tabs button[data-tab=draft]').hidden = true;
		document.querySelector('.tabs button[data-tab=strongest]').hidden = true;
		$('#rankings-hint').textContent = 'Tick the Pokémon you have. Ratings come from simulated bring-6-pick-4 doubles battles; ' +
			'click a row for its sets and matchups.';
	}
	scorer = makeScorer(results);
	species = groupSpecies(results.entries);
	owned = loadOwned();
	const m = results.meta;
	$('#meta').textContent = `${m.format} · ${species.length} Pokémon, ${results.entries.length} sets · ` +
		`${m.ladderGames.toLocaleString()} simulated team battles · updated ${new Date(m.generatedAt).toLocaleDateString()}`;
	const types = [...new Set(results.entries.flatMap(e => e.types))].sort();
	$('#type-filter').insertAdjacentHTML('beforeend', types.map(t => `<option>${t}</option>`).join(''));
	saveOwned();
	wire();
	renderRankings();
	// the draft trainer drafts with your built teams (tuned sets included), building them if you haven't yet
	if (!DOUBLES) trainer = initTrainer({results, getBuiltTeams: () => {
		if (!shownTeams.length && owned.size) {
			renderTeams(buildTeams(results, owned, {scorer, teams: 5, includeMegas: $('#include-megas').checked}));
		}
		return shownTeams.map((_, n) => teamMembers(n).map(({entry, set}) => ({entry, set})));
	}});
}

main();
