// Footprint (volume-at-price) bar model.
//
// A footprint bar is an OHLC candle plus, for every price row inside it, the
// volume that traded into the bid versus into the ask. Everything downstream —
// imbalances, value area, delta, the signal rules — is derived from that split.
//
// Trade classification uses Binance's `m` flag ("buyer was the maker"):
//   m === true  -> the aggressor was a seller -> volume hits the BID
//   m === false -> the aggressor was a buyer  -> volume hits the ASK

import { bucketStart } from './util.js';

export const DEFAULT_FOOTPRINT_CONFIG = {
  rowTicks: 1,            // price rows per footprint row, in exchange ticks
  imbalanceRatio: 3,      // diagonal ask/bid ratio that counts as an imbalance
  imbalanceMinVol: 0,     // absolute volume floor so dust rows cannot imbalance
  stackLength: 3,         // consecutive imbalanced rows that make a "stack"
  valueAreaPct: 0.7,      // share of bar volume inside the value area
};

export class FootprintBar {
  constructor(openTime, closeTime, tickSize, rowTicks) {
    this.openTime = openTime;
    this.closeTime = closeTime;      // exclusive
    this.tickSize = tickSize;
    this.rowTicks = rowTicks;
    this.rowSize = tickSize * rowTicks;

    this.open = NaN;
    this.high = -Infinity;
    this.low = Infinity;
    this.close = NaN;

    this.volume = 0;
    this.bidVolume = 0;              // aggressive selling
    this.askVolume = 0;              // aggressive buying
    this.trades = 0;
    this.quoteVolume = 0;

    /** @type {Map<number, {bid:number, ask:number, bidTrades:number, askTrades:number}>} */
    this.rows = new Map();

    this.runningDelta = 0;
    this.minDelta = 0;               // delta excursions inside the bar
    this.maxDelta = 0;

    this.closed = false;
    this.cumDelta = 0;               // filled in by the builder across bars
    this.cumDeltaOpen = 0;
    this.index = -1;
  }

  get delta() { return this.askVolume - this.bidVolume; }
  get deltaPct() { return this.volume > 0 ? this.delta / this.volume : 0; }
  get range() { return this.high - this.low; }

  /** 0 = closed on the low, 1 = closed on the high. */
  get closeLocation() {
    const r = this.range;
    if (!(r > 0)) return 0.5;
    return (this.close - this.low) / r;
  }

  rowIndexFor(price) {
    return Math.floor(Math.round(price / this.tickSize) / this.rowTicks);
  }

  rowLowPrice(rowIndex) { return rowIndex * this.rowSize; }
  rowMidPrice(rowIndex) { return (rowIndex + 0.5) * this.rowSize; }

  row(rowIndex) {
    let r = this.rows.get(rowIndex);
    if (!r) {
      r = { bid: 0, ask: 0, bidTrades: 0, askTrades: 0 };
      this.rows.set(rowIndex, r);
    }
    return r;
  }

  addTrade(t) {
    const price = t.p;
    const qty = t.q;
    if (!(qty > 0)) return;

    if (Number.isNaN(this.open)) this.open = price;
    this.close = price;
    if (price > this.high) this.high = price;
    if (price < this.low) this.low = price;

    this.volume += qty;
    this.quoteVolume += qty * price;
    this.trades += 1;

    const r = this.row(this.rowIndexFor(price));
    if (t.m) {
      this.bidVolume += qty;
      r.bid += qty;
      r.bidTrades += 1;
      this.runningDelta -= qty;
    } else {
      this.askVolume += qty;
      r.ask += qty;
      r.askTrades += 1;
      this.runningDelta += qty;
    }
    if (this.runningDelta > this.maxDelta) this.maxDelta = this.runningDelta;
    if (this.runningDelta < this.minDelta) this.minDelta = this.runningDelta;
  }

