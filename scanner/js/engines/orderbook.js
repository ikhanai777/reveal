// Order book analytics: cumulative imbalance, liquidity walls, and the
// persistence test that separates a real resting wall from a spoof.

import { topOfBook } from '../ingest/normalize.js';
import { mean, stdev } from '../core/num.js';

/**
 * Order Book Imbalance over the top `depth` levels.
 * obi in [-1,1]: +1 means every unit of displayed size is on the bid.
 */
export function orderBookImbalance(book, depth = 20) {
  const bids = (book.bids || []).slice(0, depth);
  const asks = (book.asks || []).slice(0, depth);
  const bidVol = bids.reduce((a, l) => a + l[1], 0);
  const askVol = asks.reduce((a, l) => a + l[1], 0);
  const total = bidVol + askVol;
  const { mid } = topOfBook(book);

  // Weight by proximity: size 20 levels away supports price far less than size
  // at the touch.
  const wSum = (levels) => levels.reduce((a, l) => {
    const dist = Math.abs(l[0] - mid) / (mid || 1);
    return a + l[1] * Math.exp(-dist * 400);
  }, 0);
  const wBid = wSum(bids), wAsk = wSum(asks);
  const wTotal = wBid + wAsk;

  return {
    bidVol, askVol,
    obi: total ? (bidVol - askVol) / total : 0,
    weightedObi: wTotal ? (wBid - wAsk) / wTotal : 0,
    depth,
    ...topOfBook(book),
  };
}

/** Levels whose size exceeds `sigma` standard deviations of the visible book. */
export function liquidityWalls(book, { depth = 40, sigma = 2.5 } = {}) {
  const levels = [
    ...(book.bids || []).slice(0, depth).map((l) => ({ price: l[0], size: l[1], side: 'bid' })),
    ...(book.asks || []).slice(0, depth).map((l) => ({ price: l[0], size: l[1], side: 'ask' })),
  ];
  if (levels.length < 6) return [];
  const sizes = levels.map((l) => l.size);
  const m = mean(sizes);
  const sd = stdev(sizes);
  if (sd === 0) return [];
  const { mid } = topOfBook(book);
  return levels
    .filter((l) => l.size > m + sigma * sd)
    .map((l) => ({ ...l, zScore: (l.size - m) / sd, distancePct: ((l.price - mid) / mid) * 100 }))
    .sort((a, b) => b.zScore - a.zScore);
}

/**
 * Tracks walls across snapshots. A wall that appears and vanishes without
 * price reaching it is flagged as spoofing; one that survives repeated tests
 * counts as genuine absorption.
 */
export class WallTracker {
  constructor({ ttlMs = 60_000, spoofMs = 4_000, wallOpts = {} } = {}) {
    this.ttlMs = ttlMs;
    this.spoofMs = spoofMs;
    this.wallOpts = wallOpts;
    this.walls = new Map(); // `${side}@${price}` -> record
    this.spoofEvents = [];
  }

  update(book, ts = book.ts || Date.now()) {
    const seen = new Set();
    const { mid } = topOfBook(book);
    for (const w of liquidityWalls(book, this.wallOpts)) {
      const key = `${w.side}@${w.price}`;
      seen.add(key);
      const rec = this.walls.get(key);
      if (rec) {
        rec.lastSeen = ts;
        rec.maxSize = Math.max(rec.maxSize, w.size);
        rec.sightings++;
        rec.touched = rec.touched || (w.side === 'bid' ? mid <= w.price * 1.0002 : mid >= w.price * 0.9998);
      } else {
        this.walls.set(key, {
          ...w, firstSeen: ts, lastSeen: ts, maxSize: w.size, sightings: 1, touched: false,
        });
      }
    }
    for (const [key, rec] of [...this.walls]) {
      if (seen.has(key)) continue;
      const lived = rec.lastSeen - rec.firstSeen;
      if (ts - rec.lastSeen > 1500) {
        // Pulled without ever being tested: the classic spoof shape.
        if (!rec.touched && lived < this.spoofMs && rec.sightings > 1) {
          this.spoofEvents.push({ ...rec, pulledAt: ts, livedMs: lived });
          if (this.spoofEvents.length > 200) this.spoofEvents.shift();
        }
        this.walls.delete(key);
      } else if (ts - rec.lastSeen > this.ttlMs) {
        this.walls.delete(key);
      }
    }
    return this.active();
  }

  active() {
    return [...this.walls.values()].sort((a, b) => b.zScore - a.zScore);
  }

  /** Walls that were tested and held — absorption worth scoring. */
  absorption() {
    return this.active().filter((w) => w.touched && w.sightings >= 3);
  }

  recentSpoofs(sinceMs = 60_000, now = Date.now()) {
    return this.spoofEvents.filter((e) => now - e.pulledAt <= sinceMs);
  }
}
