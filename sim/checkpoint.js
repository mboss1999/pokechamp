'use strict';
// Resumable runs: a pool wrapper that remembers battle results on disk, so a script killed part-way (a Spot reclaim,
// a crash) can be started again with the same arguments and replay to where it stopped without replaying battles.
//
// Every search and benchmark here is deterministic given its battle results (all its randomness is seeded), so the
// second run makes the same calls with the same jobs; those are answered from the file. Jobs are keyed by content
// (teams, seed, pilots), not by call order, so concurrent calls are fine. Each run() is split into blocks of
// BLOCK jobs, each cached separately, so a long single call (sim/team-bench.js) also resumes part-way.
//
//   pool = require('./checkpoint').wrap(pool, arg('checkpoint'))     // no-op without a path
//
// The file is JSON lines ({k, r}), appended as blocks finish. Blocks with cancelled results (sim/refine.js drops
// speculative work) or where every battle failed (throttling) are not stored, so they are played again.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BLOCK = Number(process.env.CHECKPOINT_BLOCK || 2000);

function wrap(pool, file) {
	if (!file) return pool;
	file = path.resolve(file);
	const cache = new Map();
	if (fs.existsSync(file)) {
		for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
			if (!line) continue;
			try { const {k, r} = JSON.parse(line); cache.set(k, r); } catch { /* a torn last line */ }
		}
	}
	fs.mkdirSync(path.dirname(file), {recursive: true});
	const fd = fs.openSync(file, 'a');
	const teamIds = new WeakMap();
	const teamId = t => {
		if (!t || typeof t !== 'object') return String(JSON.stringify(t)); // draft jobs have no a/b teams
		let id = teamIds.get(t);
		if (!id) { id = crypto.createHash('sha1').update(JSON.stringify(t)).digest('base64'); teamIds.set(t, id); }
		return id;
	};
	const keyOf = jobs => {
		const h = crypto.createHash('sha1');
		for (const j of jobs) {
			const {a, b, ...rest} = j;
			h.update(teamId(a)); h.update('|'); h.update(teamId(b)); h.update('|'); h.update(JSON.stringify(rest)); h.update('\n');
		}
		return h.digest('base64');
	};
	const stats = {hits: 0, misses: 0, replayed: 0};
	const keep = r => !r.some(x => x && typeof x === 'object' && x.cancelled) &&
		!r.every(x => x && typeof x === 'object' && (x.failed || x.error));
	const run = (jobs, chunk, onChunk = null, ...rest) => Promise.all(Array.from({length: Math.ceil(jobs.length / BLOCK)}, async (_, bi) => {
		const block = jobs.slice(bi * BLOCK, (bi + 1) * BLOCK);
		const k = keyOf(block);
		if (cache.has(k)) {
			stats.hits++; stats.replayed += block.length;
			const r = cache.get(k);
			if (onChunk) onChunk(bi * BLOCK, r);
			return r;
		}
		stats.misses++;
		const r = await pool.run(block, chunk, onChunk ? (i, x) => onChunk(bi * BLOCK + i, x) : null, ...rest);
		if (keep(r)) {
			cache.set(k, r);
			fs.writeSync(fd, JSON.stringify({k, r}) + '\n');
		}
		return r;
	})).then(parts => parts.flat());
	if (cache.size) console.log(`checkpoint: ${cache.size} blocks of results from ${file}`);
	return new Proxy(pool, {
		get(target, prop) {
			if (prop === 'run') return run;
			if (prop === 'checkpoint') return stats;
			if (prop === 'close') return () => { fs.closeSync(fd); return target.close(); };
			const v = target[prop];
			return typeof v === 'function' ? v.bind(target) : v;
		},
		set(target, prop, value) { target[prop] = value; return true; },
	});
}

module.exports = {wrap};
