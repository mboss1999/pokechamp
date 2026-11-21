// Why a team preview pick is good or bad, in words, from the draft analysis (sim/draft.js via web/serve.cjs, or the
// precomputed drill bank) and the 1v1 matrix of results.json. Pure functions, no DOM: node can import this for tests.
//
// The verdict itself always comes from the team analysis (full 3v3 battles). The reasons are read off that same
// analysis where possible:
//   - the smallest change to your pick that recovers most of the cost (a neighbouring option's value)
//   - which of the opponent's likely replies the points are lost against (the vsTheirs columns)
//   - what the best mix brings that you left home, or brings never that you brought (equilibrium bring rates)
// and, as the Pokémon-level "why", from the 1v1 matrix (separate simulated 1v1s with their usual sets):
//   - their likely Pokémon that nothing in your three beats 1v1, but something in the best pick does
//   - your lead against their likely leads

const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pts = x => `${(x * 100).toFixed(1)}`;
const pc = p => `${Math.round(p * 100)}%`;
const hp = v => { const m = Math.round(v * 200); return `${m > 0 ? '+' : m < 0 ? '−' : '±'}${Math.abs(m)}`; };

/** Options as sets: same three brought, and who leads. */
const trio = opt => [...opt].sort((a, b) => a - b).join(',');

/**
 * @param res   analysis result: {mine, theirs, options: [{option, value, loss, lossSe, se, mix, vsTheirs}], theirMix: [{option, p}]}
 * @param o     the player's option (an element of res.options)
 * @param ctx   {names: display names of my slots (default res.mine), oneVsOne(i, j): my slot i vs their slot j,
 *              value in [-0.5, 0.5] (HP margin / 2), or null when unknown}
 * @returns {mistake, noisy, points: [{tone: 'bad'|'good'|'info', html}], footnote}
 */
