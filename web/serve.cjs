'use strict';
// Team builder server: static files plus a local API for simulations. node web/serve.cjs [port]
// Team tuning is a background service (sim/tuner.js): precomputed for the player's collection, cached on disk,
// run on a cloud machine when AWS is set up and on this computer otherwise.
//
//   POST /api/collection    {owned: [species], includeMegas} -> {keys}: precompute tunings for the teams the
//                           Team Builder will show for this collection
//   POST /api/tune          {teams: [[{entryId, set}]]} -> {keys, jobs}: the tunings of these teams (queued if new)
//   GET  /api/tune?keys=a,b -> {jobs: [{key, status: 'queued'|'running'|'done'|'error', progress, message, where,
//                           result?, seconds?, cached?, error?}]}
//   POST /api/draft         {mine: [{entryId, set}] | minePaste: showdown text, theirs: [species], budget} -> {jobId}
//   GET  /api/draft/<id>    -> {status, progress, message, result?, error?}; result is the team preview analysis (sim/draft.js)
//   POST /api/draft/<id>/grade {option} -> strong analyses value only their contested corner; this values one more
//                           option (the player's pick) against the opponent's equilibrium replies. Poll GET as before.

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const RESULTS = path.join(ROOT, 'data', 'results.json');
const TUNED = path.join(ROOT, 'data', 'tuned.json');
const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// Simulation machinery is loaded on first use so serving the page stays instant.
let pool = null, tuner = null;
const jobs = new Map();

function sendJson(res, code, body) {
	res.writeHead(code, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
	res.end(JSON.stringify(body));
}

function readBody(req, limit = 100 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', c => {
			size += c.length;
			if (size > limit) { reject(new Error('Request too large')); req.destroy(); return; }
			chunks.push(c);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', reject);
	});
}

// APP_POOL=lambda plays the server's own battles (draft analyses, and tunings when no cloud machine is available) on
// AWS Lambda instead of this computer's cores: for running the app on a small always-on host (aws/app-host.sh).
function getPool() {
	if (!pool) {
		if (process.env.APP_POOL === 'lambda') {
			const {LambdaPool} = require('../sim/lambdapool');
			pool = new LambdaPool({concurrency: Number(process.env.APP_LAMBDA_CONCURRENCY) || 400});
		} else {
			const {Pool} = require('../sim/pool');
			pool = new Pool();
		}
	}
	return pool;
}

function getTuner() {
	if (!tuner) {
		const {Tuner} = require('../sim/tuner');
		tuner = new Tuner({resultsPath: RESULTS, cachePath: TUNED, getPool});
	}
	return tuner;
}

async function readJson(req, res) {
	try {
		return JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(res, 400, {error: 'Invalid request body'});
		return null;
	}
}

async function postCollection(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const owned = Array.isArray(body.owned) ? body.owned.filter(s => typeof s === 'string').slice(0, 1000) : [];
	const keys = await getTuner().setCollection(owned, body.includeMegas !== false);
	sendJson(res, 200, {keys});
}

async function postTune(req, res) {
	const body = await readJson(req, res);
	if (!body) return;
	const t = getTuner();
	let keys;
	try {
		keys = t.request((Array.isArray(body.teams) ? body.teams : []).slice(0, 20), 2, true);
	} catch (e) {
		sendJson(res, 400, {error: e.message});
		return;
	}
	sendJson(res, 200, {keys, jobs: t.status(keys)});
}

// Team preview analysis budgets (samples per cell at each adaptive stage; see sim/draft.js). quick and normal
// pilot every battle with the fast heuristic; strong has the rollout AI play the contested corner (StrongDraft).
const DRAFT_BUDGETS = {
	quick: {screen: 2, refine: 8, grade: 24},
	normal: {screen: 4, refine: 16, grade: 48},
	strong: {hybrid: true, policy: 'rollout4all', screen: 2, refine: 8, rows: 10, cols: 8, strong: 16, grade: 48},
};
// For development: DRAFT_STRONG_OPTS='{"strong":4,"grade":8}' shrinks the strong analysis to test the app quickly.
if (process.env.DRAFT_STRONG_OPTS) Object.assign(DRAFT_BUDGETS.strong, JSON.parse(process.env.DRAFT_STRONG_OPTS));

// loaded on first use, like the rest of the simulator
const draftResult = (...a) => require('../sim/draft').draftResult(...a);

async function startDraft(req, res) {
	let body;
	try {
		body = JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(res, 400, {error: 'Invalid request body'});
		return;
	}
	let results, mine, theirs;
	try {
		results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
		mine = parseMine(results, body);
		theirs = parseTheirs(results, body.theirs);
	} catch (e) {
		sendJson(res, 400, {error: e.message});
		return;
	}
	const budget = DRAFT_BUDGETS[body.budget] ? body.budget : 'normal';
	const b = DRAFT_BUDGETS[budget];
	const {solveDraft, solveDraftStrong, strongDraftCost} = require('../sim/draft');
	// rough battle count for the progress bar: every cell screened, a 16x16 corner refined, ~8 columns graded
	const expected = b.hybrid ? strongDraftCost(b) : 3600 * b.screen + 256 * b.refine + 60 * 8 * b.grade;
	const jobId = Math.random().toString(36).slice(2, 10);
	const job = {status: 'running', progress: 0, message: 'Simulating team preview…', startedAt: Date.now()};
	jobs.set(jobId, job);
	sendJson(res, 202, {jobId});
	try {
		const r = await (b.hybrid ? solveDraftStrong : solveDraft)(getPool(), mine, theirs, {
			...b, resultsPath: RESULTS,
			onProgress: battles => { job.progress = Math.min(0.99, battles / expected); },
		});
		// failed battles are skipped, not scored, but a cell with none left reads as a draw: don't show a broken analysis
		if (r.failed > 0.05 * r.battles) throw new Error(`${Math.round(100 * r.failed / r.battles)}% of the simulated battles failed. Try again in a minute.`);
		job.result = draftResult(r, budget, mine, theirs);
		// kept server-side (not sent) so the player's own pick can be graded later
		Object.defineProperty(job, 'solver', {value: r.solver ? {sd: r.solver, budget, mine, theirs} : null, enumerable: false});
		job.status = 'done';
		job.progress = 1;
		job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
	} catch (e) {
		job.status = 'error';
		job.error = e.message;
		console.error('draft failed:', e);
	}
}

