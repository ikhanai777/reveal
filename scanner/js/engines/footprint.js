// Footprint aggregation: per-candle bid/ask volume ladders, candle delta, and
// diagonal imbalance stacks.
//
// Diagonal convention (the standard one): at price P the ask (aggressive buy)
// volume is compared against the bid (aggressive sell) volume one tick BELOW,
// because those are the two orders that could have traded with each other.

import { roundToStep } from '../core/num.js';
import { bucketStart } from '../core/timeframe.js';

export class FootprintCandle {
  constructor(t, tf, tickSize) {
    this.t = t;
    this.tf = tf;
    this.tickSize = tickSize;
    this.levels = new Map();  // price -> { bid, ask }
    this.buyVol = 0;
    this.sellVol = 0;
    this.trades = 0;
    this.o = null; this.h = -Infinity; this.l = Infinity; this.c = null;
    this.closed = false;
  }

  add(trade) {
    const price = roundToStep(trade.price, this.tickSize);
    let lvl = this.levels.get(price);
    if (!lvl) { lvl = { bid: 0, ask: 0 }; this.levels.set(price, lvl); }
    if (trade.side > 0) { lvl.ask += trade.size; this.buyVol += trade.size; }
    else { lvl.bid += trade.size; this.sellVol += trade.size; }
    if (this.o == null) this.o = trade.price;
    this.h = Math.max(this.h, trade.price);
    this.l = Math.min(this.l, trade.price);
    this.c = trade.price;
    this.trades++;
  }

  get delta() { return this.buyVol - this.sellVol; }
  get volume() { return this.buyVol + this.sellVol; }
  /** Delta as a share of volume: -1 (all selling) .. +1 (all buying). */
  get deltaPct() { return this.volume ? this.delta / this.volume : 0; }

  /** Price levels, highest first, as the UI renders a footprint column. */
  ladder() {
    return [...this.levels.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([price, l]) => ({ price, bid: l.bid, ask: l.ask, delta: l.ask - l.bid, total: l.bid + l.ask }));
  }

  /**
   * Diagonal imbalances above `ratio`. `minVolume` suppresses the noise from
   * one-lot prints at the extremes of the candle.
   */
  imbalances({ ratio = 3, minVolume = 0 } = {}) {
    const rows = this.ladder();
    const byPrice = new Map(rows.map((r) => [r.price, r]));
    const out = [];
    for (const r of rows) {
      const below = byPrice.get(roundToStep(r.price - this.tickSize, this.tickSize));
      if (!below) continue;
      const askHere = r.ask;       // buyers lifting the offer at this price
      const bidBelow = below.bid;  // sellers hitting the bid one tick down
      if (askHere >= minVolume && bidBelow * ratio <= askHere && askHere > 0) {
        out.push({ price: r.price, dir: 1, ratio: bidBelow === 0 ? Infinity : askHere / bidBelow, ask: askHere, bid: bidBelow });
      } else if (bidBelow >= minVolume && askHere * ratio <= bidBelow && bidBelow > 0) {
        out.push({ price: below.price, dir: -1, ratio: askHere === 0 ? Infinity : bidBelow / askHere, ask: askHere, bid: bidBelow });
      }
    }
    return out;
  }

  /**
   * A stack is `minRun` consecutive same-direction imbalances — the signature
   * of real absorption rather than a single opportunistic sweep.
   */
  imbalanceStacks({ ratio = 3, minRun = 3, minVolume = 0 } = {}) {
    const imb = this.imbalances({ ratio, minVolume });
    const stacks = [];
    let run = [];
    for (let i = 0; i < imb.length; i++) {
      const prev = run[run.length - 1];
      const contiguous = prev
        && imb[i].dir === prev.dir
        && Math.abs(roundToStep(prev.price - imb[i].price, this.tickSize)) <= this.tickSize * 1.5;
      if (contiguous) run.push(imb[i]);
      else { if (run.length >= minRun) stacks.push(summarizeStack(run)); run = [imb[i]]; }
    }
    if (run.length >= minRun) stacks.push(summarizeStack(run));
    return stacks;
  }

  /** Price level holding the most traded volume inside this candle. */
  pointOfControl() {
    let best = null;
    for (const [price, l] of this.levels) {
      const total = l.bid + l.ask;
      if (!best || total > best.volume) best = { price, volume: total };
    }
    return best;
  }
}

function summarizeStack(run) {
  const prices = run.map((r) => r.price);
  return {
    dir: run[0].dir,
    size: run.length,
    low: Math.min(...prices),
    high: Math.max(...prices),
    volume: run.reduce((a, r) => a + r.ask + r.bid, 0),
  };
}

/** Rolling footprint builder for one symbol at one timeframe. */
export class FootprintAggregator {
  constructor({ tf = '1m', tickSize = 0.5, keep = 120 } = {}) {
    this.tf = tf;
    this.tickSize = tickSize;
    this.keep = keep;
    this.candles = [];
    this.current = null;
  }

  addTrade(trade) {
    const t = bucketStart(trade.ts, this.tf);
    let closed = null;
    if (!this.current || this.current.t < t) {
      if (this.current) { this.current.closed = true; closed = this.current; }
      this.current = new FootprintCandle(t, this.tf, this.tickSize);
      this.candles.push(this.current);
      if (this.candles.length > this.keep) this.candles.shift();
    } else if (this.current.t > t) {
      return null;
    }
    this.current.add(trade);
    return closed;
  }

  /**
   * Retune the price ladder. A raw exchange tick size gives hundreds of rows
   * per candle on a liquid instrument, which is unreadable and pointless to
   * aggregate; the scanner rebuckets to roughly a dozen rows per candle once
   * it knows the instrument's ATR. Existing candles keep the size they were
   * built with, so history stays internally consistent.
   */
  setTickSize(size) {
    if (!(size > 0) || size === this.tickSize) return false;
    // Ignore jitter: only rebucket on a real change of scale.
    if (size / this.tickSize > 0.5 && size / this.tickSize < 2) return false;
    this.tickSize = size;
    this.current = null;
    return true;
  }

  recent(n = 30) { return this.candles.slice(-n); }
  get last() { return this.candles[this.candles.length - 1]; }
}
