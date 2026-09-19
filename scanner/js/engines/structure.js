// Market structure: swing mapping, fair value gaps, change of character and
// structure breaks. Everything keys off confirmed fractal pivots, so a swing
// only exists once `strength` bars have closed on both sides of it.

/**
 * Fractal pivots. A high at i is a pivot when it is the strict max of the
 * window [i-strength, i+strength]. Pivots near the right edge are unconfirmed
 * and are deliberately not returned.
 */
export function swings(candles, strength = 3) {
  const highs = [], lows = [];
  for (let i = strength; i < candles.length - strength; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      if (candles[j].h >= candles[i].h) isHigh = false;
      if (candles[j].l <= candles[i].l) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push({ index: i, t: candles[i].t, price: candles[i].h, kind: 'high' });
    if (isLow) lows.push({ index: i, t: candles[i].t, price: candles[i].l, kind: 'low' });
  }
  return { highs, lows, all: [...highs, ...lows].sort((a, b) => a.index - b.index) };
}

/**
 * Fair value gaps: a three-candle imbalance where candle i-2 and candle i do
 * not overlap. Gaps are reported unfilled-first with the fill state resolved
 * against every later candle.
 */
export function fairValueGaps(candles, { minSizePct = 0.0005, maxAge = 300 } = {}) {
  const out = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2], c = candles[i];
    const ref = c.c || 1;
    if (a.h < c.l) {
      const size = (c.l - a.h) / ref;
      if (size >= minSizePct) out.push({ dir: 1, from: a.h, to: c.l, index: i, t: c.t, size });
    } else if (a.l > c.h) {
      const size = (a.l - c.h) / ref;
      if (size >= minSizePct) out.push({ dir: -1, from: c.h, to: a.l, index: i, t: c.t, size });
    }
  }
  const last = candles.length - 1;
  for (const g of out) {
    g.filled = false;
    for (let i = g.index + 1; i < candles.length; i++) {
      // A bullish gap fills when price trades back down through its low edge.
      if (g.dir === 1 ? candles[i].l <= g.from : candles[i].h >= g.to) { g.filled = true; g.filledAt = candles[i].t; break; }
    }
    g.age = last - g.index;
  }
  return out.filter((g) => g.age <= maxAge);
}

/**
 * Trend state from swing sequence, plus the two events the spec names:
 *   MSB   — trend continuation: a break of the prior swing in the trend's own
 *           direction (a higher high while already bullish).
 *   ChoCh — the first break against the established trend.
 */
export function marketStructure(candles, { strength = 3 } = {}) {
  const { all } = swings(candles, strength);
  const events = [];
  let trend = 0;           // +1 bullish, -1 bearish, 0 undecided
  let lastHigh = null, lastLow = null;

  for (const p of all) {
    if (p.kind === 'high') {
      if (lastHigh && p.price > lastHigh.price) {
        const type = trend === -1 ? 'ChoCh' : 'MSB';
        events.push({ type, dir: 1, index: p.index, t: p.t, price: p.price, brokeLevel: lastHigh.price });
        trend = 1;
      }
      lastHigh = p;
    } else {
      if (lastLow && p.price < lastLow.price) {
        const type = trend === 1 ? 'ChoCh' : 'MSB';
        events.push({ type, dir: -1, index: p.index, t: p.t, price: p.price, brokeLevel: lastLow.price });
        trend = -1;
      }
      lastLow = p;
    }
  }

  const lastEvent = events[events.length - 1] || null;
  return {
    trend,
    events,
    lastEvent,
    barsSinceEvent: lastEvent ? candles.length - 1 - lastEvent.index : null,
    lastSwingHigh: lastHigh,
    lastSwingLow: lastLow,
  };
}

/**
 * Regular divergence between price and an oscillator, measured at confirmed
 * price pivots. Bullish: price lower low, oscillator higher low.
 */
export function divergence(candles, osc, { strength = 3, lookback = 60, maxPivots = 4 } = {}) {
  const window = candles.slice(-lookback);
  const offset = candles.length - window.length;
  const { highs, lows } = swings(window, strength);
  const oscAt = (i) => osc[offset + i];

  const findPair = (pivots, priceCmp, oscCmp, kind) => {
    const pts = pivots.slice(-maxPivots).filter((p) => oscAt(p.index) != null);
    for (let i = pts.length - 1; i >= 1; i--) {
      const b = pts[i], a = pts[i - 1];
      if (priceCmp(b.price, a.price) && oscCmp(oscAt(b.index), oscAt(a.index))) {
        return {
          kind,
          dir: kind === 'bullish' ? 1 : -1,
          from: { t: a.t, price: a.price, osc: oscAt(a.index) },
          to: { t: b.t, price: b.price, osc: oscAt(b.index) },
          barsAgo: window.length - 1 - b.index,
        };
      }
    }
    return null;
  };

  return {
    bullish: findPair(lows, (b, a) => b < a, (b, a) => b > a, 'bullish'),
    bearish: findPair(highs, (b, a) => b > a, (b, a) => b < a, 'bearish'),
  };
}
