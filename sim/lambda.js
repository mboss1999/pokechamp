'use strict';
// AWS Lambda entry point: plays a chunk of battle jobs, exactly as a sim/pool.js worker does.
// Deployed by aws/lambda-deploy.sh as the function champions-sim-battles; called through sim/lambdapool.js.
//
// event:  {jobs: [{a, b, seed, agents?, picks?, hp?} | {type, ...}], teams?: [PokemonSet[]]}
//         With `teams`, a job's a/b may be indices into it (each team is sent once per chunk, not once per battle).
// result: {results: [...one per job, failed ones marked failed...], errors: [message...]}

const {runJob, fallbackResult} = require('./pool');

exports.handler = async event => {
	const errors = [];
	const teams = event.teams || [];
	const results = (event.jobs || []).map(j => {
		try {
			if (typeof j.a === 'number') j = {...j, a: teams[j.a], b: teams[j.b]};
			return runJob(j);
		} catch (e) {
			errors.push(String(e && e.stack || e).split('\n').slice(0, 3).join(' | '));
			return fallbackResult(j);
		}
	});
	return {results, errors};
};
