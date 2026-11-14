'use strict';
// Typed worker jobs (anything other than a plain battle), dispatched by sim/pool.js workers.

const handlers = {
	turn: j => require('./engine').runJob(j),
	draft: j => require('./draft').runJob(j),
};

function run(job) {
	const h = handlers[job.type];
	if (!h) throw new Error(`unknown job type ${job.type}`);
	return h(job);
}

module.exports = {run};
