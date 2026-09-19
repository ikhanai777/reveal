// In-memory time-series rollups: one tick stream fans out into every
// timeframe the scanner tracks, so the 1s and 1d views are always consistent
// with each other and with the trades that produced them.

import { Ring } from '../core/series.js';
import { bucketStart, TIMEFRAMES } from '../core/timeframe.js';
import { makeCandle } from '../ingest/normalize.js';

export class CandleSeries {
  constructor(tf, capacity = 1500) {
    this.tf = tf;
    this.ring = new Ring(capacity);
    this.current = null;
  }

  /** Fold a trade in; returns the candle that just closed, if any. */
  addTrade(trade) {
    const open = bucketStart(trade.ts, this.tf);
    let closed = null;
    if (!this.current || this.current.t < open) {
      if (this.current) {
        this.current.closed = true;
        closed = this.current;
      }
      this.current = makeCandle(open, trade.price, this.tf);
      this.ring.push(this.current);
    } else if (this.current.t > open) {
      return null; // late print from a bucket already closed; drop it
    }
    const c = this.current;
    c.h = Math.max(c.h, trade.price);
    c.l = Math.min(c.l, trade.price);
    c.c = trade.price;
    c.v += trade.size;
    if (trade.side > 0) c.buyVol += trade.size; else c.sellVol += trade.size;
    c.trades++;
    return closed;
  }

  /** Seed from exchange history, oldest-first. Replaces overlapping bars. */
  seed(candles) {
    for (const c of candles) {
      const existing = this.ring.last;
      if (existing && existing.t === c.t) this.ring.replaceLast({ ...c, tf: this.tf });
      else this.ring.push({ ...c, tf: this.tf });
    }
    this.current = this.ring.last?.closed === false ? this.ring.last : null;
    return this;
  }

  /** Closed candles only — indicators must never read a forming bar. */
  closed(n) {
    const all = this.ring.tail();
    const done = all.filter((c) => c.closed);
    return n == null ? done : done.slice(-n);
  }

  get last() { return this.ring.last; }
  get lastClosed() {
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const c = this.ring.at(i);
      if (c.closed) return c;
    }
    return undefined;
  }
}

/** All timeframes for one symbol, driven by a single trade stream. */
export class MultiTimeframe {
  constructor({ symbol, timeframes = TIMEFRAMES, capacity = 1500 }) {
    this.symbol = symbol;
    this.series = new Map(timeframes.map((tf) => [tf, new CandleSeries(tf, capacity)]));
  }

  addTrade(trade) {
    const closures = [];
    for (const [tf, s] of this.series) {
      const closed = s.addTrade(trade);
      if (closed) closures.push({ tf, candle: closed });
    }
    return closures;
  }

  get(tf) { return this.series.get(tf); }

  seed(tf, candles) {
    if (!this.series.has(tf)) this.series.set(tf, new CandleSeries(tf));
    return this.series.get(tf).seed(candles);
  }
}
