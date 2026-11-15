'use strict';
// One machine's part of a pipeline run split across several machines (aws/launch-sharded.sh). Machines don't
// talk to each other: they swap results through a shared folder (S3 or, for testing, a local directory).
//
//   sets1    set search pass 1 on this shard's entries (index % N === k), starting from --init-sets
//   sets2    merge everyone's pass 1, then pass 2 on this shard's entries against the merged population
//   battles  merge everyone's pass 2; play this shard's slice of the matchup and ladder battles
//   final    (shard 0 only) collect every slice, fit, export results.json to <shared>/results.json
//
// Each phase's output goes to <shared>/<phase>/shard<k>.json; a machine waits for all N before moving on. A
// machine replaced after a Spot interruption (launched with RESUME_RUN) skips phases it already finished
// (out/shard-state.json) and resumes the current one from its checkpoints.
//
//   node sim/shard.js --shard 0/4 --shared s3://bucket/runs/<group>/shared --init-sets web/data/results.json \
//        --scale 4 --matchups-agent rollout4all --ladder-agent rollout4all [other sim/pipeline.js options]

const fs = require('fs');
const path = require('path');
const {spawnSync, execFileSync} = require('child_process');

const argv = process.argv.slice(2);
const take = name => {
	const i = argv.indexOf('--' + name);
	if (i < 0) return null;
	const v = argv[i + 1];
	argv.splice(i, 2);
	return v;
};
const [K, N] = take('shard').split('/').map(Number);
const SHARED = take('shared').replace(/\/$/, '');
const INIT = take('init-sets');
const OUT = path.resolve(take('out') || 'out');
const PASS_THROUGH = argv; // everything else goes to sim/pipeline.js
const REGION = process.env.RUN_REGION || process.env.AWS_REGION || 'us-east-1';
const s3 = SHARED.startsWith('s3://');
fs.mkdirSync(OUT, {recursive: true});

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}] shard ${K}/${N}:`, ...a);

function put(local, name) {
	const dest = `${SHARED}/${name}`;
	if (s3) execFileSync('aws', ['s3', 'cp', local, dest, '--region', REGION, '--quiet']);
	else { fs.mkdirSync(path.dirname(dest), {recursive: true}); fs.copyFileSync(local, dest); }
}
function get(name, local) {
	const src = `${SHARED}/${name}`;
	try {
		if (s3) execFileSync('aws', ['s3', 'cp', src, local, '--region', REGION, '--quiet'], {stdio: 'ignore'});
		else fs.copyFileSync(src, local);
		return true;
	} catch {
		return false;
	}
}
/** Wait until every shard has published `phase`, downloading each into `dir`. Returns the local paths. */
function waitAll(phase, dir, file = k => `shard${k}.json`) {
	fs.mkdirSync(dir, {recursive: true});
	const have = new Map();
	let waited = 0;
	for (;;) {
		for (let k = 0; k < N; k++) {
			if (have.has(k)) continue;
			const local = path.join(dir, file(k));
			if (get(`${phase}/${file(k)}`, local)) have.set(k, local);
		}
		if (have.size === N) return [...have.keys()].sort().map(k => have.get(k));
		if (waited % 600 === 0) log(`waiting for ${phase} from ${N - have.size} shard(s)`);
		spawnSync('sleep', ['30']);
		waited += 30;
	}
}

function pipeline(args) {
	log('pipeline', args.join(' '));
	// MAIN_HEAP_MB caps the coordinating thread; worker threads are capped by WORKER_HEAP_MB (sim/pool.js). On a
	// 128 GB c7g.16xlarge the defaults (40 GB + 64 x 1 GB) let a rollout-heavy run exhaust RAM and hang the machine.
	const r = spawnSync(process.execPath, [`--max-old-space-size=${process.env.MAIN_HEAP_MB || 16000}`, path.join(__dirname, 'pipeline.js'),
		...args, ...PASS_THROUGH, '--out', OUT], {stdio: 'inherit'});
	if (r.status !== 0) throw new Error(`pipeline ${args.join(' ')} exited with ${r.status}`);
}

/** Merge shards' sets.json: every entry's most advanced version (highest pass). */
function mergeSets(files) {
	const merged = {};
	for (const f of files) {
		for (const [id, st] of Object.entries(JSON.parse(fs.readFileSync(f, 'utf8')))) {
			if (!merged[id] || (st.pass || 0) > (merged[id].pass || 0)) merged[id] = st;
		}
	}
	return merged;
}

const stateFile = path.join(OUT, 'shard-state.json');
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {done: []};
const mark = (key) => { state.done.push(key); fs.writeFileSync(stateFile, JSON.stringify(state)); };
const isDone = key => state.done.includes(key);
const write = (name, data) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(data));

if (!isDone('sets1')) {
	pipeline(['--stages', 'sets', '--passes', '1', '--shard', `${K}/${N}`, ...(INIT ? ['--init-sets', INIT] : [])]);
	put(path.join(OUT, 'sets.json'), `sets1/shard${K}.json`);
	mark('sets1');
}
if (!isDone('sets2-start')) {
	write('sets.json', mergeSets(waitAll('sets1', path.join(OUT, 'shared', 'sets1'))));
	write('sets.progress.json', {pass: 2, done: []});
	mark('sets2-start');
}
if (!isDone('sets2')) {
	pipeline(['--stages', 'sets', '--passes', '2', '--shard', `${K}/${N}`]);
	put(path.join(OUT, 'sets.json'), `sets2/shard${K}.json`);
	mark('sets2');
}
if (!isDone('battles-start')) {
	const merged = mergeSets(waitAll('sets2', path.join(OUT, 'shared', 'sets2')));
	write('sets.json', merged);
	log(`merged sets for ${Object.keys(merged).length} entries`);
	mark('battles-start');
}
if (!isDone('battles')) {
	pipeline(['--stages', 'matchups,ladder', '--shard', `${K}/${N}`]);
	put(path.join(OUT, `matchups.part${K}.json`), `battles/matchups.part${K}.json`);
	put(path.join(OUT, `ladder.part${K}.json`), `battles/ladder.part${K}.json`);
	mark('battles');
}
if (K === 0 && !isDone('final')) {
	waitAll('battles', OUT, k => `matchups.part${k}.json`);
	waitAll('battles', OUT, k => `ladder.part${k}.json`);
	pipeline(['--stages', 'matchups,ladder,export', '--parts', String(N), '--web', path.join(OUT, 'results.json')]);
	put(path.join(OUT, 'results.json'), 'results.json');
	put(path.join(OUT, 'sets.json'), 'sets.json');
	mark('final');
}
log('finished');
