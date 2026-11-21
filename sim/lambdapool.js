'use strict';
// A drop-in for sim/pool.js's Pool that plays battles on AWS Lambda (the function from aws/lambda-deploy.sh)
// instead of this machine's cores: hundreds of chunks at once, so a stage of thousands of battles takes about
// as long as one chunk. Same run(jobs, chunk, onChunk, priority, token) contract, same result shapes.
//
// The client side is kept lean because a tuning makes tens of thousands of invocations: requests are signed
// here (AWS Signature V4) and sent over keep-alive HTTPS, with credentials from the AWS SDK's usual provider
// chain (profiles, SSO, env), fetched once and refreshed before they expire.
//
// Env: LAMBDA_FUNCTION (default champions-sim-battles), LAMBDA_CONCURRENCY (chunks in flight; default 80% of
// the account's Lambda concurrency), LAMBDA_CHUNK / LAMBDA_MIN_CHUNK (battles per invocation: a run with
// fewer battles than slots uses smaller chunks, down to the minimum; both default to 24). LAMBDA_SLOW_CHUNK
// (default 4) caps chunks of rollout-pilot battles.

const crypto = require('crypto');
const https = require('https');
const {fallbackResult} = require('./pool');

const FUNCTION = process.env.LAMBDA_FUNCTION || 'champions-sim-battles';
const MAX_CHUNK = Number(process.env.LAMBDA_CHUNK) || 24;
// Smaller chunks finish a stage sooner but cost the client CPU per request; on a busy laptop that cost wins.
const MIN_CHUNK = Math.min(Number(process.env.LAMBDA_MIN_CHUNK) || 24, MAX_CHUNK);
// battles per invocation when a rollout pilot plays (~0.5-1 s per battle, long games several seconds)
const SLOW_CHUNK = Number(process.env.LAMBDA_SLOW_CHUNK) || 4;

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** Highest priority first, first in first out within a priority. */
class PriorityQueue {
	constructor() {
		this.buckets = new Map(); // priority -> {items, head}
		this.keys = []; // priorities, descending
		this.length = 0;
	}
	push(priority, item) {
		let b = this.buckets.get(priority);
		if (!b) {
			b = {items: [], head: 0};
			this.buckets.set(priority, b);
			let i = 0;
			while (i < this.keys.length && this.keys[i] > priority) i++;
			this.keys.splice(i, 0, priority);
		}
		b.items.push(item);
		this.length++;
	}
	shift() {
		if (!this.length) return undefined;
		const p = this.keys[0], b = this.buckets.get(p);
		const item = b.items[b.head];
		b.items[b.head++] = undefined;
		this.length--;
		if (b.head === b.items.length) {
			this.buckets.delete(p);
			this.keys.shift();
		}
		return item;
	}
}

class LambdaPool {
	constructor({region, concurrency} = {}) {
		this.remote = true; // battles run elsewhere: callers size jobs for one invocation (sim/draft.js)
		this.region = region || process.env.AWS_REGION || 'us-east-1';
		this.size = Number(process.env.LAMBDA_CONCURRENCY) || concurrency || 100;
		this.host = `lambda.${this.region}.amazonaws.com`;
		this.path = `/2015-03-31/functions/${encodeURIComponent(FUNCTION)}/invocations`;
		this.agent = new https.Agent({keepAlive: true, maxSockets: this.size + 16});
		this.creds = null;
		this.keyCache = {date: null, key: null, access: null};
		this.queue = new PriorityQueue();
		// sim/refine.js evaluates members speculatively in parallel on pools with spare width: worth the extra
		// battles here, where width is plentiful and each stage costs a round trip
		this.speculate = 6;
		this.inFlight = 0;
		this.battles = 0;
		this.invocations = 0;
		this.failed = 0;
		this.errorSamples = [];
	}

	/** The account's Lambda concurrency, for sizing the pool. Null if it can't be read. */
	static async accountConcurrency(region) {
		try {
			const {LambdaClient, GetAccountSettingsCommand} = require('@aws-sdk/client-lambda');
			const r = await new LambdaClient({region}).send(new GetAccountSettingsCommand({}));
			return r.AccountLimit.ConcurrentExecutions;
		} catch {
			return null;
		}
	}

	async credentials() {
		const c = this.creds;
		if (c && (!c.expiration || c.expiration.getTime() - Date.now() > 5 * 60 * 1000)) return c;
		if (!this.credsPromise) {
			const {LambdaClient} = require('@aws-sdk/client-lambda');
			this.credsPromise = new LambdaClient({region: this.region}).config.credentials()
				.then(x => { this.creds = x; return x; })
				.finally(() => { this.credsPromise = null; });
		}
		return this.credsPromise;
	}

	/** Signature V4 headers for a POST of `body` to the invoke path. */
	sign(body, creds) {
		const now = new Date();
		const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
		const date = amzDate.slice(0, 8);
		const headers = {host: this.host, 'x-amz-date': amzDate};
		if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
		const names = Object.keys(headers).sort();
		const canonical = ['POST', this.path, '', ...names.map(n => `${n}:${headers[n]}`), '', names.join(';'), sha256(body)].join('\n');
		const scope = `${date}/${this.region}/lambda/aws4_request`;
		const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
		const kc = this.keyCache;
		if (kc.date !== date || kc.access !== creds.accessKeyId) {
			const kDate = hmac('AWS4' + creds.secretAccessKey, date);
			kc.key = hmac(hmac(hmac(kDate, this.region), 'lambda'), 'aws4_request');
			kc.date = date;
			kc.access = creds.accessKeyId;
		}
		const signature = crypto.createHmac('sha256', kc.key).update(toSign).digest('hex');
		return {
			...headers,
			'content-type': 'application/json',
			'content-length': Buffer.byteLength(body),
			authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
		};
	}

