'use strict';
// Team tuning as a background service, so nobody waits for "Tune & validate".
//
// - Every finished tuning is kept in a cache file keyed by the team (members and sets), the simulation results
//   it was tuned against and the budget. Asking again is instant, across restarts.
// - The app tells the service which Pokémon the player owns; the service builds the same teams the Team
//   Builder shows (with and without Megas) and tunes them straight away, before anyone asks.
// - Where the battles run, best first:
//   1. AWS Lambda (aws/lambda-deploy.sh): the tuning runs here but every stage's battles fan out over hundreds
//      of Lambda invocations at once, so a team takes under a minute. Lambda costs ~8x more per battle than
//      EC2, so it takes only teams someone is looking at or is about to (the current Mega setting); the
//      other setting's teams go to EC2. Capped per day by battles (spend).
//   2. One 64-core EC2 Spot machine (aws/launch.sh running sim/tune-batch.js) for a whole batch of teams;
//      minutes including boot, results streaming back through S3. Used when Lambda isn't set up or is capped.
//   3. This computer's cores, one team at a time: when there is no cloud, or a cloud run fails.
// - Tunings use the rigorous budget (sim/refine.js BUDGETS).
//
// Env: TUNE_CLOUD=0 keeps everything on this computer. TUNE_LAMBDA=0 skips Lambda. TUNE_LAMBDA_DAILY_BATTLES
// (default 10,000,000 fast-pilot battles, about $10 of Lambda at ~$1 per million; a rollout battle counts 25). TUNE_INSTANCE_TYPE (default c7g.16xlarge),
// TUNE_CLOUD_DAILY (EC2 launches per day, default 40), TUNE_CLOUD_DEBOUNCE_MS (wait for the collection to settle
// before launching EC2, default 8000). TUNE_BUDGET (development only; part of the cache key).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {execFile, spawn} = require('child_process');
const {pathToFileURL} = require('url');

const ROOT = path.join(__dirname, '..');
const ALGORITHM = 4; // 4: heuristic2 search, rollout4all status checks and validation. Bump when sim/refine.js changes what a tuning produces, to retire cached results
const BUDGET = process.env.TUNE_BUDGET || 'rigorous';
const LAMBDA_DAILY_BATTLES = Number(process.env.TUNE_LAMBDA_DAILY_BATTLES) || 10e6;
const LAMBDA_TEAMS_AT_ONCE = 10;
const LAMBDA_MIN_PRIORITY = 1; // request priorities: 2 = on screen, 1 = current Mega setting, 0 = the other one
const forLambda = j => j.priority >= LAMBDA_MIN_PRIORITY;
const CLOUD_TIMEOUT_MS = 90 * 60 * 1000; // give up on a cloud run (and tune locally) after this long (rollout validation: ~3 machine-min per team)

function canonical(x) {
	if (Array.isArray(x)) return `[${x.map(canonical).join(',')}]`;
	if (x && typeof x === 'object') return `{${Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',')}}`;
	return JSON.stringify(x === undefined ? null : x);
}

function sh(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => execFile(cmd, args, {maxBuffer: 64 << 20, ...opts}, (err, stdout, stderr) =>
		err ? reject(Object.assign(err, {stderr})) : resolve(stdout)));
}

class Tuner {
	/**
	 * @param resultsPath  web/data/results.json
	 * @param cachePath    where finished tunings are kept
	 * @param getPool      () => sim/pool Pool, for tuning on this machine
	 */
	constructor({resultsPath, cachePath, getPool}) {
		this.resultsPath = resultsPath;
		this.cachePath = cachePath;
		this.getPool = getPool;
		this.results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
		this.byId = new Map(this.results.entries.map(e => [e.id, e]));
		this.jobs = new Map(); // key -> job
		this.cache = this.loadCache();
		this.localBusy = false;
		this.lambda = null; // sim/lambdapool LambdaPool once it has answered
		this.lambdaActive = 0;
		this.cloud = {enabled: false, ready: null, runs: new Map(), timer: null, launching: false};
		this.teamModule = null;
		this.collectionKeys = [];
		if (process.env.TUNE_CLOUD !== '0') this.cloud.ready = this.initCloud();
	}

	// ---------- cache ----------

	loadCache() {
		try {
			const c = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
			return {results: c.results || {}, launches: c.launches || {}, lambdaBattles: c.lambdaBattles || {}};
		} catch {
			return {results: {}, launches: {}, lambdaBattles: {}};
		}
	}

