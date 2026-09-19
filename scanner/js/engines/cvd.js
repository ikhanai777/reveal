// Cumulative Volume Delta and multi-timeframe divergence.
//
// The exhaustion pattern the spec calls out: price prints a higher high while
// CVD prints a lower high, meaning the new price high was reached without new
// aggressive buying behind it.

import { swings } from './structure.js';

/** Running CVD series aligned to a candle array. */
export function cvdSeries(candles) {
  let acc = 0;
  return candles.map((c) => {
    acc += (c.buyVol ?? 0) - (c.sellVol ?? 0);
    return acc;
  });
}

export class CVDTracker {
  constructor({ reset = 'session' } = {}) {
    this.reset = reset;
    this.value = 0;
    this.sessionStart = null;
    this.history = [];
  }

  addTrade(trade) {
    if (this.reset === 'session') {
      const day = Math.floor(trade.ts / 86_400_000);
      if (this.sessionStart !== day) { this.sessionStart = day; this.value = 0; }
    }
    this.value += trade.side > 0 ? trade.size : -trade.size;
    return this.value;
  }

  mark(ts) {
    this.history.push({ ts, value: this.value });
    if (this.history.length > 5000) this.history.shift();
    return this.value;
  }
}

/**
 * Divergence between price pivots and CVD at the same pivots.
 * Returns the most recent qualifying pattern per direction.
 */
export function cvdDivergence(candles, { strength = 3, lookback = 80 } = {}) {
  const window = candles.slice(-lookback);
  if (window.length < strength * 2 + 3) return { bullish: null, bearish: null };
  const cvd = cvdSeries(window);
  const { highs, lows } = swings(window, strength);

  const pair = (pivots, priceCmp, cvdCmp, kind) => {
    const pts = pivots.slice(-4);
    for (let i = pts.length - 1; i >= 1; i--) {
      const b = pts[i], a = pts[i - 1];
      if (priceCmp(b.price, a.price) && cvdCmp(cvd[b.index], cvd[a.index])) {
        const span = Math.max(1e-9, Math.abs(cvd[a.index]) + Math.abs(cvd[b.index]));
        return {
          kind,
          dir: kind === 'bullish' ? 1 : -1,
          strength: Math.min(1, Math.abs(cvd[b.index] - cvd[a.index]) / span),
          from: { t: a.t, price: a.price, cvd: cvd[a.index] },
          to: { t: b.t, price: b.price, cvd: cvd[b.index] },
          barsAgo: window.length - 1 - b.index,
        };
      }
    }
    return null;
  };

  return {
    series: cvd,
    // Price HH + CVD LH = bearish exhaustion. Price LL + CVD HL = bullish absorption.
    bearish: pair(highs, (b, a) => b > a, (b, a) => b < a, 'bearish'),
    bullish: pair(lows, (b, a) => b < a, (b, a) => b > a, 'bullish'),
  };
}

/** Agreement across timeframes: +1 all bullish, -1 all bearish, 0 mixed. */
export function multiTimeframeCVD(seriesByTf, opts) {
  const rows = [];
  for (const [tf, candles] of Object.entries(seriesByTf)) {
    const d = cvdDivergence(candles, opts);
    const bull = d.bullish && d.bullish.barsAgo <= 5;
    const bear = d.bearish && d.bearish.barsAgo <= 5;
    rows.push({ tf, dir: bull && !bear ? 1 : bear && !bull ? -1 : 0, detail: d });
  }
  const net = rows.reduce((a, r) => a + r.dir, 0);
  return { rows, net: rows.length ? net / rows.length : 0 };
}