  /**
   * Compute POC, value area, imbalances and stacks. Safe to call repeatedly —
   * the live bar is re-finalised on every tick.
   */
  finalize(config) {
    const cfg = { ...DEFAULT_FOOTPRINT_CONFIG, ...config };
    const indices = [...this.rows.keys()].sort((a, b) => a - b);
    this.rowIndices = indices;
    this.lowRow = indices[0] ?? 0;
    this.highRow = indices[indices.length - 1] ?? 0;

    let pocRow = indices[0] ?? 0;
    let pocVol = -1;
    let maxRowVol = 0;
    for (const i of indices) {
      const r = this.rows.get(i);
      const v = r.bid + r.ask;
      if (v > pocVol) { pocVol = v; pocRow = i; }
      if (v > maxRowVol) maxRowVol = v;
    }
    this.pocRow = pocRow;
    this.pocPrice = this.rowMidPrice(pocRow);
    this.pocVolume = Math.max(0, pocVol);
    this.maxRowVolume = maxRowVol;

    // --- Value area: grow out from the POC, always taking the heavier side.
    const target = this.volume * cfg.valueAreaPct;
    const volAt = (i) => {
      const r = this.rows.get(i);
      return r ? r.bid + r.ask : 0;
    };
    let lo = pocRow;
    let hi = pocRow;
    let acc = volAt(pocRow);
    while (acc < target && (lo > this.lowRow || hi < this.highRow)) {
      const upPair = (hi + 1 <= this.highRow ? volAt(hi + 1) : 0) + (hi + 2 <= this.highRow ? volAt(hi + 2) : 0);
      const downPair = (lo - 1 >= this.lowRow ? volAt(lo - 1) : 0) + (lo - 2 >= this.lowRow ? volAt(lo - 2) : 0);
      if (upPair >= downPair && hi < this.highRow) {
        hi = Math.min(this.highRow, hi + 2);
        acc += upPair;
      } else if (lo > this.lowRow) {
        lo = Math.max(this.lowRow, lo - 2);
        acc += downPair;
      } else if (hi < this.highRow) {
        hi = Math.min(this.highRow, hi + 2);
        acc += upPair;
      } else break;
    }
    this.valRow = lo;
    this.vahRow = hi;
    this.valPrice = this.rowLowPrice(lo);
    this.vahPrice = this.rowLowPrice(hi + 1);

    // --- Diagonal imbalances: ask at row N against bid at row N-1.
    const imb = new Map();
    const ratio = cfg.imbalanceRatio;
    const minVol = cfg.imbalanceMinVol;
    for (let i = this.lowRow + 1; i <= this.highRow; i++) {
      const upper = this.rows.get(i);
      const lower = this.rows.get(i - 1);
      const ask = upper?.ask ?? 0;
      const bid = lower?.bid ?? 0;
      if (ask >= minVol && ask > 0 && ask >= ratio * Math.max(bid, 1e-12)) {
        const e = imb.get(i) || { buy: false, sell: false };
        e.buy = true;
        imb.set(i, e);
      }
      if (bid >= minVol && bid > 0 && bid >= ratio * Math.max(ask, 1e-12)) {
        const e = imb.get(i - 1) || { buy: false, sell: false };
        e.sell = true;
        imb.set(i - 1, e);
      }
    }
    this.imbalances = imb;

    // --- Stacked imbalances: runs of >= stackLength consecutive rows.
    const stacks = [];
    for (const side of ['buy', 'sell']) {
      let runStart = null;
      let prev = null;
      for (let i = this.lowRow; i <= this.highRow + 1; i++) {
        const on = i <= this.highRow && !!imb.get(i)?.[side];
        if (on && runStart === null) runStart = i;
        if (on) prev = i;
        if (!on && runStart !== null) {
          const count = prev - runStart + 1;
          if (count >= cfg.stackLength) {
            stacks.push({
              side,
              fromRow: runStart,
              toRow: prev,
              count,
              fromPrice: this.rowLowPrice(runStart),
              toPrice: this.rowLowPrice(prev + 1),
            });
          }
          runStart = null;
        }
      }
    }
    this.stacks = stacks;
    this.buyStacks = stacks.filter((s) => s.side === 'buy');
    this.sellStacks = stacks.filter((s) => s.side === 'sell');

    // --- Extremes: volume parked in the top/bottom rows, used by the
    // absorption and exhaustion rules.
    this.lowRowVolume = volAt(this.lowRow);
    this.highRowVolume = volAt(this.highRow);
    this.lowRowBid = this.rows.get(this.lowRow)?.bid ?? 0;
    this.lowRowAsk = this.rows.get(this.lowRow)?.ask ?? 0;
    this.highRowBid = this.rows.get(this.highRow)?.bid ?? 0;
    this.highRowAsk = this.rows.get(this.highRow)?.ask ?? 0;
    this.rowCount = indices.length;
    this.avgRowVolume = indices.length ? this.volume / indices.length : 0;

    return this;
  }
}

