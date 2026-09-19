// Live scanning orchestration.
//
// One SymbolEngine per instrument owns that symbol's rollups, footprints, book
// state and derivative history, and recomputes the SCS on a throttle. The
// Scanner fans the bus out to the right engine and owns signal emission.

import { TOPIC } from './core/bus.js';
import { MultiTimeframe } from './engines/candles.js';
import { FootprintAggregator } from './engines/footprint.js';
import { WallTracker } from './engines/orderbook.js';
import { SessionProfile, volumeProfile } from './engines/vpvr.js';
import { scoreTechnicals } from './engines/ta.js';
import { scoreOrderFlow } from './engines/orderflow.js';
import { scoreDerivatives } from './engines/derivatives.js';
import { scoreSentiment, SentimentEngine } from './engines/sentiment.js';
import { Forecaster, scoreForecast } from './engines/forecast.js';
import { evaluate, DEFAULT_WEIGHTS } from './signal/scoring.js';
import { buildTradePlan, DEFAULT_RISK } from './signal/risk.js';
import { SignalTracker } from './signal/tracker.js';
import { niceStep } from './core/num.js';

export class SymbolEngine {
  constructor({ symbol, timeframe = '5m', tickSize = 0.5, timeframes }) {
    this.symbol = symbol;
    this.timeframe = timeframe;
    this.tickSize = tickSize;
    this.mtf = new MultiTimeframe({ symbol, timeframes });
    this.footprints = new FootprintAggregator({ tf: timeframe, tickSize });
    this.walls = new WallTracker();
    this.sessionProfile = new SessionProfile({ tickSize });
    this.forecaster = new Forecaster();
    this.book = null;
    this.funding = [];
    this.openInterest = [];
    this.onchain = {};
    this.lastTradeTs = 0;
    this.lastPrice = null;
    this.profile = null;
    this.profileStale = true;
    this.evaluation = null;
    this.lastEvaluatedBar = null;
  }

  onTrade(trade) {
    this.lastTradeTs = trade.ts;
    this.lastPrice = trade.price;
    this.sessionProfile.addTrade(trade);
    this.footprints.addTrade(trade);
    const closures = this.mtf.addTrade(trade);
    if (closures.length) this.profileStale = true;
    return closures;
  }

  onBook(book) {
    this.book = book;
    this.walls.update(book, book.ts);
  }

  onFunding(f) {
    this.funding.push({ ts: f.ts, rate: f.rate });
    if (this.funding.length > 500) this.funding.shift();
  }

  onOpenInterest(o) {
    this.openInterest.push({ ts: o.ts, oi: o.oi });
    if (this.openInterest.length > 500) this.openInterest.shift();
  }

  candles(tf = this.timeframe) { return this.mtf.get(tf)?.closed() ?? []; }

  /** Recompute every factor and the SCS. Returns null while warming up. */
  evaluateNow({ weights = DEFAULT_WEIGHTS, sentiment = null, filterCfg } = {}) {
    const candles = this.candles();
    if (candles.length < 60) {
      this.evaluation = null;
      return null;
    }
    if (this.profileStale || !this.profile) {
      this.profile = volumeProfile(candles.slice(-300), { rows: 60 });
      this.profileStale = false;
    }
    this.forecaster.observe(candles);

    const ta = scoreTechnicals(candles);
    // Aim for roughly a dozen readable rows per footprint candle.
    if (ta.context.atr > 0) {
      this.footprints.setTickSize(Math.max(this.tickSize, niceStep(ta.context.atr / 12)));
    }
    const of = scoreOrderFlow({
      candles,
      footprints: this.footprints.recent(6),
      book: this.book,
      wallTracker: this.walls,
      profile: this.profile,
    });
    const fa = scoreDerivatives({
      candles,
      fundingHistory: this.funding,
      oiHistory: this.openInterest,
      onchain: this.onchain,
    });
    const news = sentiment
      ? scoreSentiment(sentiment, this.symbol)
      : { score: 0, components: [], context: { ready: false, reason: 'no news feed configured' } };
    const ml = scoreForecast(this.forecaster.predict(candles));

    this.factors = { ta, orderFlow: of, derivatives: fa, news, ml };
    this.evaluation = evaluate(this.factors, { weights, filterCfg });
    this.evaluation.symbol = this.symbol;
    this.evaluation.timeframe = this.timeframe;
    this.evaluation.price = this.lastPrice ?? candles[candles.length - 1].c;
    this.evaluation.ts = Date.now();
    return this.evaluation;
  }