	/** Play one empty chunk, to check the function answers (and warm it up). */
	async check() {
		const r = await this.invokeRetrying([]);
		if (!r || !Array.isArray(r.results)) throw new Error(`Lambda ${FUNCTION} gave no results`);
	}

	/** The request body for a chunk: each distinct team once, battles referring to it by index. */
	static payload(jobs) {
		const index = new Map(), teams = [];
		const ref = t => {
			if (!Array.isArray(t)) return t;
			if (!index.has(t)) { index.set(t, teams.length); teams.push(t); }
			return index.get(t);
		};
		const slim = jobs.map(j => (Array.isArray(j.a) && Array.isArray(j.b) ? {...j, a: ref(j.a), b: ref(j.b)} : j));
		return JSON.stringify({teams, jobs: slim});
	}

	async invoke(jobs) {
		const body = LambdaPool.payload(jobs);
		const headers = this.sign(body, await this.credentials());
		this.invocations++;
		return new Promise((resolve, reject) => {
			const req = https.request({host: this.host, path: this.path, method: 'POST', headers, agent: this.agent, timeout: 150000}, res => {
				const chunks = [];
				res.on('data', c => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					let parsed = null;
					try { parsed = JSON.parse(text); } catch {}
					if (res.statusCode !== 200) {
						const type = res.headers['x-amzn-errortype'] || '';
						return reject(Object.assign(new Error(`Lambda HTTP ${res.statusCode} ${type} ${(parsed && (parsed.message || parsed.Message)) || text.slice(0, 200)}`),
							{status: res.statusCode, name: type.split(':')[0] || 'LambdaError'}));
					}
					if (res.headers['x-amz-function-error']) {
						return reject(new Error(`Lambda ${res.headers['x-amz-function-error']}: ${parsed && parsed.errorMessage}`));
					}
					resolve(parsed);
				});
				res.on('error', reject);
			});
			req.on('timeout', () => req.destroy(new Error('ETIMEDOUT')));
			req.on('error', reject);
			req.end(body);
		});
	}

	note(message) {
		if (this.errorSamples.length < 5) this.errorSamples.push(message);
	}

	/** Invoke with retries: throttling and transient errors back off and try again, other failures twice. */
	async invokeRetrying(jobs) {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.invoke(jobs);
			} catch (e) {
				const transient = e.status === 429 || e.status >= 500 ||
					/TooManyRequests|Throttl|Rate exceeded|ECONNRESET|socket hang up|EPIPE|ETIMEDOUT|ExpiredToken/i.test(`${e.name} ${e.message}`);
				if (/ExpiredToken/i.test(e.message)) this.creds = null;
				if (attempt >= (transient ? 12 : 2)) throw e;
				await new Promise(r => setTimeout(r, Math.min(4000, 100 * 2 ** attempt) * (0.5 + Math.random())));
			}
		}
	}

	pump() {
		while (this.inFlight < this.size && this.queue.length) {
			const c = this.queue.shift();
			if (c.token && c.token.cancelled) {
				c.resolve(c.jobs.map(j => ({...fallbackResult(j), cancelled: true})));
				continue;
			}
			this.inFlight++;
			this.invokeRetrying(c.jobs).then(body => {
				this.battles += c.jobs.length;
				if (body.errors && body.errors.length) {
					this.failed += body.errors.length;
					body.errors.forEach(e => this.note(e));
				}
				c.resolve(body.results);
			}, e => {
				this.battles += c.jobs.length;
				this.failed += c.jobs.length;
				this.note(`lambda chunk failed: ${e.message}`);
				c.resolve(c.jobs.map(fallbackResult));
			}).finally(() => {
				this.inFlight--;
				this.pump();
			});
		}
	}

	/**
	 * Like Pool.run. The caller's chunk size is for local workers; here a run is split so it spreads over the
	 * free slots (smaller chunks finish sooner) without going below MIN_CHUNK battles per invocation.
	 */
	run(jobs, _chunk, onChunk = null, priority = 0, token = null) {
		// rollout pilots take ~60x longer per battle: keep their invocations well inside the time limit
		const slow = jobs.some(j => j.agents && j.agents.some(a => String(a).startsWith('rollout')));
		const max = slow ? SLOW_CHUNK : MAX_CHUNK, min = slow ? Math.min(MIN_CHUNK, SLOW_CHUNK) : MIN_CHUNK;
		// a team preview job (sim/draft.js) is already a batch of battles sized for Lambda (jobBattles): one per invocation
		const chunk = jobs.some(j => j.type === 'draft') ? 1 : Math.max(min, Math.min(max, Math.ceil(jobs.length / this.size)));
		const parts = [];
		for (let i = 0; i < jobs.length; i += chunk) {
			const p = new Promise(resolve => {
				this.queue.push(priority, {jobs: jobs.slice(i, i + chunk), resolve, token});
			});
			parts.push(onChunk ? p.then(r => { onChunk(i, r); return r; }) : p);
		}
		this.pump();
		return Promise.all(parts).then(r => r.flat());
	}

	close() {
		this.agent.destroy();
	}
}

module.exports = {LambdaPool, FUNCTION};
