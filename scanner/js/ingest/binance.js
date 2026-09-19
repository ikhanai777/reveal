// Binance adapter: public market data only (no keys, no signed endpoints).
// Spot and USD-M futures share the wire format, so one adapter covers both and
// the futures base additionally serves funding and open interest.

import { ManagedSocket } from './socket.js';
import { BookBuilder } from './bookbuilder.js';
import { RateLimiter } from './ratelimit.js';
import { makeTrade, normalizeSymbol, denormalizeSymbol } from './normalize.js';
import { TOPIC } from '../core/bus.js';

const ENDPOINTS = {
  spot: {
    ws: 'wss://stream.binance.com:9443/stream',
    rest: 'https://api.binance.com',
    depth: '/api/v3/depth',
    klines: '/api/v3/klines',
    continuity: 'spot',
  },
  futures: {
    ws: 'wss://fstream.binance.com/stream',
    rest: 'https://fapi.binance.com',
    depth: '/fapi/v1/depth',
    klines: '/fapi/v1/klines',
    continuity: 'futures',
  },
};

export class BinanceAdapter {
  /**
   * @param {object} opts
   * @param {import('../core/bus.js').Bus} opts.bus
   * @param {string[]} opts.symbols  normalized, e.g. ['BTC/USDT']
   * @param {'spot'|'futures'} [opts.market]
   */
  constructor({ bus, symbols, market = 'futures', bookDepth = 20, WebSocketImpl, fetchImpl } = {}) {
    this.bus = bus;
    this.market = market;
    this.endpoint = ENDPOINTS[market];
    this.symbols = symbols.map(normalizeSymbol);
    this.bookDepth = bookDepth;
    this.WS = WebSocketImpl;
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.books = new Map();
    this.socket = null;
    this.pollTimer = null;
    // Binance publishes a 1200 weight/min budget for REST; stay well inside it.
    this.limiter = new RateLimiter({ capacity: 900, intervalMs: 60_000 });
  }

  get venue() { return `binance-${this.market}`; }

  streamsFor(sym) {
    const w = denormalizeSymbol(sym).toLowerCase();
    return [`${w}@aggTrade`, `${w}@depth@100ms`, `${w}@kline_1m`];
  }

  start() {
    const streams = this.symbols.flatMap((s) => this.streamsFor(s)).join('/');
    this.socket = new ManagedSocket({
      url: `${this.endpoint.ws}?streams=${streams}`,
      name: this.venue,
      WebSocketImpl: this.WS,
      onStatus: (s) => this.bus.emit(TOPIC.status, s),
      onOpen: () => { for (const s of this.symbols) this.resyncBook(s); },
      onMessage: (msg) => this.handle(msg),
    });
    this.socket.connect();
    if (this.market === 'futures') this.startDerivativesPolling();
  }

  stop() {
    this.socket?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  handle(msg) {
    const data = msg?.data ?? msg;
    if (!data?.e) return;
    switch (data.e) {
      case 'aggTrade': return this.onAggTrade(data);
      case 'depthUpdate': return this.onDepth(data);
      case 'kline': return this.onKline(data);
      default: return undefined;
    }
  }

  onAggTrade(d) {
    // `m` = buyer is the maker, so the aggressor sold into the bid.
    this.bus.emit(TOPIC.trade, makeTrade({
      venue: this.venue,
      symbol: d.s,
      ts: d.T,
      price: +d.p,
      size: +d.q,
      side: d.m ? -1 : 1,
      id: d.a,
    }));
  }

  book(sym) {
    const key = normalizeSymbol(sym);
    if (!this.books.has(key)) {
      this.books.set(key, new BookBuilder({ continuity: this.endpoint.continuity }));
    }
    return this.books.get(key);
  }

  onDepth(d) {
    const sym = normalizeSymbol(d.s);
    const builder = this.book(sym);
    const res = builder.onDiff(d);
    if (res.needResync) { this.resyncBook(sym); return; }
    if (!res.applied) return;
    const snap = builder.snapshot(this.bookDepth);
    this.bus.emit(TOPIC.book, { venue: this.venue, symbol: sym, ts: d.E, bids: snap.bids, asks: snap.asks });
  }

  onKline(d) {
    const k = d.k;
    this.bus.emit(TOPIC.candle, {
      venue: this.venue,
      symbol: normalizeSymbol(d.s),
      source: 'exchange',
      timeframe: k.i,
      closed: !!k.x,
      candle: {
        t: k.t, tf: k.i,
        o: +k.o, h: +k.h, l: +k.l, c: +k.c,
        v: +k.v,
        buyVol: +k.V,
        sellVol: +k.v - +k.V,
        trades: k.n,
        closed: !!k.x,
      },
    });
  }

  async rest(path, params = {}, weight = 1) {
    if (!this.fetch) throw new Error('no fetch implementation available');
    const qs = new URLSearchParams(params).toString();
    const url = `${this.endpoint.rest}${path}${qs ? `?${qs}` : ''}`;
    return this.limiter.schedule(async () => {
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
      return res.json();
    }, weight);
  }

  async resyncBook(sym) {
    const builder = this.book(sym);
    builder.synced = false;
    try {
      const snap = await this.rest(this.endpoint.depth, {
        symbol: denormalizeSymbol(sym), limit: 1000,
      }, 20);
      builder.onSnapshot(snap);
      this.bus.emit(TOPIC.status, { name: this.venue, state: 'book-synced', detail: sym, ts: Date.now() });
    } catch (err) {
      this.bus.emit(TOPIC.error, { topic: 'book-resync', symbol: sym, error: err });
    }
  }

  /** Historical candles for backfill and backtests, oldest-first. */
  async klines(sym, interval, { limit = 500, startTime, endTime } = {}) {
    const rows = await this.rest(this.endpoint.klines, {
      symbol: denormalizeSymbol(sym), interval, limit,
      ...(startTime ? { startTime } : {}),
      ...(endTime ? { endTime } : {}),
    }, 5);
    return rows.map((r) => ({
      t: r[0], tf: interval,
      o: +r[1], h: +r[2], l: +r[3], c: +r[4],
      v: +r[5],
      buyVol: +r[9],
      sellVol: +r[5] - +r[9],
      trades: r[8],
      closed: true,
    }));
  }

  async fundingRate(sym) {
    const d = await this.rest('/fapi/v1/premiumIndex', { symbol: denormalizeSymbol(sym) }, 1);
    return {
      symbol: normalizeSymbol(sym),
      ts: d.time,
      rate: +d.lastFundingRate,
      markPrice: +d.markPrice,
      indexPrice: +d.indexPrice,
      nextFundingTime: d.nextFundingTime,
    };
  }

  async openInterest(sym) {
    const d = await this.rest('/fapi/v1/openInterest', { symbol: denormalizeSymbol(sym) }, 1);
    return { symbol: normalizeSymbol(sym), ts: d.time, oi: +d.openInterest };
  }

  /** Funding and OI move on minute-or-slower cadences; polling is enough. */
  startDerivativesPolling(intervalMs = 60_000) {
    const tick = async () => {
      for (const sym of this.symbols) {
        try {
          const [f, oi] = await Promise.all([this.fundingRate(sym), this.openInterest(sym)]);
          this.bus.emit(TOPIC.funding, f);
          this.bus.emit(TOPIC.openInterest, oi);
        } catch (err) {
          this.bus.emit(TOPIC.error, { topic: 'derivatives-poll', symbol: sym, error: err });
        }
      }
    };
    tick();
    this.pollTimer = setInterval(tick, intervalMs);
  }
}