export function explainPick(res, o, ctx = {}) {
	const names = ctx.names || res.mine;
	const theirs = res.theirs;
	const vs = ctx.oneVsOne || (() => null);
	const best = res.options[0];
	const n = res.mine.length;
	const noisy = o.loss < Math.max(0.015, 1.96 * (o.lossSe || 0));
	const mistake = !noisy && o.loss >= 0.02;
	const mon = i => `<b>${esc(names[i])}</b>`;
	const foe = j => `<b>${esc(theirs[j])}</b>`;
	const list = xs => xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
	const points = [];

	// How often each side brings / leads each Pokémon at equilibrium.
	const myBring = new Array(n).fill(0), myLead = new Array(n).fill(0);
	for (const x of res.options) if (x.mix > 0) { x.option.forEach(i => { myBring[i] += x.mix; }); myLead[x.option[0]] += x.mix; }
	const tm = res.theirMix || [];
	const pTot = tm.reduce((t, x) => t + x.p, 0) || 1;
	const theirBring = new Array(theirs.length).fill(0), theirLead = new Array(theirs.length).fill(0);
	for (const t of tm) { t.option.forEach(j => { theirBring[j] += t.p / pTot; }); theirLead[t.option[0]] += t.p / pTot; }

	// --- 1. what differs from the best pick, and the smallest change that fixes most of it
	if (o !== best && mistake) {
		const out = best.option.filter(i => !o.option.includes(i)), extra = o.option.filter(i => !best.option.includes(i));
		const parts = [];
		if (out.length) parts.push(`brings ${list(out.map(mon))} instead of ${list(extra.map(mon))}`);
		if (best.option[0] !== o.option[0]) parts.push(`leads ${mon(best.option[0])}${out.includes(best.option[0]) ? '' : ` rather than ${mon(o.option[0])}`}`);
		else parts.push(`also leads ${mon(o.option[0])}`);
		points.push({tone: 'info', html: `The best pick ${parts.join(' and ')}.`});

		const mine = new Set(o.option);
		let fix = null;
		for (const q of res.options) {
			if (q === o) continue;
			const shared = q.option.filter(i => mine.has(i)).length;
			const sameTrio = trio(q.option) === trio(o.option);
			const leadKept = q.option[0] === o.option[0];
			// one step: re-order the lead within the same three, or swap one Pokémon (the newcomer leads if the lead left)
			const swapOne = shared === 2 && (leadKept || (!mine.has(q.option[0]) && !q.option.includes(o.option[0])));
			if (!(sameTrio && !leadKept) && !swapOne) continue;
			const gain = q.value - o.value;
			if (!fix || gain > fix.gain) fix = {q, gain, sameTrio};
		}
		if (fix && fix.gain >= Math.max(0.02, 0.5 * o.loss)) {
			const q = fix.q;
			const what = fix.sameTrio
				? `same three, but lead ${mon(q.option[0])}`
				: (() => {
					const inn = q.option.find(i => !mine.has(i)), outt = o.option.find(i => !q.option.includes(i));
					return `bring ${mon(inn)} instead of ${mon(outt)}${q.option[0] === inn ? ' (and lead it)' : ''}`;
				})();
			const share = Math.min(1, fix.gain / o.loss);
			points.push({tone: 'good', html: `Smallest fix: ${what}. That alone wins back ${pts(fix.gain)} of the ${pts(o.loss)} points${
				q === best ? ' and is the best pick' : share > 0.97 ? ', all of it' : share > 0.8 ? ', almost all of it' : ''}.`});
		}
	}

	// --- 2. which of their replies the points are lost against
	if (o !== best && mistake && tm.length && o.vsTheirs && best.vsTheirs) {
		const gaps = tm.map((t, k) => ({t, k, gap: best.vsTheirs[k] - o.vsTheirs[k], w: t.p / pTot}));
		const worst = gaps.slice().sort((a, b) => b.w * b.gap - a.w * a.gap)[0];
		if (worst && worst.gap > 0.03) {
			const t = worst.t;
			points.push({tone: 'bad', html: `The points go against their ${foe(t.option[0])} lead with ${foe(t.option[1])} + ${foe(t.option[2])}
				(${pc(worst.w)} of their best replies): you win ${pc(o.vsTheirs[worst.k])} there, the best pick ${pc(best.vsTheirs[worst.k])}.`});
		}
		const better = gaps.filter(g => g.gap < -0.05).sort((a, b) => a.gap - b.gap)[0];
		if (better) {
			const t = better.t;
			points.push({tone: 'info', html: `Your pick is better if they lead ${foe(t.option[0])} with ${foe(t.option[1])} + ${foe(t.option[2])}
				(${pc(o.vsTheirs[better.k])} vs ${pc(best.vsTheirs[better.k])}), but against their whole mix it gives more than it gains.`});
		}
	}

	// --- 3. equilibrium bring rates: core Pokémon left home, dead weight brought
	if (mistake) {
		const home = [...Array(n).keys()].filter(i => !o.option.includes(i) && myBring[i] >= 0.7);
		const dead = o.option.filter(i => myBring[i] <= 0.05);
		if (home.length) points.push({tone: 'bad', html: `Played well, this matchup brings ${list(home.map(i => `${mon(i)} (${pc(myBring[i])} of games)`))}; you left ${home.length > 1 ? 'them' : 'it'} home.`});
		if (dead.length) points.push({tone: 'bad', html: `${list(dead.map(mon))} ${dead.length > 1 ? 'are' : 'is'} in none of the best picks here.`});
	}

	// --- 4. 1v1 matchups: their likely Pokémon and the answers each pick has
	const answer = (opt, j) => {
		let b = null;
		for (const i of opt) { const v = vs(i, j); if (v != null && (!b || v > b.v)) b = {i, v}; }
		return b;
	};
	const likely = [...theirs.keys()].filter(j => theirBring[j] >= 0.3).sort((a, b) => theirBring[b] - theirBring[a]);
	if (likely.some(j => answer(o.option, j))) {
		const threats = [];
		for (const j of likely) {
			const a = answer(o.option, j), b = answer(best.option, j);
			if (!a) continue;
			if (a.v < -0.03 && (o === best || !mistake || (b && b.v > a.v + 0.1))) threats.push({j, a, b, w: theirBring[j] * ((b ? b.v : 0) - a.v)});
		}
		threats.sort((x, y) => y.w - x.w);
		for (const {j, a, b} of threats.slice(0, 2)) {
			const alt = mistake && b && b.v > 0.03 && b.i !== a.i ? ` The best pick has ${mon(b.i)} (${hp(b.v)}).` : '';
			points.push({tone: mistake ? 'bad' : 'info', html: `Their ${foe(j)} (in ${pc(theirBring[j])} of their best picks): nothing you brought beats it 1v1;
				your best shot is ${mon(a.i)} (${hp(a.v)}).${alt}`});
		}
		// lead vs their likely leads
		const leads = [...theirs.keys()].filter(j => theirLead[j] >= 0.15).sort((a, b) => theirLead[b] - theirLead[a]);
		const leadV = i => {
			let t = 0, w = 0;
			for (const j of leads) { const v = vs(i, j); if (v != null) { t += theirLead[j] * v; w += theirLead[j]; } }
			return w ? t / w : null;
		};
		const mv = leadV(o.option[0]), bv = leadV(best.option[0]);
		const leadsTxt = leads.map(j => `${foe(j)} ${pc(theirLead[j])}`).join(', ');
		if (mistake && mv != null && bv != null && best.option[0] !== o.option[0] && bv > mv + 0.08) {
			points.push({tone: 'bad', html: `Lead: against their likely leads (${leadsTxt}) your ${mon(o.option[0])} averages ${hp(mv)} in 1v1s;
				${mon(best.option[0])} averages ${hp(bv)}.`});
		}
		if (!mistake) {
			const covered = likely.map(j => ({j, a: answer(o.option, j)})).filter(x => x.a && x.a.v > 0.03);
			if (covered.length) points.push({tone: 'good', html: `Answers to what they're likely to bring: ${covered.map(x => `${foe(x.j)} ← ${mon(x.a.i)} (${hp(x.a.v)})`).join(', ')}.`});
			if (mv != null && leads.length) points.push({tone: mv >= 0 ? 'good' : 'info', html: `Your lead ${mon(o.option[0])} against their likely leads (${leadsTxt}): ${hp(mv)} on average in 1v1s.`});
		}
	}

	if (!mistake) {
		const sup = res.options.filter(x => x.mix > 0.01);
		if (o.mix > 0.01 && sup.length > 1) points.unshift({tone: 'good', html: `This is one of the ${sup.length} picks a strong player mixes between here (${pc(o.mix)} of the time); mixing keeps you unpredictable.`});
		else if (o === best) points.unshift({tone: 'good', html: 'This is the best pick against their best replies.'});
		else if (o.loss < 0.02) points.unshift({tone: 'good', html: `Within ${pts(o.loss)} points of the best pick: as good as it gets here.`});
		else points.unshift({tone: 'info', html: `${pts(o.loss)} points behind the best pick, but that is inside the simulation’s noise
			(± ${pts(1.96 * o.lossSe)}), so it can't be called a mistake. ${o.lossSe > 0.03 ? 'A Strong analysis would settle it.' : ''}`});
	}

	return {
		mistake, noisy, points,
		footnote: 'The verdict comes from full 3v3 battles. The 1v1 numbers are a rough guide from separate simulated 1v1s with their most common set: the average HP % the winner keeps (+ you win, − you lose).',
	};
}