/**
 * Turns a stream of trades into finalised footprint bars.
 * Trades must arrive in ascending time order (both REST backfill and the
 * websocket satisfy that).
 */
export class FootprintBuilder {
  constructor({ tickSize, intervalMs, config = {} } = {}) {
    this.tickSize = tickSize;
    this.intervalMs = intervalMs;
    this.config = { ...DEFAULT_FOOTPRINT_CONFIG, ...config };
    /** @type {FootprintBar[]} */
    this.bars = [];
    this.current = null;
    this.cumDelta = 0;
    this.onBarClose = null;
  }

  _startBar(openTime) {
    const bar = new FootprintBar(openTime, openTime + this.intervalMs, this.tickSize, this.config.rowTicks);
    bar.index = this.bars.length;
    bar.cumDeltaOpen = this.cumDelta;
    this.bars.push(bar);
    this.current = bar;
    return bar;
  }

  _closeCurrent() {
    const bar = this.current;
    if (!bar) return;
    bar.finalize(this.config);
    bar.closed = true;
    this.cumDelta = bar.cumDeltaOpen + bar.delta;
    bar.cumDelta = this.cumDelta;
    this.current = null;
    if (this.onBarClose) this.onBarClose(bar);
  }

  addTrade(t) {
    const open = bucketStart(t.T, this.intervalMs);
    if (this.current && open >= this.current.closeTime) this._closeCurrent();
    if (!this.current) this._startBar(open);
    else if (open < this.current.openTime) return; // out-of-order straggler
    this.current.addTrade(t);
    this.current.cumDelta = this.current.cumDeltaOpen + this.current.delta;
  }

  addTrades(list) {
    for (const t of list) this.addTrade(t);
  }

  /** Finalise the in-progress bar without closing it (for live rendering). */
  refreshCurrent() {
    if (this.current) this.current.finalize(this.config);
  }

  /** Close the trailing bar — call once a backfill has finished. */
  flush() {
    this._closeCurrent();
    return this.bars;
  }

  /** Recompute every bar against new footprint settings, without refetching. */
  rebuildConfig(config) {
    this.config = { ...this.config, ...config };
    for (const bar of this.bars) {
      bar.rowTicks = this.config.rowTicks;
      bar.rowSize = bar.tickSize * bar.rowTicks;
    }
    return this.bars;
  }
}

/**
 * Rebuilds bars from a flat trade array. Used when the interval or row size
 * changes: the trades are already local, so nothing is refetched.
 */
export function buildBars(trades, { tickSize, intervalMs, config }) {
  const b = new FootprintBuilder({ tickSize, intervalMs, config });
  b.addTrades(trades);
  return b.flush();
}

/**
 * Picks a row size that gives a typical bar roughly `targetRows` rows.
 *
 * One exchange tick per row is unusable on a high-priced instrument — BTCUSDT
 * moves hundreds of $0.10 ticks in a five-minute bar, which renders as a few
 * hundred sub-pixel rows. This measures the median bar range instead of
 * guessing from the price.
 */
export function suggestRowTicks(trades, { tickSize, intervalMs, targetRows = 14 }) {
  if (!trades.length || !(tickSize > 0)) return 1;
  const ranges = [];
  let bucket = bucketStart(trades[0].T, intervalMs);
  let hi = -Infinity;
  let lo = Infinity;
  for (const t of trades) {
    const b = bucketStart(t.T, intervalMs);
    if (b !== bucket) {
      if (hi > lo) ranges.push(hi - lo);
      bucket = b;
      hi = -Infinity;
      lo = Infinity;
    }
    if (t.p > hi) hi = t.p;
    if (t.p < lo) lo = t.p;
  }
  if (hi > lo) ranges.push(hi - lo);
  if (!ranges.length) return 1;

  ranges.sort((a, b) => a - b);
  const median = ranges[Math.floor(ranges.length / 2)];
  const ticks = median / tickSize;
  return Math.max(1, Math.round(ticks / targetRows));
}
