// Bar-series indicators used by the signal rules and the backtester.
// All functions return arrays aligned index-for-index with `bars`, with NaN
// where there is not yet enough history — never a silently shortened array.

export function trueRange(bars) {
  const out = new Array(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i === 0) {
      out[i] = b.high - b.low;
    } else {
      const pc = bars[i - 1].close;
      out[i] = Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    }
  }
  return out;
}

/** Wilder-smoothed ATR. */
export function atr(bars, period = 14) {
  const tr = trueRange(bars);
  const out = new Array(bars.length).fill(NaN);
  if (bars.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function sma(values, period) {
  const out = new Array(values.length).fill(NaN);
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (Number.isFinite(v)) { sum += v; count++; }
    if (i >= period) {
      const old = values[i - period];
      if (Number.isFinite(old)) { sum -= old; count--; }
    }
    if (i >= period - 1 && count > 0) out[i] = sum / count;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(NaN);
  const k = 2 / (period + 1);
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    prev = Number.isFinite(prev) ? v * k + prev * (1 - k) : v;
    out[i] = prev;
  }
  return out;
}

/** Rolling standard deviation, population form. */
export function rollingStdev(values, period) {
  const out = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (Number.isFinite(values[j])) { sum += values[j]; n++; }
    }
    if (!n) continue;
    const m = sum / n;
    let acc = 0;
    for (let j = i - period + 1; j <= i; j++) {
      if (Number.isFinite(values[j])) acc += (values[j] - m) ** 2;
    }
    out[i] = Math.sqrt(acc / n);
  }
  return out;
}

/** z-score of each value against its own trailing window. */
export function rollingZ(values, period) {
  const m = sma(values, period);
  const s = rollingStdev(values, period);
  return values.map((v, i) => {
    if (!Number.isFinite(v) || !Number.isFinite(m[i]) || !(s[i] > 0)) return NaN;
    return (v - m[i]) / s[i];
  });
}

/**
 * Pivot highs/lows confirmed by `left` bars before and `right` bars after.
 * The pivot is only "known" at index i + right, which the signal rules respect
 * so nothing peeks into the future.
 */
export function pivots(bars, left = 2, right = 2) {
  const highs = new Array(bars.length).fill(false);
  const lows = new Array(bars.length).fill(false);
  for (let i = left; i < bars.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    highs[i] = isHigh;
    lows[i] = isLow;
  }
  return { highs, lows, right };
}

/** Lowest low / highest high over the trailing `period` bars (inclusive). */
export function rollingExtremes(bars, period) {
  const lowest = new Array(bars.length).fill(NaN);
  const highest = new Array(bars.length).fill(NaN);
  for (let i = 0; i < bars.length; i++) {
    const from = Math.max(0, i - period + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (let j = from; j <= i; j++) {
      if (bars[j].low < lo) lo = bars[j].low;
      if (bars[j].high > hi) hi = bars[j].high;
    }
    lowest[i] = lo;
    highest[i] = hi;
  }
  return { lowest, highest };
}

/** Everything the rules need, computed once per bar series. */
export function computeContext(bars, { atrPeriod = 14, volPeriod = 20, lookback = 20 } = {}) {
  const volumes = bars.map((b) => b.volume);
  const deltas = bars.map((b) => b.delta);
  const ranges = bars.map((b) => b.range);
  return {
    atr: atr(bars, atrPeriod),
    volumeSma: sma(volumes, volPeriod),
    volumeZ: rollingZ(volumes, volPeriod),
    deltaZ: rollingZ(deltas, volPeriod),
    rangeSma: sma(ranges, volPeriod),
    ema: ema(bars.map((b) => b.close), Math.max(2, lookback)),
    extremes: rollingExtremes(bars, lookback),
    pivots: pivots(bars, 2, 2),
  };
}
