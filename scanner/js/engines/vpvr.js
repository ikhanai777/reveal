// Volume Profile (VPVR): POC, Value Area High/Low and the high/low volume
// nodes used as take-profit targets.
//
// Value area follows the standard expansion rule: start at the POC, repeatedly
// annex whichever adjacent row (or pair of rows) holds more volume, until the
// accumulated volume covers `valueAreaPct` of the profile.

import { roundToStep } from '../core/num.js';

/**
 * Build a profile from candles. Without a tick ladder, each candle's volume is
 * distributed uniformly across the rows it spans, which is the standard
 * approximation for candle-sourced profiles.
 */
export function volumeProfile(candles, { rows = 60, valueAreaPct = 0.7, useFootprint = null } = {}) {
  if (!candles.length) return emptyProfile();
  const hi = Math.max(...candles.map((c) => c.h));
  const lo = Math.min(...candles.map((c) => c.l));
  if (!(hi > lo)) return emptyProfile();

  const step = (hi - lo) / rows;
  const bins = new Array(rows).fill(0);
  const buy = new Array(rows).fill(0);
  const sell = new Array(rows).fill(0);

  const binOf = (price) => Math.min(rows - 1, Math.max(0, Math.floor((price - lo) / step)));

  if (useFootprint) {
    // Exact distribution when real per-price volume is available.
    for (const fp of useFootprint) {
      for (const [price, lvl] of fp.levels) {
        const b = binOf(price);
        bins[b] += lvl.bid + lvl.ask;
        buy[b] += lvl.ask;
        sell[b] += lvl.bid;
      }
    }
  } else {
    for (const c of candles) {
      const a = binOf(c.l), z = binOf(c.h);
      const span = z - a + 1;
      const per = (c.v ?? 0) / span;
      const perBuy = (c.buyVol ?? 0) / span;
      const perSell = (c.sellVol ?? 0) / span;
      for (let i = a; i <= z; i++) { bins[i] += per; buy[i] += perBuy; sell[i] += perSell; }
    }
  }

  const total = bins.reduce((a, b) => a + b, 0);
  if (total <= 0) return emptyProfile();

  let pocIdx = 0;
  for (let i = 1; i < rows; i++) if (bins[i] > bins[pocIdx]) pocIdx = i;

  // Expand outward from the POC until the value area target is covered.
  let lower = pocIdx, upper = pocIdx, acc = bins[pocIdx];
  const target = total * valueAreaPct;
  while (acc < target && (lower > 0 || upper < rows - 1)) {
    const below = lower > 0 ? bins[lower - 1] : -1;
    const above = upper < rows - 1 ? bins[upper + 1] : -1;
    if (above >= below) { upper++; acc += bins[upper]; }
    else { lower--; acc += bins[lower]; }
  }

  const priceOf = (i) => lo + (i + 0.5) * step;
  const profile = bins.map((v, i) => ({
    price: priceOf(i), volume: v, buy: buy[i], sell: sell[i],
    share: v / total, inValueArea: i >= lower && i <= upper,
  }));

  return {
    rows: profile,
    poc: priceOf(pocIdx),
    pocVolume: bins[pocIdx],
    vah: priceOf(upper),
    val: priceOf(lower),
    high: hi,
    low: lo,
    step,
    total,
    valueAreaVolume: acc,
    hvns: nodes(profile, 'high'),
    lvns: nodes(profile, 'low'),
  };
}

function emptyProfile() {
  return { rows: [], poc: NaN, pocVolume: 0, vah: NaN, val: NaN, high: NaN, low: NaN, step: 0, total: 0, valueAreaVolume: 0, hvns: [], lvns: [] };
}

/** Local maxima (HVN) / minima (LVN) of the profile, strongest first. */
function nodes(profile, kind) {
  const out = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const a = profile[i - 1].volume, b = profile[i].volume, c = profile[i + 1].volume;
    if (kind === 'high' ? b > a && b > c : b < a && b < c) out.push(profile[i]);
  }
  out.sort((x, y) => (kind === 'high' ? y.volume - x.volume : x.volume - y.volume));
  return out.slice(0, 8);
}

/** Nearest volume node strictly above/below `price` — the TP2 target rule. */
export function nextNode(profile, price, dir) {
  const candidates = [...profile.hvns, { price: profile.poc, volume: profile.pocVolume }, { price: profile.vah }, { price: profile.val }]
    .filter((n) => Number.isFinite(n.price))
    .filter((n) => (dir > 0 ? n.price > price : n.price < price));
  if (!candidates.length) return null;
  candidates.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  return candidates[0];
}

/** Where price sits relative to value: 'above' | 'inside' | 'below'. */
export function valueLocation(profile, price) {
  if (!Number.isFinite(profile.vah)) return 'unknown';
  if (price > profile.vah) return 'above';
  if (price < profile.val) return 'below';
  return 'inside';
}

/** Session-anchored profile that rebuilds when the UTC day rolls. */
export class SessionProfile {
  constructor({ rows = 60, tickSize = 0.5 } = {}) {
    this.rows = rows;
    this.tickSize = tickSize;
    this.day = null;
    this.levels = new Map();
  }

  addTrade(trade) {
    const day = Math.floor(trade.ts / 86_400_000);
    if (this.day !== day) { this.day = day; this.levels.clear(); }
    const p = roundToStep(trade.price, this.tickSize);
    this.levels.set(p, (this.levels.get(p) || 0) + trade.size);
  }

  compute(valueAreaPct = 0.7) {
    const entries = [...this.levels.entries()].sort((a, b) => a[0] - b[0]);
    if (!entries.length) return emptyProfile();
    const total = entries.reduce((a, [, v]) => a + v, 0);
    let pocIdx = 0;
    for (let i = 1; i < entries.length; i++) if (entries[i][1] > entries[pocIdx][1]) pocIdx = i;
    let lo = pocIdx, hi = pocIdx, acc = entries[pocIdx][1];
    const target = total * valueAreaPct;
    while (acc < target && (lo > 0 || hi < entries.length - 1)) {
      const below = lo > 0 ? entries[lo - 1][1] : -1;
      const above = hi < entries.length - 1 ? entries[hi + 1][1] : -1;
      if (above >= below) { hi++; acc += entries[hi][1]; } else { lo--; acc += entries[lo][1]; }
    }
    return {
      rows: entries.map(([price, volume]) => ({ price, volume, share: volume / total })),
      poc: entries[pocIdx][0],
      pocVolume: entries[pocIdx][1],
      vah: entries[hi][0],
      val: entries[lo][0],
      high: entries[entries.length - 1][0],
      low: entries[0][0],
      total,
      valueAreaVolume: acc,
      step: this.tickSize,
      hvns: [], lvns: [],
    };
  }
}
