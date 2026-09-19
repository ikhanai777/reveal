// Deterministic synthetic venue.
// Used for offline demos, for CI, and as the fixture generator for backtests
// when a run has no network access. It emits the same normalized events as a
// real adapter, so nothing downstream can tell the difference.

import { makeTrade } from './normalize.js';
import { TOPIC } from '../core/bus.js';
import { rng } from '../core/num.js';

/** Box-Muller normal draw from a uniform PRNG. */
function normal(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Regime-switching price path: trending legs punctuated by mean-reverting
 * chop, with volume clustering so order-flow engines see realistic bursts.
 */
export class SyntheticFeed {
  /**
   * Volatility and reversion are specified per BAR, not per print, and scaled
   * down by `printsPerBar`. A generator parameterized per print produces wildly
   * different bars depending on how finely it is sampled — seeded history at 40
   * prints a bar and a live feed at 1,800 would disagree by a factor of seven,
   * which shows up as a cliff in the middle of the chart.
   */
  constructor({
    bus, symbol = 'BTC/USDT', venue = 'synthetic',
    startPrice = 64_000, tickSize = 0.5, seed = 7,
    tradesPerSecond = 6, printsPerBar = 40,
    barVolatilityBps = 15, reversionBars = 60,
    volatilityBps,
  } = {}) {
    this.bus = bus;
    this.symbol = symbol;
    this.venue = venue;
    this.tickSize = tickSize;
    this.rand = rng(seed);
    this.price = startPrice;
    // A pure random walk over hundreds of thousands of prints wanders orders of
    // magnitude away from where it started, which makes every percentage-based
    // engine read nonsense. An Ornstein-Uhlenbeck pull toward the anchor keeps
    // the level plausible. The rate matters: revert within a dozen bars and the
    // forecaster correctly learns it, then votes against every trend the TA
    // engine sees. A 60-bar half-life leaves bar-scale structure untouched.
    this.anchor = startPrice;
    this.printsPerBar = Math.max(1, printsPerBar);
    this.kappa = Math.LN2 / (reversionBars * this.printsPerBar);
    this.drift = 0;
    this.regimeLeft = 0;
    this.tradesPerSecond = tradesPerSecond;
    // Per-print volatility that composes to `barVolatilityBps` over a bar.
    this.volatilityBps = volatilityBps ?? barVolatilityBps / Math.sqrt(this.printsPerBar);
    this.timer = null;
    this.oi = 120_000;
    this.funding = 0.0001;
  }

  rollRegime() {
    const r = this.rand();
    // 45% trend, 40% chop, 15% squeeze leg.
    this.drift = r < 0.45 ? (this.rand() < 0.5 ? -1 : 1) * (0.4 + this.rand())
      : r < 0.85 ? 0
      : (this.rand() < 0.5 ? -1 : 1) * (2 + this.rand() * 2);
    // Regimes last 5-25 bars, expressed in prints so the sampling rate does
    // not change how long a trend runs in market time.
    this.regimeLeft = Math.floor((5 + this.rand() * 20) * this.printsPerBar);
  }

  /** One trade print. Returns the normalized trade without emitting it. */
  nextTrade(ts) {
    if (this.regimeLeft-- <= 0) this.rollRegime();
    const vol = (this.volatilityBps / 10_000) * this.price;
    const revert = -this.kappa * Math.log(this.price / this.anchor) * this.price;
    // Drift is deterministic, so it accumulates linearly in the print count
    // while the random part accumulates in its square root. Dividing by another
    // sqrt(printsPerBar) keeps the drift-per-bar independent of sampling too.
    const drift = (this.drift * vol) / (6 * Math.sqrt(this.printsPerBar));
    const step = normal(this.rand) * vol + drift + revert;
    this.price = Math.max(this.tickSize, this.price + step);
    const price = Math.round(this.price / this.tickSize) * this.tickSize;
    // Volume clusters: a fat tail on roughly one print in twenty.
    const burst = this.rand() < 0.05 ? 8 + this.rand() * 25 : 0;
    const size = +(0.02 + this.rand() * 0.9 + burst).toFixed(4);
    // Aggressor leans with the drift, which is what makes CVD track price.
    const bias = 0.5 + Math.max(-0.35, Math.min(0.35, this.drift * 0.12));
    const side = this.rand() < bias ? 1 : -1;
    return makeTrade({ venue: this.venue, symbol: this.symbol, ts, price, size, side });
  }

  /** Synthetic L2: exponentially decaying depth with occasional walls. */
  bookAt(ts, depth = 20) {
    const bids = [], asks = [];
    const mid = this.price;
    for (let i = 1; i <= depth; i++) {
      const wall = this.rand() < 0.04 ? 25 + this.rand() * 90 : 0;
      const base = (6 + this.rand() * 4) * Math.exp(-i / 9);
      bids.push([+(mid - i * this.tickSize).toFixed(4), +(base + wall).toFixed(3)]);
      const wall2 = this.rand() < 0.04 ? 25 + this.rand() * 90 : 0;
      const base2 = (6 + this.rand() * 4) * Math.exp(-i / 9);
      asks.push([+(mid + i * this.tickSize).toFixed(4), +(base2 + wall2).toFixed(3)]);
    }
    return { venue: this.venue, symbol: this.symbol, ts, bids, asks };
  }

  /** Emit `ms` of simulated market time as fast as the caller can take it. */
  burst(ms, fromTs = Date.now() - ms) {
    const n = Math.max(1, Math.round((ms / 1000) * this.tradesPerSecond));
    const dt = ms / n;
    for (let i = 0; i < n; i++) {
      const ts = Math.round(fromTs + i * dt);
      this.bus.emit(TOPIC.trade, this.nextTrade(ts));
      if (i % 10 === 0) this.bus.emit(TOPIC.book, this.bookAt(ts));
    }
  }

  start({ intervalMs = 250 } = {}) {
    this.stop();
    this.timer = setInterval(() => {
      const now = Date.now();
      const n = Math.max(1, Math.round((intervalMs / 1000) * this.tradesPerSecond));
      for (let i = 0; i < n; i++) this.bus.emit(TOPIC.trade, this.nextTrade(now));
      this.bus.emit(TOPIC.book, this.bookAt(now));
      // Funding drifts with the trend and decays back toward the 0.01% baseline.
      // Real 8h funding lives within roughly +/-10bps; without the decay this
      // pins at the clamp and every symbol reads "extreme" forever.
      const baseline = 0.0001;
      this.funding += (this.drift * 0.0000015) + (this.rand() - 0.5) * 0.000002;
      this.funding += (baseline - this.funding) * 0.01;
      this.funding = Math.max(-0.001, Math.min(0.001, this.funding));
      this.oi *= 1 + (this.drift !== 0 ? 0.0006 : -0.0002) + (this.rand() - 0.5) * 0.001;
      this.bus.emit(TOPIC.funding, { symbol: this.symbol, ts: now, rate: this.funding, markPrice: this.price });
      this.bus.emit(TOPIC.openInterest, { symbol: this.symbol, ts: now, oi: this.oi });
    }, intervalMs);
    this.bus.emit(TOPIC.status, { name: this.venue, state: 'open', detail: 'simulated feed', ts: Date.now() });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/** Build a deterministic OHLCV history, oldest-first, for offline backtests. */
export function syntheticCandles({ bars = 2000, tf = '5m', tfMsValue = 300_000, seed = 11, startPrice = 64_000, startTs, prints = 40 } = {}) {
  const feed = new SyntheticFeed({ bus: { emit() {} }, seed, startPrice, printsPerBar: prints });
  const t0 = startTs ?? Date.now() - bars * tfMsValue;
  const out = [];
  for (let i = 0; i < bars; i++) {
    const t = t0 + i * tfMsValue;
    let o = null, h = -Infinity, l = Infinity, c = null, v = 0, buy = 0, sell = 0;
    for (let j = 0; j < prints; j++) {
      const tr = feed.nextTrade(t + (j * tfMsValue) / prints);
      if (o == null) o = tr.price;
      h = Math.max(h, tr.price);
      l = Math.min(l, tr.price);
      c = tr.price;
      v += tr.size;
      if (tr.side > 0) buy += tr.size; else sell += tr.size;
    }
    out.push({ t, tf, o, h, l, c, v, buyVol: buy, sellVol: sell, trades: prints, closed: true });
  }
  return out;
}
