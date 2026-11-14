'use strict';
// Zero-sum matrix games. Both players in a Pokémon turn (and at team preview) choose at the same time, so
// the right notion of "best choice" is an equilibrium of the payoff matrix, not a max over one side.
//
// The Bayesian form handles hidden sets: the row player (the one being analysed) doesn't know which
// determinization d is real and plays one strategy x; the column player knows d and plays y_d.
//   max_x  sum_d p_d  min_{y_d}  x' A_d y_d

/**
 * @param As  [A_d], each row-major m x n_d payoffs to the row player (same m rows in every A_d)
 * @param ps  probabilities p_d (default uniform)
 * @returns {x, ys, value, rowVals, gap} rowVals[i] = value of pure row i against the ys; gap bounds exploitability
 */
function solveBayes(As, ps = null, {iters = 4000, tol = 2e-4} = {}) {
	const D = As.length, m = As[0].length;
	ps = ps || new Array(D).fill(1 / D);
	const rx = new Float64Array(m), sx = new Float64Array(m), x = new Float64Array(m).fill(1 / m);
	const ry = As.map(A => new Float64Array(A[0].length));
	const sy = As.map(A => new Float64Array(A[0].length));
	const ys = As.map(A => new Float64Array(A[0].length).fill(1 / A[0].length));
	const norm = (r, out) => {
		let t = 0;
		for (let i = 0; i < r.length; i++) t += r[i];
		for (let i = 0; i < r.length; i++) out[i] = t > 0 ? r[i] / t : 1 / r.length;
	};
	let result = null;
	for (let it = 1; it <= iters; it++) {
		const u = new Float64Array(m);
		for (let d = 0; d < D; d++) {
			const A = As[d], y = ys[d], n = y.length;
			for (let i = 0; i < m; i++) {
				let s = 0;
				for (let j = 0; j < n; j++) s += A[i][j] * y[j];
				u[i] += ps[d] * s;
			}
		}
		let ux = 0;
		for (let i = 0; i < m; i++) ux += x[i] * u[i];
		for (let d = 0; d < D; d++) {
			const A = As[d], y = ys[d], n = y.length;
			const v = new Float64Array(n);
			let vy = 0;
			for (let j = 0; j < n; j++) {
				let s = 0;
				for (let i = 0; i < m; i++) s += A[i][j] * x[i];
				v[j] = s; vy += s * y[j];
			}
			for (let j = 0; j < n; j++) ry[d][j] = Math.max(0, ry[d][j] + vy - v[j]);
			for (let j = 0; j < n; j++) sy[d][j] += it * y[j];
		}
		for (let i = 0; i < m; i++) rx[i] = Math.max(0, rx[i] + u[i] - ux);
		for (let i = 0; i < m; i++) sx[i] += it * x[i];
		norm(rx, x);
		for (let d = 0; d < D; d++) norm(ry[d], ys[d]);
		if (it % 200 === 0 || it === iters) {
			result = evaluateBayes(As, ps, normalize(sx), sy.map(normalize));
			if (result.gap < tol) break;
		}
	}
	return result;
}

function normalize(s) {
	const t = s.reduce((a, b) => a + b, 0);
	return Array.from(s, v => v / t);
}

/** Values of each pure row against the ys, and the exploitability gap of (x, ys). */
function evaluateBayes(As, ps, x, ys) {
	const m = As[0].length;
	const rowVals = new Array(m).fill(0);
	let bestResponse = 0; // the column players' best responses to x
	As.forEach((A, d) => {
		const n = A[0].length;
		for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) rowVals[i] += ps[d] * A[i][j] * ys[d][j];
		let worst = Infinity;
		for (let j = 0; j < n; j++) {
			let s = 0;
			for (let i = 0; i < m; i++) s += A[i][j] * x[i];
			worst = Math.min(worst, s);
		}
		bestResponse += ps[d] * worst;
	});
	const value = rowVals.reduce((s, r, i) => s + r * x[i], 0);
	return {x, ys, value, rowVals, gap: Math.max(...rowVals) - bestResponse, guaranteed: bestResponse};
}

/** Ordinary (one-type) zero-sum game. */
function solve(A, opts) {
	const r = solveBayes([A], [1], opts);
	const colVals = A[0].map((_, j) => A.reduce((s, row, i) => s + row[j] * r.x[i], 0));
	return {...r, y: r.ys[0], colVals};
}

module.exports = {solve, solveBayes, evaluateBayes};