  buildPlan() {
    if (!this.evaluation?.actionable) return null;
    const ta = this.factors.ta;
    return buildTradePlan({
      direction: this.evaluation.classification.direction,
      price: this.evaluation.price,
      atr: ta.context.atr,
      profile: this.profile,
      structure: { swingHigh: ta.context.swingHigh, swingLow: ta.context.swingLow },
      fvgs: ta.context.fvgs || [],
      cfg: this.riskCfg || DEFAULT_RISK,
    });
  }
}

export class Scanner {
  constructor({
    bus, symbols = [], timeframe = '5m', tickSizes = {},
    weights = DEFAULT_WEIGHTS, riskCfg = DEFAULT_RISK, filterCfg,
    tracker = new SignalTracker(), sentiment = new SentimentEngine(),
    dispatcher = null, evaluateEveryMs = 3000,
    cooldownMs = 10 * 60_000,
  } = {}) {
    this.bus = bus;
    this.timeframe = timeframe;
    this.weights = weights;
    this.riskCfg = riskCfg;
    this.filterCfg = filterCfg;
    this.tracker = tracker;
    this.sentiment = sentiment;
    this.dispatcher = dispatcher;
    this.evaluateEveryMs = evaluateEveryMs;
    this.cooldownMs = cooldownMs;
    this.lastEmit = new Map();
    this.engines = new Map();
    this.timer = null;
    this.unsubs = [];
    for (const s of symbols) this.addSymbol(s, tickSizes[s]);
  }

  addSymbol(symbol, tickSize = 0.5) {
    const eng = new SymbolEngine({ symbol, timeframe: this.timeframe, tickSize });
    eng.riskCfg = this.riskCfg;
    this.engines.set(symbol, eng);
    return eng;
  }

  removeSymbol(symbol) { this.engines.delete(symbol); }

  engine(symbol) { return this.engines.get(symbol); }

  start() {
    this.unsubs.push(
      this.bus.on(TOPIC.trade, (t) => {
        const eng = this.engines.get(t.symbol);
        if (!eng) return;
        const closures = eng.onTrade(t);
        // Live signals track against the closing bar of the scanner timeframe.
        for (const c of closures) {
          if (c.tf === this.timeframe) this.tracker.updateSymbol(t.symbol, c.candle);
        }
      }),
      this.bus.on(TOPIC.book, (b) => this.engines.get(b.symbol)?.onBook(b)),
      this.bus.on(TOPIC.funding, (f) => this.engines.get(f.symbol)?.onFunding(f)),
      this.bus.on(TOPIC.openInterest, (o) => this.engines.get(o.symbol)?.onOpenInterest(o)),
      this.bus.on(TOPIC.news, (n) => this.sentiment.ingest(n)),
      this.bus.on(TOPIC.chain, (c) => {
        const eng = this.engines.get(c.symbol);
        if (eng) eng.onchain = { ...eng.onchain, ...c.metrics };
      }),
    );
    this.timer = setInterval(() => this.tick(), this.evaluateEveryMs);
    return this;
  }

  stop() {
    for (const off of this.unsubs.splice(0)) off();
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One scan pass across every tracked symbol. */
  tick() {
    const results = [];
    for (const [symbol, eng] of this.engines) {
      const ev = eng.evaluateNow({ weights: this.weights, sentiment: this.sentiment, filterCfg: this.filterCfg });
      if (!ev) continue;
      results.push(ev);
      this.bus.emit(TOPIC.score, ev);
      if (ev.actionable) this.maybeEmit(symbol, eng, ev);
    }
    return results;
  }

  maybeEmit(symbol, eng, evaluation) {
    const now = Date.now();
    const last = this.lastEmit.get(symbol) || 0;
    if (now - last < this.cooldownMs) return null;
    // One live signal per symbol at a time: stacking the same idea is not
    // diversification, it is leverage.
    if (this.tracker.live().some((s) => s.symbol === symbol)) return null;

    const plan = eng.buildPlan();
    if (!plan || plan.rejected) return null;

    const signal = this.tracker.open({
      symbol, timeframe: this.timeframe, plan, evaluation,
      venue: eng.book?.venue || 'aggregate',
    });
    this.lastEmit.set(symbol, now);
    this.bus.emit(TOPIC.signal, signal);
    this.dispatcher?.send(signal).catch(() => { /* delivery failures dead-letter */ });
    return signal;
  }

  snapshot() {
    return [...this.engines.entries()].map(([symbol, eng]) => ({
      symbol,
      price: eng.lastPrice,
      evaluation: eng.evaluation,
      lastTradeTs: eng.lastTradeTs,
      bars: eng.candles().length,
    }));
  }
}