	saveCache() {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			fs.mkdirSync(path.dirname(this.cachePath), {recursive: true});
			fs.writeFileSync(this.cachePath + '.tmp', JSON.stringify(this.cache));
			fs.renameSync(this.cachePath + '.tmp', this.cachePath);
		}, 200);
	}

	// ---------- requests ----------

	/** Members with every set filled in (a missing set means the entry's own), validated. */
	normalize(members) {
		if (!Array.isArray(members) || members.length < 3 || members.length > 6) throw new Error('A team needs 3 to 6 Pokémon');
		return members.map(m => {
			const e = this.byId.get(m && m.entryId);
			if (!e) throw new Error(`Unknown Pokémon ${m && m.entryId}`);
			return {entryId: e.id, set: m.set || e.set};
		});
	}

	keyOf(members) {
		const payload = canonical({v: ALGORITHM, data: this.results.meta.generatedAt, budget: BUDGET, members});
		return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
	}

	/**
	 * Queue teams for tuning (no-op for ones done or under way). Returns their keys, in order.
	 * requested: someone is looking at these teams (not just precomputing), so they are never dropped.
	 */
	request(teams, priority = 0, requested = false) {
		const keys = [];
		let added = 0;
		teams.forEach((raw, i) => {
			const members = this.normalize(raw);
			const key = this.keyOf(members);
			keys.push(key);
			const p = priority - i / 100; // earlier teams first within a request
			let job = this.jobs.get(key);
			if (!job) {
				const hit = this.cache.results[key];
				job = hit
					? {key, members, status: 'done', progress: 1, result: hit.result, seconds: hit.seconds, where: hit.where, cached: true}
					: {key, members, status: 'queued', progress: 0, message: 'Queued', priority: p, queuedAt: Date.now()};
				this.jobs.set(key, job);
				if (!hit) added++;
			} else if (job.status === 'error') {
				Object.assign(job, {status: 'queued', progress: 0, message: 'Queued', error: undefined, cloudFailed: false});
				added++;
			}
			if (requested) job.requested = true;
			if (job.status !== 'done') job.priority = Math.max(job.priority ?? -Infinity, p);
		});
		// only new work restarts the cloud's wait-for-the-collection-to-settle timer
		if (added) this.kick(); else this.runLocal();
		return keys;
	}

	/** What the client sees for each key. */
	status(keys) {
		return keys.map(key => {
			const j = this.jobs.get(key);
			if (!j) return {key, status: 'unknown'};
			const {members, priority, queuedAt, cloudRun, cloudFailed, requested, token, ...pub} = j;
			return pub;
		});
	}

	/**
	 * The player's collection changed: tune the teams the Team Builder will show for it, with and without
	 * Megas (the current setting first), before they are asked for.
	 */
	async setCollection(owned, includeMegas = true) {
		if (!this.teamModule) {
			this.teamModule = await import(pathToFileURL(path.join(ROOT, 'web', 'team.js')).href);
			this.scorer = this.teamModule.makeScorer(this.results);
		}
		const {buildTeams, assignSets} = this.teamModule;
		const ownedSet = new Set(owned);
		const keys = [];
		for (const megas of [includeMegas, !includeMegas]) {
			const teams = buildTeams(this.results, ownedSet, {scorer: this.scorer, teams: 5, includeMegas: megas})
				.filter(t => t.members.length >= 3)
				.map(t => assignSets(this.results, t.members).map(m => ({entryId: m.entry.id, set: m.set})));
			keys.push(...this.request(teams, megas === includeMegas ? 1 : 0));
		}
		// teams of an older collection that haven't started yet are no longer wanted
		const wanted = new Set(keys);
		for (const k of this.collectionKeys) {
			const j = this.jobs.get(k);
			// (a Lambda tuning in progress notices and stops; an EC2 batch can't be recalled, so let it finish)
			if (j && j.status !== 'done' && !wanted.has(k) && !j.requested && !j.cloudRun) {
				this.jobs.delete(k);
				if (j.token) j.token.cancelled = true;
			}
		}
		this.collectionKeys = keys;
		return keys;
	}

	complete(key, result, where, seconds) {
		const job = this.jobs.get(key);
		this.cache.results[key] = {result, seconds, where, at: new Date().toISOString()};
		this.saveCache();
		if (job) Object.assign(job, {status: 'done', progress: 1, message: 'Done', result, seconds, where, error: undefined});
	}

	pending() {
		return [...this.jobs.values()].filter(j => j.status === 'queued' || j.status === 'running')
			.sort((a, b) => b.priority - a.priority);
	}

	kick() {
		if (this.cloud.ready) this.cloud.ready.then(() => this.scheduleCloud());
		this.runLocal();
	}

	lambdaToday() {
		return this.cache.lambdaBattles[new Date().toISOString().slice(0, 10)] || 0;
	}

	useLambda() {
		return !!this.lambda && this.lambdaToday() < LAMBDA_DAILY_BATTLES;
	}

	// ---------- this machine ----------

	/**
	 * Tune with the tuning loop on this machine: on Lambda (many teams at once) when it's available, otherwise on
	 * this computer's cores (one team at a time, and only what no cloud machine is doing).
	 */
	async runLocal() {
		if (this.cloud.ready) await this.cloud.ready;
		if (this.useLambda()) {
			while (this.lambdaActive < LAMBDA_TEAMS_AT_ONCE) {
				// includes teams an EC2 batch is still on, once someone wants them now (it finishes first, the other stops)
				const job = this.pending().find(j => (forLambda(j) || j.cloudFailed) &&
					(j.status === 'queued' || (j.status === 'running' && j.where === 'cloud')));
				if (!job) return;
				job.cloudRun = null;
				this.lambdaActive++;
				this.tuneHere(job, this.lambda, 'lambda', 'Tuning on AWS Lambda…').finally(() => {
					this.lambdaActive--;
					this.runLocal();
				});
			}
			return;
		}
		if (this.localBusy) return;
		const job = this.pending().find(j => j.status === 'queued' && (!this.cloud.enabled || j.cloudFailed));
		if (!job) return;
		this.localBusy = true;
		await this.tuneHere(job, this.getPool(), 'local', 'Tuning on this computer…');
		this.localBusy = false;
		this.runLocal();
	}

	async tuneHere(job, pool, where, message) {
		const started = Date.now();
		job.token = {cancelled: false};
		Object.assign(job, {status: 'running', where, message, progress: 0});
		try {
			const {refineTeam} = require('./refine');
			const result = await refineTeam(pool, this.results, job.members, {
				budget: BUDGET,
				priority: job.priority,
				token: job.token,
				onProgress: (p, msg) => { if (job.where === where) { job.progress = p; if (msg) job.message = msg; } },
				shouldStop: () => job.status === 'done' || this.jobs.get(job.key) !== job,
			});
			this.complete(job.key, result, where, Math.round((Date.now() - started) / 1000));
			if (where === 'lambda') {
				const day = new Date().toISOString().slice(0, 10);
				this.cache.lambdaBattles = {[day]: this.lambdaToday() + (result.cost ?? result.battles)};
				this.saveCache();
			}
		} catch (e) {
			if (!e.aborted) {
				Object.assign(job, {status: 'error', error: e.message});
				console.error('tuning failed:', e);
			}
		}
	}

	// ---------- the cloud ----------

	async initCloud() {
		try {
			const [account, region] = await Promise.all([
				sh('aws', ['sts', 'get-caller-identity', '--query', 'Account', '--output', 'text'], {timeout: 15000}),
				sh('aws', ['configure', 'get', 'region']).catch(() => 'us-east-1'),
			]);
			this.cloud.bucket = `champions-sim-${account.trim()}`;
			this.cloud.region = region.trim() || 'us-east-1';
			this.cloud.enabled = true;
		} catch (e) {
			console.log('AWS is not set up, so team tuning runs on this computer.');
			return;
		}
		if (process.env.TUNE_LAMBDA !== '0') {
			try {
				const {LambdaPool, FUNCTION} = require('./lambdapool');
				const limit = await LambdaPool.accountConcurrency(this.cloud.region);
				// leave a fifth of the account's concurrency for anything else that runs there
				const pool = new LambdaPool({region: this.cloud.region, concurrency: limit ? Math.max(4, Math.floor(limit * 0.8)) : 100});
				await pool.check();
				this.lambda = pool;
				console.log(`Team tuning runs on AWS Lambda (${FUNCTION}, ${pool.size} invocations at once).`);
				return;
			} catch (e) {
				console.log(`Lambda isn't available (${(e.message || e.name || '').split('\n')[0]}); see aws/lambda-deploy.sh.`);
			}
		}
		console.log(`Team tuning runs on an EC2 machine (s3://${this.cloud.bucket}); set TUNE_CLOUD=0 to keep it on this computer.`);
	}

	launchesToday() {
		return this.cache.launches[new Date().toISOString().slice(0, 10)] || 0;
	}

	/** Launch a cloud run for queued teams once the collection has stopped changing for a moment. */
	scheduleCloud() {
		if (!this.cloud.enabled) return;
		clearTimeout(this.cloud.timer);
		this.cloud.timer = setTimeout(() => this.launchCloud(), Number(process.env.TUNE_CLOUD_DEBOUNCE_MS) || 8000);
	}

	async launchCloud() {
		const c = this.cloud;
		if (c.launching) { this.scheduleCloud(); return; }
		const lambda = this.useLambda();
		const jobs = this.pending().filter(j => j.status === 'queued' && !j.cloudRun && !j.cloudFailed && !(lambda && forLambda(j)));
		if (!jobs.length) return;
		const cap = Number(process.env.TUNE_CLOUD_DAILY) || 40;
		if (c.runs.size >= 3 || this.launchesToday() >= cap) {
			if (this.launchesToday() >= cap) {
				console.log(`Cloud tuning: daily cap of ${cap} launches reached; tuning on this computer.`);
				for (const j of jobs) j.cloudFailed = true;
				this.runLocal();
			} else this.scheduleCloud();
			return;
		}
		c.launching = true;
		const nonce = Date.now().toString(36);
		const inFile = `out/tune-${nonce}.json`;
		fs.mkdirSync(path.join(ROOT, 'out'), {recursive: true});
		fs.writeFileSync(path.join(ROOT, inFile), JSON.stringify({budget: BUDGET, teams: jobs.map(j => ({key: j.key, members: j.members}))}));
		for (const j of jobs) Object.assign(j, {cloudRun: 'launching', where: 'cloud', message: 'Starting a cloud machine…'});
		const day = new Date().toISOString().slice(0, 10);
		this.cache.launches = {[day]: this.launchesToday() + 1}; // only today's count matters
		this.saveCache();
		let runId = null;
		try {
			const out = await sh('bash', [path.join(ROOT, 'aws', 'launch.sh')], {
				cwd: ROOT, timeout: 5 * 60 * 1000,
				env: {
					...process.env, KEEP_LAST_RUN: '1', MAX_HOURS: '2', EXTRA_FILES: inFile,
					INSTANCE_TYPE: process.env.TUNE_INSTANCE_TYPE || 'c7g.16xlarge',
					COMMAND: `node sim/tune-batch.js ${inFile} out/tuned.json`,
				},
			});
			runId = (out.match(/^Run (\S+):/m) || [])[1];
			if (!runId) throw new Error('launch.sh did not report a run id');
			console.log(`Cloud tuning run ${runId}: ${jobs.length} team(s)`);
		} catch (e) {
			console.error('Cloud launch failed, tuning on this computer instead:', (e.stderr || e.message || '').toString().trim().split('\n').slice(-3).join(' | '));
			for (const j of jobs) Object.assign(j, {cloudRun: null, cloudFailed: true, where: 'local', message: 'Queued on this computer'});
		} finally {
			fs.rmSync(path.join(ROOT, inFile), {force: true});
			c.launching = false;
		}
		if (runId) {
			for (const j of jobs) Object.assign(j, {cloudRun: runId, message: 'Starting a cloud machine…'});
			c.runs.set(runId, {id: runId, keys: jobs.map(j => j.key), started: Date.now()});
			this.pollCloud(runId);
		}
		this.runLocal();
		if (this.pending().some(j => j.status === 'queued' && !j.cloudRun && !j.cloudFailed && !(this.useLambda() && forLambda(j)))) {
			this.scheduleCloud();
		}
	}

	async pollCloud(runId) {
		const c = this.cloud, run = c.runs.get(runId);
		const base = `s3://${c.bucket}/runs/${runId}`;
		const read = key => sh('aws', ['s3', 'cp', '--quiet', `${base}/${key}`, '-', '--region', c.region], {timeout: 30000}).catch(() => null);
		const [status, out] = await Promise.all([read('status'), read('out/tuned.json')]);
		let state = null;
		try { state = out && JSON.parse(out); } catch {}
		for (const key of run.keys) {
			const job = this.jobs.get(key);
			const done = state && state.done[key];
			if (done) {
				const {seconds, ...result} = done;
				if (!job || job.status !== 'done') this.complete(key, result, 'cloud', seconds);
				continue;
			}
			if (!job || job.status === 'done' || job.cloudRun !== runId) continue;
			if (state && state.failed[key]) {
				Object.assign(job, {status: 'error', error: state.failed[key], cloudRun: null});
			} else if (state && state.progress[key]) {
				const [p, msg] = state.progress[key];
				Object.assign(job, {status: 'running', progress: p, message: `${msg || 'Tuning'} (cloud)`});
			} else if ((status || '').trim() === 'running') {
				job.message = 'Cloud machine is up, starting simulations…';
			}
		}
		const st = (status || '').trim();
		const unfinished = run.keys.filter(k => this.jobs.get(k)?.status !== 'done' && this.jobs.get(k)?.cloudRun === runId);
		const timedOut = Date.now() - run.started > CLOUD_TIMEOUT_MS;
		if (!unfinished.length || st === 'done' || st === 'failed' || timedOut) {
			c.runs.delete(runId);
			for (const k of unfinished) {
				const j = this.jobs.get(k);
				if (j && j.status !== 'done' && j.status !== 'error') {
					Object.assign(j, {status: 'queued', cloudRun: null, cloudFailed: true, where: 'local', message: 'Cloud run ended early; tuning on this computer'});
				}
			}
			if (unfinished.length) console.error(`Cloud tuning run ${runId} ended (${st || 'timed out'}) with ${unfinished.length} team(s) unfinished`);
			this.runLocal();
			return;
		}
		setTimeout(() => this.pollCloud(runId), 4000);
	}
}

module.exports = {Tuner};
