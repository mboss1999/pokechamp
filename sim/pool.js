'use strict';
// A worker_threads pool that runs batches of battles across all CPU cores.
// It survives worker crashes: a worker that dies (out of memory, uncaught error) or stalls is replaced, and
// the batch it was running is retried one battle at a time, so a single pathological battle is reported as
// failed instead of hanging the whole run.
//
// A stall is judged by progress, not by total time: workers send a heartbeat as battles advance (every
// decision in sim/battle.js playOut), and a worker is only killed after STALL_MS with no heartbeat. Slow AIs
// (rollout4, mc8x8) can take many minutes per batch without being mistaken for a hang.
//
// Results of battles that could not be played carry `failed: true` (see isFailed). They are not draws, and
// callers must leave them out rather than score them.

const os = require('os');
const path = require('path');
const {Worker, isMainThread, parentPort} = require('worker_threads');
const {isFailed} = require('./util');

const STALL_MS = Number(process.env.STALL_MS) || 3 * 60 * 1000;
const BEAT_MS = 2000; // a worker sends at most one heartbeat per BEAT_MS
// Per-worker heap cap: at most half the machine's RAM across all workers, and never more than 1.8 GB each.
const workerHeapMb = size => Number(process.env.WORKER_HEAP_MB) ||
	Math.max(256, Math.min(1800, Math.floor(os.totalmem() / 1048576 * 0.5 / size)));

/** What a battle that could not be played reports, in the shape its job type expects, marked failed. */
function fallbackResult(job) {
	if (job.picks) return {failed: true, w: null, picks: [[], []]};
	if (job.hp) return {failed: true, w: null, hp: [0, 0]};
	return {failed: true};
}

/** Play one job (a battle, or a typed job from sim/jobs.js) in this thread. Throws if the simulator does. */
function runJob(j) {
	if (j.type) return require('./jobs').run(j);
	const r = require('./battle').runBattle(j.a, j.b, j.seed, j.agents);
	if (j.picks) return {w: r.winner, picks: r.picks};
	if (j.hp) return {w: r.winner, hp: r.hpLeft};
	return r.winner;
}

