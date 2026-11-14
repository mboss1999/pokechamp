// Draft practice: pick three and a lead against an opponent you only see by species, then compare your pick
// with the simulated team preview analysis (sim/draft.js, run through web/serve.cjs).
import {$, esc, pct, sprite, typeBadges, displayName} from './ui.js';

const HISTORY_KEY = 'champions-draft-history-v1';
// What a pick costs, in win probability, before it counts as a mistake.
const VERDICTS = [
	{max: 0.02, label: 'Best-level pick', cls: 'good'},
	{max: 0.05, label: 'Inaccuracy', cls: 'ok'},
	{max: 0.10, label: 'Mistake', cls: 'bad'},
	{max: Infinity, label: 'Blunder', cls: 'bad'},
];

let results, getBuiltTeams, entryByKey;
let drill = null; // the matchup on screen
let next = null; // the following matchup, prepared in the background
let history = loadHistory();

const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function loadHistory() {
	try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
}
function saveHistory() {
	try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-200))); } catch {}
}

/** The non-Mega roster entry for a species (for sprites and types), or a bare stand-in. */
function entryFor(species) {
	return entryByKey.get(key(species)) || {species, types: []};
}

/** Species from a pasted list: one per line or comma, or a Showdown team export. */
function parseSpecies(text) {
	if (/@|Ability:|\n\s*-\s/.test(text)) {
		return text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(block => {
			let head = block.split('\n')[0].split(' @ ')[0].replace(/\((M|F)\)/g, '').trim();
			const inner = /\(([^)]+)\)\s*$/.exec(head);
			return inner ? inner[1].trim() : head;
		});
	}
	return text.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
}

/** Showdown team export -> [{species, item, moves}] for display (the server does the real import). */
function parsePasteForDisplay(text) {
	return text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).map(block => {
		const lines = block.split('\n');
		const species = parseSpecies(block)[0];
		const item = (lines[0].split(' @ ')[1] || '').trim();
		return {species, item, moves: lines.filter(l => /^\s*-\s/.test(l)).map(l => l.replace(/^\s*-\s*/, '').trim())};
	});
}

/** A random opponent drawn the way the ladder simulations draw them: stronger Pokémon more often. */
function randomMetaSpecies() {
	const {entries} = results;
	const w = entries.map(e => Math.exp((e.rating - 1500) / 120));
	const total = w.reduce((a, b) => a + b, 0);
	const out = new Set();
	while (out.size < 6) {
		let r = Math.random() * total, i = 0;
		while ((r -= w[i]) > 0 && i < entries.length - 1) i++;
		out.add(entries[i].species);
	}
	return [...out];
}

// ------------------------------------------------------------------ team sources

function teamSource() {
	const v = $('#dt-team').value;
	if (v === 'paste') {
		const text = $('#dt-team-paste').value.trim();
		const mons = parsePasteForDisplay(text);
		if (mons.length < 3 || mons.length > 6) throw new Error('Paste a Showdown team of 3 to 6 Pokémon.');
		return {label: 'Pasted team', paste: text, mons};
	}
	const teams = getBuiltTeams();
	const t = teams[Number(v)];
	if (!t) throw new Error('Build teams on the Build teams tab first, or paste a team.');
	return {label: `Team ${Number(v) + 1}`, members: t, mons: t.map(m => ({species: m.entry.species, entry: m.entry, item: m.set.item, moves: m.set.moves}))};
}

function opponentSource() {
	if ($('#dt-opp').value === 'paste') {
		const list = parseSpecies($('#dt-opp-paste').value);
		if (list.length < 3 || list.length > 6) throw new Error('Paste 3 to 6 opposing species.');
		return {list, random: false};
	}
	return {list: randomMetaSpecies(), random: true};
}

function renderSetup() {
	const teams = getBuiltTeams();
	const sel = $('#dt-team');
	const cur = sel.value;
	sel.innerHTML = teams.map((t, n) => `<option value="${n}">Team ${n + 1}: ${esc(t.map(m => displayName(m.entry)).join(', '))}</option>`).join('') +
		`<option value="paste">Paste a Showdown team…</option>`;
	// keep the current choice, except an empty "paste" left over from before any team was built
	const keep = [...sel.options].some(o => o.value === cur) && !(cur === 'paste' && teams.length && !$('#dt-team-paste').value.trim());
	sel.value = keep ? cur : (teams.length ? '0' : 'paste');
	$('#dt-team-paste').hidden = sel.value !== 'paste';
	$('#dt-opp-paste').hidden = $('#dt-opp').value !== 'paste';
}

