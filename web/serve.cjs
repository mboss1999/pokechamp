'use strict';
// Team builder server: static files plus a local API that runs team refinement
// simulations on this machine's CPU cores. node web/serve.cjs [port]
//
//   POST /api/refine        {members: [{entryId, set}], budget: 'quick'|'normal'|'thorough'} -> {jobId}
//   GET  /api/refine/<id>   -> {status: 'running'|'done'|'error', progress, message, result?, error?}
//   POST /api/draft         {mine: [{entryId, set}] | minePaste: showdown text, theirs: [species], budget} -> {jobId}
//   GET  /api/draft/<id>    -> same shape as refine; result is the team preview analysis (sim/draft.js)

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.argv[2] || process.env.PORT || 5173);
const RESULTS = path.join(ROOT, 'data', 'results.json');
const TYPES = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
};

// Simulation machinery is loaded on first use so serving the page stays instant.
let pool = null;
const jobs = new Map();
let running = null;

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

function getPool() {
	if (!pool) {
		const {Pool} = require('../sim/pool');
		pool = new Pool();
	}
	return pool;
}

// Team preview analysis budgets (samples per cell at each adaptive stage; see sim/draft.js).
const DRAFT_BUDGETS = {
	quick: {screen: 2, refine: 8, grade: 24},
	normal: {screen: 4, refine: 16, grade: 48},
};

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
	// rough battle count for the progress bar: every cell screened, a 16x16 corner refined, ~8 columns graded
	const expected = 3600 * b.screen + 256 * b.refine + 60 * 8 * b.grade;
	const jobId = Math.random().toString(36).slice(2, 10);
	const job = {status: 'running', progress: 0, message: 'Simulating team preview…', startedAt: Date.now()};
	jobs.set(jobId, job);
	sendJson(res, 202, {jobId});
	try {
		const {solveDraft} = require('../sim/draft');
		const r = await solveDraft(getPool(), mine, theirs, {
			...b, resultsPath: RESULTS,
			onProgress: battles => { job.progress = Math.min(0.99, battles / expected); },
		});
		const A = r.matrix.matrix();
		job.result = {
			value: r.value, battles: r.battles, budget, mine: mine.map(s => s.species), theirs,
			options: r.options.map(o => ({...o, vsTheirs: r.theirMix.map(t => A[o.index][t.index])})),
			theirMix: r.theirMix,
		};
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

async function startRefine(req, res) {
	if (running && jobs.get(running)?.status === 'running') {
		sendJson(res, 409, {error: 'A refinement is already running. Wait for it to finish.', jobId: running});
		return;
	}
	let body;
	try {
		body = JSON.parse(await readBody(req));
	} catch (e) {
		sendJson(res, 400, {error: 'Invalid request body'});
		return;
	}
	const members = Array.isArray(body.members) ? body.members.slice(0, 6) : [];
	if (members.length < 3 || members.some(m => typeof m.entryId !== 'string')) {
		sendJson(res, 400, {error: 'Send 3 to 6 team members'});
		return;
	}
	const budget = ['quick', 'normal', 'thorough'].includes(body.budget) ? body.budget : 'normal';
	const jobId = Math.random().toString(36).slice(2, 10);
	const job = {status: 'running', progress: 0, message: 'Starting simulator…', startedAt: Date.now()};
	jobs.set(jobId, job);
	running = jobId;
	sendJson(res, 202, {jobId});

	try {
		const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8'));
		const {refineTeam} = require('../sim/refine');
		job.result = await refineTeam(getPool(), results, members, {
			budget,
			onProgress: (p, msg) => { job.progress = p; if (msg) job.message = msg; },
		});
		job.status = 'done';
		job.progress = 1;
		job.seconds = Math.round((Date.now() - job.startedAt) / 1000);
	} catch (e) {
		job.status = 'error';
		job.error = e.message;
		console.error('refine failed:', e);
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
	if (url === '/api/refine' && req.method === 'POST') {
		startRefine(req, res).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	if (url === '/api/draft' && req.method === 'POST') {
		startDraft(req, res).catch(e => sendJson(res, 500, {error: e.message}));
		return;
	}
	const m = url.match(/^\/api\/(?:refine|draft)\/([a-z0-9]+)$/);
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
}).listen(PORT, '127.0.0.1', () => console.log(`Team builder running at http://localhost:${PORT}`));