/**
 * 1v1 lookup from results.json's matchup matrix (sim/battle.js loadOneVsOne decodes the same bytes).
 * @returns (myEntryId, theirSpecies) -> value in [-0.5, 0.5] (my HP margin / 2), or null. Their species is averaged
 *          over the roster entries of that species (Mega and not), weighted as sim/belief.js weights them.
 */
export function oneVsOneTable(results) {
	const m = results.matchups;
	if (!m || !m.data) return () => null;
	const K = results.meta.matchupBattlesPerPair || 8;
	const N = m.ids.length;
	const bin = typeof atob === 'function'
		? Uint8Array.from(atob(m.data), c => c.charCodeAt(0))
		: Uint8Array.from(Buffer.from(m.data, 'base64'));
	const idx = new Map(m.ids.map((id, i) => [id, i]));
	const key = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
	const forms = new Map();
	for (const e of results.entries) {
		if (!idx.has(e.id)) continue;
		const list = forms.get(key(e.species)) || [];
		list.push({i: idx.get(e.id), w: Math.exp((e.rating - 1500) / 120)});
		forms.set(key(e.species), list);
	}
	const v = (a, b) => (bin[a * N + b] / 255 * K + 1) / (K + 2) - 0.5;
	return (myId, theirSpecies) => {
		const a = idx.get(myId), fs = forms.get(key(theirSpecies));
		if (a === undefined || !fs) return null;
		const w = fs.reduce((t, f) => t + f.w, 0);
		return fs.reduce((t, f) => t + f.w * v(a, f.i), 0) / w;
	};
}