// ------------------------------------------------------------------ analysis jobs

/** Ask the server to analyse a matchup; returns a handle whose .job updates as it runs. */
function startAnalysis(team, theirs, budget) {
	const handle = {job: {status: 'running', progress: 0}, listeners: new Set()};
	const notify = () => handle.listeners.forEach(f => f());
	handle.done = (async () => {
		try {
			const body = {theirs, budget};
			if (team.paste) body.minePaste = team.paste;
			else body.mine = team.members.map(m => ({entryId: m.entry.id, set: m.set}));
			const resp = await fetch('api/draft', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
			const out = await resp.json().catch(() => ({}));
			if (!resp.ok) throw new Error(out.error || `Simulator unavailable (HTTP ${resp.status}). Start the app with ./start.sh.`);
			for (;;) {
				await new Promise(r => setTimeout(r, 1000));
				handle.job = await (await fetch(`api/draft/${out.jobId}`)).json();
				notify();
				if (handle.job.status !== 'running') break;
			}
		} catch (e) {
			handle.job = {status: 'error', error: e.message};
			notify();
		}
	})();
	return handle;
}

function newDrill(team, opp, budget) {
	const d = {team, theirs: opp.list, random: opp.random, budget, selected: [], locked: false};
	d.analysis = startAnalysis(team, opp.list, budget);
	d.analysis.listeners.add(() => onAnalysisUpdate(d));
	return d;
}

function onAnalysisUpdate(d) {
	if (d !== drill) return;
	if (d.analysis.job.status === 'running') {
		const el = $('#dt-progress');
		if (el) el.innerHTML = progressHtml(d);
		return;
	}
	if (d.locked && d.analysis.job.status === 'done') record(d);
	renderBoard();
	prepareNext();
}

/** Once the current analysis is finished, start the next random matchup so it's ready when you are. */
function prepareNext() {
	if (!drill || !drill.random || drill.analysis.job.status === 'running' || next) return;
	next = newDrill(drill.team, {list: randomMetaSpecies(), random: true}, drill.budget);
}

function start() {
	let team, opp;
	try {
		team = teamSource();
		opp = opponentSource();
	} catch (e) {
		$('#dt-error').textContent = e.message;
		return;
	}
	$('#dt-error').textContent = '';
	next = null;
	drill = newDrill(team, opp, $('#dt-budget').value);
	renderBoard();
}

function nextMatchup() {
	if (next && next.team === drill.team) {
		drill = next;
		next = null;
		renderBoard();
		onAnalysisUpdate(drill);
		return;
	}
	drill = newDrill(drill.team, {list: randomMetaSpecies(), random: true}, drill.budget);
	next = null;
	renderBoard();
}

// ------------------------------------------------------------------ picking

/** The analysis option matching the current pick (lead first, back two in team order). */
function pickedOption(d, res) {
	const [lead, ...back] = d.selected;
	back.sort((a, b) => a - b);
	return res.options.find(o => o.option[0] === lead && o.option[1] === back[0] && o.option[2] === back[1]);
}

function toggle(slot) {
	if (drill.locked) return;
	const i = drill.selected.indexOf(slot);
	if (i >= 0) drill.selected.splice(i, 1);
	else if (drill.selected.length < 3) drill.selected.push(slot);
	renderBoard();
}

function makeLead(slot) {
	if (drill.locked) return;
	drill.selected = [slot, ...drill.selected.filter(s => s !== slot)];
	renderBoard();
}

function lockIn() {
	if (drill.selected.length !== 3) return;
	drill.locked = true;
	if (drill.analysis.job.status === 'done') record(drill);
	renderBoard();
}

function record(d) {
	if (d.recorded) return;
	const res = d.analysis.job.result;
	const o = pickedOption(d, res);
	if (!o) return;
	d.recorded = true;
	const best = res.options[0];
	const name = opt => [res.mine[opt[0]], res.mine[opt[1]], res.mine[opt[2]]];
	history.push({
		at: Date.now(), team: d.team.label, theirs: d.theirs,
		pick: name(o.option), best: name(best.option), loss: o.loss, lossSe: o.lossSe, value: o.value, bestValue: best.value,
	});
	saveHistory();
	renderHistory();
}

// ------------------------------------------------------------------ rendering

const verdictFor = loss => VERDICTS.find(v => loss < v.max);
const pts = x => `${(x * 100).toFixed(1)}`;

function progressHtml(d) {
	const j = d.analysis.job;
	if (j.status === 'error') return `<span class="bad">${esc(j.error)}</span>`;
	if (j.status === 'done') return `Analysis ready (${j.result.battles.toLocaleString()} battles in ${j.seconds}s).`;
	return `<span>Simulating team preview in the background… ${Math.round((j.progress || 0) * 100)}%</span>
		<div class="bar"><div style="width:${Math.round((j.progress || 0) * 100)}%"></div></div>`;
}

function monCard(m, slot) {
	const sel = drill.selected.indexOf(slot);
	const role = sel === 0 ? 'Lead' : sel > 0 ? 'Back' : '';
	const entry = m.entry || entryFor(m.species);
	return `<div class="card pickable${sel >= 0 ? ' picked' : ''}${sel === 0 ? ' lead' : ''}" data-slot="${slot}">
		${role ? `<span class="role">${role}</span>` : ''}
		<div class="mon">${sprite(entry)}<div><span class="name">${esc(m.entry ? displayName(m.entry) : m.species)}</span><br>${typeBadges(entry.types || [])}</div></div>
		<div class="set-short"><b>${esc(m.item || 'No item')}</b><br>${m.moves.map(esc).join(' / ')}</div>
		${sel > 0 && !drill.locked ? `<button class="ghost small" data-lead="${slot}">Make lead</button>` : ''}
	</div>`;
}

function renderBoard() {
	const box = $('#dt-board');
	if (!drill) {
		box.innerHTML = '';
		return;
	}
	const d = drill;
	const theirs = d.theirs.map(sp => {
		const e = entryFor(sp);
		return `<div class="opp">${sprite(e)}<div><span class="name">${esc(sp)}</span><br>${typeBadges(e.types || [])}</div></div>`;
	}).join('');
	const pickHint = d.locked ? '' : d.selected.length < 3
		? `Choose ${3 - d.selected.length} more. The first one you choose leads.`
		: 'Ready. Lock in when you are happy with your lead and back two.';
	box.innerHTML = `
		<div class="card">
			<h3>Opponent (you only see species)</h3>
			<div class="opp-row">${theirs}</div>
		</div>
		<div class="draft-mine">
			<div class="draft-head"><h3>${esc(d.team.label)}: bring 3</h3><span class="hint">${pickHint}</span>
				<div class="spacer"></div>
				<button class="primary" id="dt-lock" ${d.locked || d.selected.length !== 3 ? 'disabled' : ''}>Lock in</button></div>
			<div class="members">${d.team.mons.map(monCard).join('')}</div>
		</div>
		<div class="hint" id="dt-progress">${progressHtml(d)}</div>
		${d.locked ? verdictHtml(d) : ''}`;
}

function verdictHtml(d) {
	const j = d.analysis.job;
	if (j.status === 'running') return `<div class="card"><b>Locked in.</b> Waiting for the analysis to finish…</div>`;
	if (j.status !== 'done') return '';
	const res = j.result;
	const o = pickedOption(d, res);
	if (!o) return `<div class="card bad">Couldn't match your pick to the analysis.</div>`;
	const best = res.options[0];
	const rank = res.options.indexOf(o) + 1;
	const v = verdictFor(o.loss);
	const noisy = o.loss > 0 && o.loss < 1.96 * o.lossSe;
	const nameOf = opt => `<b>${esc(res.mine[opt[0]])}</b> leading, ${esc(res.mine[opt[1]])} + ${esc(res.mine[opt[2]])}`;
	const support = res.options.filter(x => x.mix > 0.01);
	const top = res.options.slice(0, 8);
	if (!top.includes(o)) top.push(o);
	return `<div class="card verdict">
		<div class="verdict-head"><span class="verdict-label ${v.cls}">${v.label}</span>
			<span>Your pick (${nameOf(o.option)}) wins about <b>${pct(o.value)}</b>; the best pick wins about <b>${pct(best.value)}</b>.
			${o.loss > 0.001 ? `It costs ${pts(o.loss)} ± ${pts(1.96 * o.lossSe)} points${noisy ? ' (within the simulation’s noise)' : ''}.` : ''}
			Rank ${rank} of ${res.options.length}.</span></div>
		<p class="hint">Against an opponent who picks well, the best play mixes ${support.length > 1 ? 'these options; they are equally good' : 'nothing: one option is best'}:
			${support.map(x => `${nameOf(x.option)} (${pct(x.mix)})`).join(' · ')}</p>
		<div class="verdict-grid">
			<div>
				<h3>Best options</h3>
				<table class="mini"><thead><tr><th>#</th><th>Lead</th><th>Back</th><th class="num">Win</th></tr></thead><tbody>
				${top.map(x => `<tr class="${x === o ? 'mine' : ''}"><td>${res.options.indexOf(x) + 1}</td><td>${esc(x.lead)}</td>
					<td>${esc(x.back.join(' + '))}</td><td class="num">${pct(x.value)} <span class="muted">±${Math.round(196 * x.se)}</span></td></tr>`).join('')}
				</tbody></table>
			</div>
			<div>
				<h3>What they bring (their best mix)</h3>
				<table class="mini"><thead><tr><th>Lead</th><th>Back</th><th class="num">How often</th><th class="num">You</th><th class="num">Best</th></tr></thead><tbody>
				${res.theirMix.map((t, k) => `<tr><td>${esc(t.lead)}</td><td>${esc(t.back.join(' + '))}</td><td class="num">${pct(t.p)}</td>
					<td class="num">${pct(o.vsTheirs[k])}</td><td class="num">${pct(best.vsTheirs[k])}</td></tr>`).join('')}
				</tbody></table>
			</div>
		</div>
		<p class="hint">Win rates come from ${res.battles.toLocaleString()} simulated battles with their sets guessed from the meta.
			± is a 95% range. Differences of a few points are within the noise at this budget.</p>
		<div class="draft-actions">
			<button class="primary" id="dt-next">${drill.random ? 'Next matchup' : 'New random matchup'}</button>
			<button class="ghost" id="dt-retry">Pick again</button>
		</div>
	</div>`;
}

function renderHistory() {
	const box = $('#dt-history');
	if (!history.length) {
		box.innerHTML = '';
		return;
	}
	const recent = history.slice(-20).reverse();
	const avg = history.slice(-20).reduce((s, h) => s + h.loss, 0) / Math.min(20, history.length);
	const counts = VERDICTS.map(v => history.slice(-20).filter(h => verdictFor(h.loss) === v).length);
	box.innerHTML = `<div class="card"><h3>Your last ${recent.length} drafts</h3>
		<p>Average cost <b>${pts(avg)}</b> points per draft · ${VERDICTS.map((v, i) => `<span class="${v.cls}">${counts[i]} ${v.label.toLowerCase()}</span>`).join(' · ')}</p>
		<table class="mini"><thead><tr><th>When</th><th>vs</th><th>You</th><th>Best</th><th class="num">Cost</th></tr></thead><tbody>
		${recent.map(h => {
			const v = verdictFor(h.loss);
			return `<tr><td>${new Date(h.at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</td>
				<td class="muted">${esc(h.theirs.join(', '))}</td><td>${esc(h.pick.join(', '))}</td><td>${esc(h.best.join(', '))}</td>
				<td class="num ${v.cls}">${pts(h.loss)}</td></tr>`;
		}).join('')}</tbody></table>
		<button class="ghost small" id="dt-clear-history">Clear history</button></div>`;
}

export function initTrainer(ctx) {
	results = ctx.results;
	getBuiltTeams = ctx.getBuiltTeams;
	entryByKey = new Map();
	// prefer the non-Mega entry for a species' sprite and types
	for (const e of results.entries) if (!e.megaItem || !entryByKey.has(key(e.species))) entryByKey.set(key(e.species), e);
	renderSetup();
	renderHistory();
	$('#dt-team').addEventListener('change', renderSetup);
	$('#dt-opp').addEventListener('change', renderSetup);
	$('#dt-start').addEventListener('click', start);
	$('#dt-board').addEventListener('click', ev => {
		const lead = ev.target.closest('[data-lead]');
		if (lead) { makeLead(Number(lead.dataset.lead)); return; }
		const card = ev.target.closest('[data-slot]');
		if (card) { toggle(Number(card.dataset.slot)); return; }
		if (ev.target.closest('#dt-lock')) lockIn();
		if (ev.target.closest('#dt-next')) nextMatchup();
		if (ev.target.closest('#dt-retry')) {
			drill.locked = false;
			drill.selected = [];
			renderBoard();
		}
	});
	$('#dt-history').addEventListener('click', ev => {
		if (!ev.target.closest('#dt-clear-history') || !confirm('Clear your draft practice history?')) return;
		history = [];
		saveHistory();
		renderHistory();
	});
	return {refresh: renderSetup};
}
