// Classical indicator set. Every function takes and returns plain arrays
// aligned to the input, with `null` in the warm-up region so a caller can
// never mistake a seeding value for a real reading.

import { mean, stdev, slope } from '../core/num.js';

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= period) acc -= values[i - period];
    if (i >= period - 1) out[i] = acc / period;
  }
  return out;
}

/** EMA seeded with the SMA of the first `period` values (Wilder-compatible). */
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = mean(values.slice(0, period));
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (alpha = 1/period), used by RSI, ATR and ADX. */
export function wilder(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = prev + (values[i] - prev) / period;
    out[i] = prev;
  }
  return out;
}

/** The 8/21/55/200 EMA ribbon from the spec, plus its stack state. */
export function emaRibbon(closes, periods = [8, 21, 55, 200]) {
  const lines = periods.map((p) => ({ period: p, values: ema(closes, p) }));
  const i = closes.length - 1;
  const latest = lines.map((l) => l.values[i]);
  const ready = latest.every((v) => v != null);
  let stack = 0; // +1 fully bullish, -1 fully bearish, 0 tangled
  if (ready) {
    const asc = latest.every((v, k) => k === 0 || latest[k - 1] > v);
    const desc = latest.every((v, k) => k === 0 || latest[k - 1] < v);
    stack = asc ? 1 : desc ? -1 : 0;
  }
  // Compression = ribbon width relative to price; a squeeze precedes expansion.
  const width = ready ? (Math.max(...latest) - Math.min(...latest)) / closes[i] : null;
  return { lines, latest, ready, stack, width };
}

export function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const line = closes.map((_, i) => (ef[i] != null && es[i] != null ? ef[i] - es[i] : null));
  const firstIdx = line.findIndex((v) => v != null);
  const compact = firstIdx === -1 ? [] : line.slice(firstIdx).map((v) => v ?? 0);
  const sigCompact = ema(compact, signalPeriod);
  const signal = new Array(closes.length).fill(null);
  for (let i = 0; i < sigCompact.length; i++) {
    if (sigCompact[i] != null) signal[firstIdx + i] = sigCompact[i];
  }
  const hist = closes.map((_, i) => (line[i] != null && signal[i] != null ? line[i] - signal[i] : null));
  return { line, signal, hist };
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gains.push(Math.max(0, d));
    losses.push(Math.max(0, -d));
  }
  const ag = wilder(gains, period);
  const al = wilder(losses, period);
  for (let i = 0; i < ag.length; i++) {
    if (ag[i] == null || al[i] == null) continue;
    const rs = al[i] === 0 ? Infinity : ag[i] / al[i];
    out[i + 1] = al[i] === 0 ? 100 : 100 - 100 / (1 + rs);
  }
  return out;
}

export function trueRange(candles) {
  return candles.map((c, i) => {
    if (i === 0) return c.h - c.l;
    const pc = candles[i - 1].c;
    return Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
  });
}

export function atr(candles, period = 14) {
  return wilder(trueRange(candles), period);
}

/** Wilder's ADX with +DI / -DI. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const empty = { adx: new Array(n).fill(null), plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null) };
  if (n < period * 2) return empty;

  const tr = [], plusDM = [], minusDM = [];
  for (let i = 1; i < n; i++) {
    const up = candles[i].h - candles[i - 1].h;
    const down = candles[i - 1].l - candles[i].l;
    plusDM.push(up > down && up > 0 ? up : 0);
    minusDM.push(down > up && down > 0 ? down : 0);
    const pc = candles[i - 1].c;
    tr.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - pc), Math.abs(candles[i].l - pc)));
  }

  const atrS = wilder(tr, period);
  const pS = wilder(plusDM, period);
  const mS = wilder(minusDM, period);

  const plusDI = new Array(n).fill(null);
  const minusDI = new Array(n).fill(null);
  const dx = [];
  for (let i = 0; i < atrS.length; i++) {
    if (atrS[i] == null || atrS[i] === 0) { dx.push(null); continue; }
    const p = (100 * pS[i]) / atrS[i];
    const m = (100 * mS[i]) / atrS[i];
    plusDI[i + 1] = p;
    minusDI[i + 1] = m;
    const denom = p + m;
    dx.push(denom === 0 ? 0 : (100 * Math.abs(p - m)) / denom);
  }

  const dxVals = dx.filter((v) => v != null);
  const firstDx = dx.findIndex((v) => v != null);
  const adxCompact = wilder(dxVals, period);
  const adxOut = new Array(n).fill(null);
  for (let i = 0; i < adxCompact.length; i++) {
    if (adxCompact[i] != null) adxOut[firstDx + i + 1] = adxCompact[i];
  }
  return { adx: adxOut, plusDI, minusDI };
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  const bandwidth = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const sd = stdev(win, false);
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
    bandwidth[i] = mid[i] === 0 ? 0 : (upper[i] - lower[i]) / mid[i];
  }
  return { mid, upper, lower, bandwidth };
}

/**
 * Squeeze detection: bandwidth in the bottom `pct` of its own recent history
 * means coiled; a bandwidth rising off that floor is the expansion trigger.
 */
export function bbSqueeze(closes, { period = 20, mult = 2, lookback = 120, pct = 0.2 } = {}) {
  const bb = bollinger(closes, period, mult);
  const bw = bb.bandwidth.filter((v) => v != null);
  if (bw.length < 10) return { squeeze: false, expanding: false, percentile: 0.5, bandwidth: null, bb };
  const hist = bw.slice(-lookback);
  const current = bw[bw.length - 1];
  const prior = bw[bw.length - 2] ?? current;
  const below = hist.filter((v) => v < current).length / hist.length;
  return {
    bb,
    bandwidth: current,
    percentile: below,
    squeeze: below <= pct,
    expanding: current > prior * 1.08 && below > pct,
  };
}

/** Bars-since-slope of a series, normalized by price — a momentum proxy. */
export function normalizedSlope(values, lookback, reference) {
  const vals = values.filter((v) => v != null).slice(-lookback);
  if (vals.length < 3 || !reference) return 0;
  return (slope(vals) * vals.length) / reference;
}
