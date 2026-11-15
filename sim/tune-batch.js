'use strict';
// Tune many teams at once on every core of this machine: what the app's cloud machine runs (see sim/tuner.js).
//
//   node sim/tune-batch.js <input.json> <output.json>
//
// input:  {budget, teams: [{key, members: [{entryId, set}]}]}   (in priority order, most wanted first)
// output: {done: {key: refineTeam result}, progress: {key: [fraction, message]}, failed: {key: message}}
// The output is rewritten as teams progress. When RUN_OUT is set (by aws/launch.sh) it is also uploaded to
// $RUN_OUT/<output file name> within a few seconds of every change, so the app can show results as they land.

const fs = require('fs');
const path = require('path');
const {execFile} = require('child_process');
const {Pool} = require('./pool');
const {refineTeam} = require('./refine');

const [inFile, outFile] = process.argv.slice(2);
if (!inFile || !outFile) {
	console.error('usage: node sim/tune-batch.js <input.json> <output.json>');
	process.exit(2);
}
const input = JSON.parse(fs.readFileSync(inFile, 'utf8'));
const results = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'web', 'data', 'results.json'), 'utf8'));
const state = {done: {}, progress: {}, failed: {}};

let dirty = true, uploading = null;
function write() {
	fs.writeFileSync(outFile + '.tmp', JSON.stringify(state));
	fs.renameSync(outFile + '.tmp', outFile);
}
function upload() {
	if (!process.env.RUN_OUT || uploading) return uploading;
	dirty = false;
	write();
	const dest = `${process.env.RUN_OUT}/${path.basename(outFile)}`;
	const args = ['s3', 'cp', '--quiet', outFile, dest, ...(process.env.RUN_REGION ? ['--region', process.env.RUN_REGION] : [])];
	uploading = new Promise(resolve => execFile('aws', args, err => {
		if (err) console.error('upload failed:', err.message);
		uploading = null;
		resolve();
	}));
	return uploading;
}
const timer = setInterval(() => { if (dirty) upload(); }, 3000);

(async () => {
	const pool = new Pool();
	const t0 = Date.now();
	console.log(`[tune] ${input.teams.length} team(s) on ${pool.size} workers`);
	await Promise.all(input.teams.map(async (t, i) => {
		const started = Date.now();
		try {
			const r = await refineTeam(pool, results, t.members, {
				budget: input.budget || 'normal',
				priority: input.teams.length - i, // earlier teams' battles go first
				onProgress: (p, msg) => {
					const prev = state.progress[t.key];
					state.progress[t.key] = [+p.toFixed(3), msg || (prev && prev[1]) || ''];
					dirty = true;
				},
			});
			state.done[t.key] = {...r, seconds: Math.round((Date.now() - started) / 1000)};
			delete state.progress[t.key];
			console.log(`[tune] ${t.key} done in ${state.done[t.key].seconds}s (${r.battles} battles)`);
		} catch (e) {
			state.failed[t.key] = e.message;
			console.error(`[tune] ${t.key} failed:`, e);
		}
		// results land in the app as soon as each team finishes
		while (uploading) await uploading;
		dirty = true;
		await upload();
	}));
	clearInterval(timer);
	while (uploading) await uploading;
	write();
	if (process.env.RUN_OUT) await upload();
	console.log(`[tune] all done in ${Math.round((Date.now() - t0) / 1000)}s, ${pool.battles} battles`);
	pool.close();
})().catch(e => {
	console.error(e);
	process.exit(1);
});
