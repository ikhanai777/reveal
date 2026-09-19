// Monte Carlo: reshuffle the trade sequence to find how much of the observed
// drawdown was path luck. The trade set is held fixed — only the order changes
// — so the terminal return is identical and the dispersion is purely
// sequencing risk.

import { rng, shuffle, quantile, mean } from '../core/num.js';
import { drawdownProfile } from './metrics.js';

/**
 * @param {object[]} trades  closed trades with a `pnl` field
 * @param {object} [opts]
 * @param {number} [opts.runs=1000]
 * @param {number} [opts.startEquity]
 * @param {boolean} [opts.resample] sample with replacement (bootstrap) instead
 *   of permuting; this also varies the terminal return.
 */
export function monteCarlo(trades, { runs = 1000, startEquity = 10_000, seed = 42, resample = false } = {}) {
  if (!trades.length) return { runs: 0, maxDrawdown: {}, finalEquity: {}, curves: [] };
  const rand = rng(seed);
  const pnls = trades.map((t) => t.pnl);
  const drawdowns = [];
  const finals = [];
  const ruinThreshold = startEquity * 0.5;
  let ruins = 0;
  const sampleCurves = [];

  for (let r = 0; r < runs; r++) {
    const order = resample
      ? Array.from({ length: pnls.length }, () => pnls[Math.floor(rand() * pnls.length)])
      : shuffle(pnls, rand);

    let eq = startEquity;
    const curve = [{ ts: 0, value: eq }];
    let ruined = false;
    for (let i = 0; i < order.length; i++) {
      eq += order[i];
      curve.push({ ts: i + 1, value: eq });
      if (eq <= ruinThreshold) ruined = true;
    }
    if (ruined) ruins++;
    drawdowns.push(drawdownProfile(curve).max);
    finals.push(eq);
    if (r < 40) sampleCurves.push(curve.map((p) => p.value));
  }

  return {
    runs,
    resample,
    maxDrawdown: band(drawdowns),
    finalEquity: band(finals),
    riskOfRuin: ruins / runs,
    // The drawdown a strategy should actually be sized for.
    drawdown95: quantile(drawdowns, 0.05),
    curves: sampleCurves,
  };
}

function band(xs) {
  return {
    mean: mean(xs),
    p05: quantile(xs, 0.05),
    p25: quantile(xs, 0.25),
    median: quantile(xs, 0.5),
    p75: quantile(xs, 0.75),
    p95: quantile(xs, 0.95),
    min: Math.min(...xs),
    max: Math.max(...xs),
  };
}