/** My six for a draft: precomputed sets ({entryId, set}) or a pasted Showdown team. */
function parseMine(results, body) {
	let sets;
	if (typeof body.minePaste === 'string') {
		const {Teams} = require('pokemon-showdown');
		sets = (Teams.import(body.minePaste) || []).map(s => ({...s, level: 50}));
	} else {
		const {toPokemonSet} = require('../sim/refine');
		const {clean} = require('../sim/util');
		const byId = new Map(results.entries.map(e => [e.id, e]));
		sets = (Array.isArray(body.mine) ? body.mine : []).map(m => {
			const e = byId.get(m.entryId);
			if (!e) throw new Error(`Unknown Pokémon ${m.entryId}`);
			return clean(toPokemonSet(e, m.set || e.set));
		});
	}
	if (sets.length < 3 || sets.length > 6) throw new Error('Your team needs 3 to 6 Pokémon');
	return sets;
}

/** Their species: must be ones the simulations have sets for (that is what we guess their sets from). */
function parseTheirs(results, list) {
	const known = new Map(results.entries.map(e => [e.species.toLowerCase().replace(/[^a-z0-9]/g, ''), e.species]));
	const out = [], unknown = [];
	for (const name of Array.isArray(list) ? list : []) {
		const sp = known.get(String(name).toLowerCase().replace(/[^a-z0-9]/g, ''));
		if (sp) out.push(sp); else unknown.push(name);
	}
	if (unknown.length) throw new Error(`No simulated sets for: ${unknown.join(', ')}`);
	if (out.length < 3 || out.length > 6) throw new Error('The opponent needs 3 to 6 Pokémon');
	return out;
}

/** Value one more option of a finished strong analysis (the player's pick, when outside the analysed corner). */
async function gradeDraft(req, res, jobId) {
	const job = jobs.get(jobId);
	let body;
	try {
		body = JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(res, 400, {error: 'Invalid request body'});
		return;
	}
	const option = Number(body.option);
	if (!job || job.status !== 'done' || !job.solver) {
		sendJson(res, 409, {error: 'Only a finished strong analysis can grade an extra option'});
		return;
	}
	if (!Number.isInteger(option) || option < 0 || option >= job.solver.sd.s.M) {
		sendJson(res, 400, {error: 'Unknown option'});
		return;
	}
	if (job.result.options.some(o => o.index === option)) {
		sendJson(res, 200, {jobId});
		return;
	}
	const {sd, budget, mine, theirs} = job.solver;
	const start = sd.s.battles, expected = sd.opts.grade * Math.max(1, job.result.theirMix.length);
	job.status = 'running';
	job.progress = 0;
	job.message = 'Grading your pick with the strong AI…';
	sendJson(res, 202, {jobId});
	try {
		const r = await sd.gradeOption(option, () => { job.progress = Math.min(0.99, (sd.s.battles - start) / expected); });
		job.result = draftResult({...r, matrix: sd.s}, budget, mine, theirs);
		job.status = 'done';
		job.progress = 1;
	} catch (e) {
		job.status = 'error';
		job.error = e.message;
		console.error('grading failed:', e);
	}
}

function serveStatic(req, res) {
	const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
	const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
	if (!file.startsWith(ROOT + path.sep) || path.extname(file) === '.cjs') {
		res.writeHead(403).end();
		return;
	}
	fs.readFile(file, (err, data) => {
		if (err) {
			res.writeHead(404).end('Not found');
			return;
		}
		res.writeHead(200, {'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache'});
		res.end(data);
	});
}

http.createServer((req, res) => {
	const url = new URL(req.url, 'http://x').pathname;
	if (url === '/api/collection' && req.method === 'POST') {
		postCollection(req, res).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	if (url === '/api/tune' && req.method === 'POST') {
		postTune(req, res).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	if (url === '/api/tune' && req.method === 'GET') {
		const keys = (new URL(req.url, 'http://x').searchParams.get('keys') || '').split(',').filter(Boolean).slice(0, 40);
		sendJson(res, 200, {jobs: getTuner().status(keys)});
		return;
	}
	if (url === '/api/draft' && req.method === 'POST') {
		startDraft(req, res).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	const g = url.match(/^\/api\/draft\/([a-z0-9]+)\/grade$/);
	if (g && req.method === 'POST') {
		gradeDraft(req, res, g[1]).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	const m = url.match(/^\/api\/draft\/([a-z0-9]+)$/);
	if (m && req.method === 'GET') {
		const job = jobs.get(m[1]);
		if (!job) sendJson(res, 404, {error: 'Unknown job'});
		else sendJson(res, 200, job);
		return;
	}
	if (url.startsWith('/api/')) {
		sendJson(res, 404, {error: 'Not found'});
		return;
	}
	serveStatic(req, res);
}).listen(PORT, '127.0.0.1', () => {
	console.log(`Team builder running at http://localhost:${PORT}`);
	getTuner(); // check for AWS and load cached tunings now, not on the first request
});
