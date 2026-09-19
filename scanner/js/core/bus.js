// Minimal synchronous event bus. Every layer of the pipeline talks through it,
// which is what lets the backtester swap a replay feed in for live WebSockets
// without any engine knowing the difference.

export class Bus {
  constructor() {
    this.handlers = new Map();
    this.anyHandlers = new Set();
  }

  on(topic, fn) {
    if (!this.handlers.has(topic)) this.handlers.set(topic, new Set());
    this.handlers.get(topic).add(fn);
    return () => this.off(topic, fn);
  }

  once(topic, fn) {
    const off = this.on(topic, (payload) => { off(); fn(payload); });
    return off;
  }

  onAny(fn) {
    this.anyHandlers.add(fn);
    return () => this.anyHandlers.delete(fn);
  }

  off(topic, fn) {
    this.handlers.get(topic)?.delete(fn);
  }

  emit(topic, payload) {
    const set = this.handlers.get(topic);
    if (set) {
      // Copy: handlers commonly unsubscribe themselves mid-dispatch.
      for (const fn of [...set]) {
        try { fn(payload, topic); } catch (err) { this.reportError(err, topic); }
      }
    }
    for (const fn of [...this.anyHandlers]) {
      try { fn(payload, topic); } catch (err) { this.reportError(err, topic); }
    }
  }

  reportError(err, topic) {
    // Never let one bad subscriber kill an ingestion tick.
    if (topic !== TOPIC.error) this.emit(TOPIC.error, { topic, error: err });
    else console.error('[bus]', topic, err);
  }

  clear() { this.handlers.clear(); this.anyHandlers.clear(); }
}

export const TOPIC = {
  trade: 'md:trade',            // normalized tick
  book: 'md:book',              // L2 snapshot after diff application
  candle: 'md:candle',          // { timeframe, candle, closed }
  funding: 'md:funding',
  openInterest: 'md:oi',
  news: 'md:news',
  chain: 'md:chain',
  status: 'sys:status',         // connection / feed health
  error: 'sys:error',
  score: 'sig:score',           // SCS recomputed
  signal: 'sig:emitted',
  signalUpdate: 'sig:update',   // tracker lifecycle transition
  backtest: 'bt:progress',
};

export const bus = new Bus();