if (!isMainThread) {
	const {setProgressHook} = require('./battle');
	let currentId = null, lastBeat = 0;
	setProgressHook(() => {
		const now = Date.now();
		if (currentId === null || now - lastBeat < BEAT_MS) return;
		lastBeat = now;
		parentPort.postMessage({beat: currentId});
	});
	parentPort.on('message', ({id, jobs}) => {
		currentId = id;
		lastBeat = Date.now();
		const errors = [];
		const results = jobs.map(j => {
			try {
				if (process.env.POOL_TEST_HOOKS && j.testHook) { // used by the pool's crash-recovery test only
					if (j.testHook === 'die') process.exit(3);
					if (j.testHook === 'hang') for (;;);
					if (j.testHook === 'oom') for (const hog = [];;) hog.push(new Array(1e6).fill(1));
				}
				return runJob(j);
			} catch (e) {
				errors.push(String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
				return fallbackResult(j);
			}
		});
		currentId = null;
		// this thread's heap, for the pool's memory diagnostics (Pool.memStats)
		const h = require('v8').getHeapStatistics();
		parentPort.postMessage({id, results, errors, heap: [h.total_heap_size, h.external_memory || 0]});
	});
	return;
}

class Pool {
	constructor(size = Number(process.env.WORKERS) || os.cpus().length) {
		this.size = size;
		this.workers = new Set();
		this.spawned = 0;
		this.idle = [];
		this.queue = [];
		this.nextId = 0;
		this.closing = false;
		this.battles = 0;
		// Battles that threw inside the simulator, workers that died or stalled, and battles finally given up
		// on (results marked failed). errorSamples keeps the first few messages for the end-of-run warning.
		this.errors = 0;
		this.workerFailures = 0;
		this.failed = 0;
		this.errorSamples = [];
		for (let i = 0; i < size; i++) this.spawn();
	}

	note(message) {
		if (this.errorSamples.length < 5) this.errorSamples.push(message);
	}

	spawn() {
		const w = new Worker(path.join(__dirname, 'pool.js'), {resourceLimits: {maxOldGenerationSizeMb: workerHeapMb(this.size)}});
		w.current = null;
		w.dead = false;
		w.heap = [0, 0];
		this.spawned++;
		w.on('message', msg => {
			const c = w.current;
			if (msg.beat !== undefined) {
				if (c && c.id === msg.beat) this.arm(w, c);
				return;
			}
			if (!c || c.id !== msg.id) return;
			clearTimeout(c.timer);
			w.current = null;
			if (msg.heap) w.heap = msg.heap;
			this.battles += msg.results.length;
			if (msg.errors.length) {
				this.errors += msg.errors.length;
				this.failed += msg.errors.length;
				for (const e of msg.errors) this.note(e);
			}
			c.resolve(msg.results);
			this.idle.push(w);
			this.pump();
		});
		const died = reason => {
			if (w.dead) return;
			w.dead = true;
			this.workers.delete(w);
			this.idle = this.idle.filter(x => x !== w);
			const c = w.current;
			w.current = null;
			if (c) {
				clearTimeout(c.timer);
				this.recover(c, reason);
			}
			if (!this.closing) this.spawn();
			this.pump();
		};
		w.on('error', e => died(String(e && e.code || e && e.message || e)));
		w.on('exit', code => died(`worker exited (${code})`));
		this.workers.add(w);
		this.idle.push(w);
		return w;
	}

	/** A worker died or stalled while running chunk c: retry its battles one by one, then give up on any that fail. */
	recover(c, reason) {
		this.workerFailures++;
		this.note(`worker failure (${reason}) while running ${c.jobs.length} battle(s)`);
		if (c.jobs.length > 1) {
			Promise.all(c.jobs.map(j => this.dispatch([j]))).then(parts => c.resolve(parts.flat()));
		} else {
			this.battles += 1;
			this.failed += 1;
			c.resolve([fallbackResult(c.jobs[0])]);
		}
	}

	/** (Re)start chunk c's stall timer on worker w. */
	arm(w, c) {
		clearTimeout(c.timer);
		c.timer = setTimeout(() => {
			this.note(`worker stalled: no progress for ${STALL_MS / 1000}s`);
			w.terminate(); // 'exit' then runs the recovery path
		}, STALL_MS);
	}

	dispatch(jobs, priority = 0, token = null) {
		return new Promise(resolve => {
			this.queue.push({id: this.nextId++, jobs, resolve, timer: null, priority, token});
			this.pump();
		});
	}

	pump() {
		while (this.idle.length && this.queue.length) {
			const w = this.idle.pop();
			// highest priority first, then first come first served
			let k = 0;
			for (let i = 1; i < this.queue.length; i++) if (this.queue[i].priority > this.queue[k].priority) k = i;
			const c = this.queue.splice(k, 1)[0];
			if (c.token && c.token.cancelled) { // nobody wants these any more: skip them, unplayed
				this.idle.push(w);
				c.resolve(c.jobs.map(j => ({...fallbackResult(j), cancelled: true})));
				continue;
			}
			w.current = c;
			this.arm(w, c);
			w.postMessage({id: c.id, jobs: c.jobs});
		}
	}

	/**
	 * Run battle jobs [{a, b, seed, ...}] and resolve with one result per job, in order.
	 * onChunk(first, results) is called as each chunk finishes (for progress reporting). Chunks of a run with
	 * a higher priority go ahead of anything already queued (someone is waiting on them). Setting
	 * token.cancelled = true skips chunks not yet started; their results come back failed and `cancelled`.
	 */
	run(jobs, chunk = 16, onChunk = null, priority = 0, token = null) {
		const parts = [];
		for (let i = 0; i < jobs.length; i += chunk) {
			const p = this.dispatch(jobs.slice(i, i + chunk), priority, token);
			parts.push(onChunk ? p.then(r => { onChunk(i, r); return r; }) : p);
		}
		return Promise.all(parts).then(r => r.flat());
	}

	/** Memory diagnostics: process RSS, this thread's heap, live workers' last reported heaps, worker churn. */
	memStats() {
		const mb = x => Math.round(x / 1048576);
		let heap = 0, ext = 0;
		for (const w of this.workers) { heap += w.heap[0]; ext += w.heap[1]; }
		const m = process.memoryUsage();
		return `rss=${mb(m.rss)}MB main=${mb(m.heapTotal)}MB mainExt=${mb(m.external + m.arrayBuffers)}MB ` +
			`workersHeap=${mb(heap)}MB workersExt=${mb(ext)}MB workers=${this.workers.size} spawned=${this.spawned} ` +
			`failures=${this.workerFailures} queued=${this.queue.length}`;
	}

	close() {
		this.closing = true;
		for (const w of this.workers) w.terminate();
	}
}

module.exports = {Pool, isFailed, runJob, fallbackResult};
