// Walk-forward analysis: optimize on 70% in-sample, validate on the untouched
// 30% out-of-sample, rolling the window forward. The gap between the two is
// the honest read on whether an optimization found edge or found noise.

import { runBacktest } from './engine.js';
import { DEFAULT_WEIGHTS } from '../signal/scoring.js';
import { tfMs } from '../core/timeframe.js';

/** Candidate weight sets around the spec defaults, normalized to sum to 1. */
export function weightGrid({ steps = [-0.08, 0, 0.08], keys = ['ta', 'orderFlow', 'ml'] } = {}) {
  const out = [];
  const combos = cartesian(keys.map(() => steps));
  for (const combo of combos) {
    const w = { ...DEFAULT_WEIGHTS };
    keys.forEach((k, i) => { w[k] = Math.max(0.02, w[k] + combo[i]); });
    const total = Object.values(w).reduce((a, b) => a + b, 0);
    for (const k of Object.keys(w)) w[k] = +(w[k] / total).toFixed(4);
    out.push(w);
  }
  return dedupe(out);
}

function cartesian(arrays) {
  return arrays.reduce((acc, arr) => acc.flatMap((a) => arr.map((v) => [...a, v])), [[]]);
}

function dedupe(sets) {
  const seen = new Set();
  return sets.filter((w) => {
    const k = JSON.stringify(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Default objective: risk-adjusted, penalized for thin trade counts. */
export function defaultObjective(metrics) {
  if (!metrics.trades) return -Infinity;
  const confidence = Math.min(1, metrics.trades / 20);
  return metrics.sharpe * confidence - Math.abs(metrics.maxDrawdown) * 2;
}

/**
 * @param {object} args
 * @param {object[]} args.candles       oldest-first
 * @param {string}   args.timeframe
 * @param {number}   [args.windowMonths] rolling window length
 * @param {number}   [args.inSamplePct]
 * @param {object[]} [args.candidates]  weight sets to search
 */
export function walkForward({
  candles, timeframe = '5m', windowMonths = 3, inSamplePct = 0.7,
  candidates = weightGrid(), objective = defaultObjective, config = {}, funding = [], openInterest = [], onProgress = null,
}) {
  const barMs = tfMs(timeframe);
  const warmup = config.warmup ?? 250;
  const requested = Math.floor((windowMonths * 30 * 86_400_000) / barMs);
  // A window longer than the history available collapses to a single split;
  // clamping beats recursing, which can fail to converge on short histories.
  const windowBars = Math.min(requested, candles.length);
  const minWindow = warmup * 2 + 70;
  if (windowBars < minWindow) {
    throw new Error(`need at least ${minWindow} bars for a walk-forward fold at warmup ${warmup}, got ${candles.length}`);
  }

  const stepBars = Math.max(1, Math.floor(windowBars * (1 - inSamplePct)));
  const folds = [];

  for (let start = 0; start + windowBars <= candles.length; start += stepBars) {
    const window = candles.slice(start, start + windowBars);
    const splitAt = Math.floor(window.length * inSamplePct);
    const inSample = window.slice(0, splitAt);
    const outSample = window.slice(Math.max(0, splitAt - warmup)); // carry warm-up context

    if (inSample.length < warmup + 50 || outSample.length < warmup + 20) continue;

    let best = null;
    for (const weights of candidates) {
      try {
        const res = runBacktest({ candles: inSample, timeframe, weights, config, funding, openInterest });
        const obj = objective(res.metrics);
        if (!best || obj > best.objective) best = { weights, objective: obj, metrics: res.metrics };
      } catch { /* a candidate that cannot run simply loses the search */ }
    }
    if (!best) continue;

    let oos = null;
    try {
      const res = runBacktest({ candles: outSample, timeframe, weights: best.weights, config, funding, openInterest });
      oos = res.metrics;
    } catch { /* leave oos null; the fold reports as unvalidated */ }

    folds.push({
      fold: folds.length + 1,
      inSampleRange: [inSample[0].t, inSample[inSample.length - 1].t],
      outSampleRange: [outSample[0].t, outSample[outSample.length - 1].t],
      weights: best.weights,
      inSample: best.metrics,
      outSample: oos,
      // >1 means out-of-sample held up; well under 1 is curve-fitting.
      efficiency: oos && best.metrics.sharpe ? oos.sharpe / best.metrics.sharpe : null,
    });
    if (onProgress) onProgress({ folds: folds.length, at: start, total: candles.length });
  }

  const valid = folds.filter((f) => f.outSample);
  const avg = (fn) => (valid.length ? valid.reduce((a, f) => a + fn(f), 0) / valid.length : 0);

  return {
    folds,
    summary: {
      foldCount: folds.length,
      avgInSampleSharpe: avg((f) => f.inSample.sharpe),
      avgOutSampleSharpe: avg((f) => f.outSample.sharpe),
      avgEfficiency: avg((f) => f.efficiency ?? 0),
      oosWinRate: avg((f) => f.outSample.winRate),
      oosProfitable: valid.filter((f) => f.outSample.cumulativeReturn > 0).length,
      // Consensus weights: the average of what each fold chose.
      consensusWeights: consensus(folds.map((f) => f.weights)),
    },
  };
}

function consensus(sets) {
  if (!sets.length) return DEFAULT_WEIGHTS;
  const keys = Object.keys(sets[0]);
  const out = {};
  for (const k of keys) out[k] = +(sets.reduce((a, s) => a + s[k], 0) / sets.length).toFixed(4);
  return out;
}
