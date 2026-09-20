// Binance public market-data client.
//
// Only unauthenticated endpoints are used, so no API key ever touches this app.
// `data-api.binance.vision` is the public market-data mirror; the api*.binance.com
// hosts are tried in turn when a host is unreachable (some regions block some of
// them, and CDN hiccups are common enough to be worth the retry).

import { sleep, intervalMs } from './util.js';

const REST_HOSTS = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com',
];

const WS_HOSTS = [
  'wss://data-stream.binance.vision/ws',
  'wss://stream.binance.com:9443/ws',
];

/** aggTrades accepts startTime+endTime only when the window is under one hour. */
const AGG_WINDOW_MS = 59 * 60 * 1000;
const AGG_PAGE_LIMIT = 1000;
const KLINE_PAGE_LIMIT = 1000;

export class RateLimitError extends Error {
  constructor(message, retryAfterMs) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Serialises requests with a floor on inter-request spacing. Binance's IP budget
 * is 6000 weight/min and aggTrades costs 4, so ~110ms spacing keeps us at roughly
 * a third of the budget even in a sustained backfill.
 */
class Limiter {
  constructor(minGapMs = 110) {
    this.minGapMs = minGapMs;
    this.tail = Promise.resolve();
    this.last = 0;
  }

  run(fn) {
    const task = this.tail.then(async () => {
      const wait = this.minGapMs - (Date.now() - this.last);
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.last = Date.now();
      }
    });
    // Keep the chain alive even when a task rejects.
    this.tail = task.then(() => {}, () => {});
    return task;
  }
}

export class BinanceClient {
  constructor({ minGapMs = 110, maxRetries = 4 } = {}) {
    this.limiter = new Limiter(minGapMs);
    this.maxRetries = maxRetries;
    this.hostIndex = 0;
    this.usedWeight = 0;
  }

  get host() {
    return REST_HOSTS[this.hostIndex];
  }

  _rotateHost() {
    this.hostIndex = (this.hostIndex + 1) % REST_HOSTS.length;
  }

  async get(path, params = {}, { signal } = {}) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) qs.set(k, String(v));
    }
    const suffix = qs.toString() ? `?${qs}` : '';

    let lastErr;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await this.limiter.run(async () => {
          const res = await fetch(this.host + path + suffix, { signal });
          const weight = res.headers.get('x-mbx-used-weight-1m');
          if (weight) this.usedWeight = Number(weight);

          if (res.status === 429 || res.status === 418) {
            const retryAfter = Number(res.headers.get('retry-after') || 0) * 1000;
            throw new RateLimitError(`Rate limited (HTTP ${res.status})`, retryAfter || 5000);
          }
          if (!res.ok) {
            let detail = '';
            try {
              const body = await res.json();
              detail = body?.msg ? ` — ${body.msg}` : '';
            } catch { /* body was not JSON */ }
            const err = new Error(`Binance HTTP ${res.status}${detail}`);
            err.status = res.status;
            throw err;
          }
          return res.json();
        });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastErr = err;

        // 4xx other than rate limiting is a bad request — retrying will not help.
        if (err.status >= 400 && err.status < 500 && !(err instanceof RateLimitError)) throw err;

        if (err instanceof RateLimitError) {
          await sleep(err.retryAfterMs);
        } else {
          // Network/DNS/CORS failure: try the next host.
          this._rotateHost();
          await sleep(300 * 2 ** attempt);
        }
      }
    }
    throw lastErr ?? new Error('Request failed');
  }

  async ping() {
    await this.get('/api/v3/ping');
    return this.host;
  }

  async serverTime() {
    const r = await this.get('/api/v3/time');
    return r.serverTime;
  }

  /** Symbol metadata: tick size, step size, quote asset, trading status. */
  async symbolInfo(symbol) {
    const info = await this.get('/api/v3/exchangeInfo', { symbol: symbol.toUpperCase() });
    const s = info?.symbols?.[0];
    if (!s) throw new Error(`Unknown symbol: ${symbol}`);
    const filters = Object.fromEntries((s.filters || []).map((f) => [f.filterType, f]));
    return {
      symbol: s.symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      tickSize: Number(filters.PRICE_FILTER?.tickSize ?? 0.01),
      stepSize: Number(filters.LOT_SIZE?.stepSize ?? 0.00001),
    };
  }

  /** All actively trading spot symbols, sorted, for the symbol picker. */
  async listSymbols() {
    const info = await this.get('/api/v3/exchangeInfo', { permissions: 'SPOT' });
    return (info?.symbols || [])
      .filter((s) => s.status === 'TRADING' && s.isSpotTradingAllowed)
      .map((s) => s.symbol)
      .sort();
  }

  async klines(symbol, interval, { startTime, endTime, limit = KLINE_PAGE_LIMIT, signal } = {}) {
    const raw = await this.get('/api/v3/klines', {
      symbol: symbol.toUpperCase(), interval, startTime, endTime, limit,
    }, { signal });
    return raw.map((k) => ({
      openTime: k[0],
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: k[6],
      quoteVolume: Number(k[7]),
      trades: k[8],
      takerBuyVolume: Number(k[9]),
    }));
  }

  /** Paged klines covering an arbitrary range. */
  async klineRange(symbol, interval, startTime, endTime, { signal } = {}) {
    const step = intervalMs(interval);
    const out = [];
    let cursor = startTime;
    while (cursor < endTime) {
      const page = await this.klines(symbol, interval, {
        startTime: cursor, endTime, limit: KLINE_PAGE_LIMIT, signal,
      });
      if (!page.length) break;
      for (const k of page) if (k.openTime < endTime) out.push(k);
      const next = page[page.length - 1].openTime + step;
      if (next <= cursor) break;
      cursor = next;
      if (page.length < KLINE_PAGE_LIMIT) break;
    }
    return out;
  }

  /**
   * Streams aggregated trades over [startTime, endTime) in ascending order.
   *
   * Binance rejects a startTime/endTime pair more than an hour apart, so the range
   * is seeded with a sub-hour window and then paged by trade id, which is both
   * cheaper and immune to timestamp ties.
   *
   * Yields arrays of compact trades: { p, q, T, m, a } where `m` is
   * "buyer was the maker" — i.e. m === true means the aggressor sold.
   */
  async *aggTradeBatches(symbol, startTime, endTime, { signal, maxRequests = Infinity } = {}) {
    const sym = symbol.toUpperCase();
    let requests = 0;
    let fromId = null;
    let windowStart = startTime;

    // Seed: walk hour-sized windows forward until one contains trades.
    while (fromId === null && windowStart < endTime) {
      if (requests++ >= maxRequests) return;
      const windowEnd = Math.min(windowStart + AGG_WINDOW_MS, endTime);
      const page = await this.get('/api/v3/aggTrades', {
        symbol: sym, startTime: windowStart, endTime: windowEnd, limit: AGG_PAGE_LIMIT,
      }, { signal });

      if (page.length) {
        // Once a single trade id is known, id-paging walks straight through the
        // rest of the range — window seeking is only needed to find the entry point.
        const batch = page.map(normaliseAggTrade).filter((t) => t.T >= startTime && t.T < endTime);
        if (batch.length) yield batch;
        fromId = page[page.length - 1].a + 1;
      } else {
        windowStart = windowEnd;
      }
    }

    // Page by id until we walk past endTime.
    while (fromId !== null) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (requests++ >= maxRequests) return;
      const page = await this.get('/api/v3/aggTrades', {
        symbol: sym, fromId, limit: AGG_PAGE_LIMIT,
      }, { signal });
      if (!page.length) return;

      const batch = [];
      let done = false;
      for (const raw of page) {
        const t = normaliseAggTrade(raw);
        if (t.T >= endTime) { done = true; break; }
        if (t.T >= startTime) batch.push(t);
      }
      if (batch.length) yield batch;
      if (done || page.length < AGG_PAGE_LIMIT) return;
      fromId = page[page.length - 1].a + 1;
    }
  }
}

function normaliseAggTrade(raw) {
  return {
    a: raw.a,
    p: Number(raw.p),
    q: Number(raw.q),
    T: raw.T,
    m: raw.m === true,
  };
}

/**
 * Live aggTrade + kline stream with automatic reconnect.
 * Emits normalised trades identical in shape to the REST backfill so the
 * footprint builder does not care where a trade came from.
 */
export class LiveStream {
  constructor(symbol, { onTrade, onStatus } = {}) {
    this.symbol = symbol.toLowerCase();
    this.onTrade = onTrade || (() => {});
    this.onStatus = onStatus || (() => {});
    this.ws = null;
    this.closed = false;
    this.attempt = 0;
    this.hostIndex = 0;
  }

  start() {
    this.closed = false;
    this._connect();
  }

  _connect() {
    if (this.closed) return;
    const url = `${WS_HOSTS[this.hostIndex]}/${this.symbol}@aggTrade`;
    this.onStatus({ state: 'connecting', url });
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this._scheduleReconnect(err);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.onStatus({ state: 'open', url });
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.e !== 'aggTrade') return;
      this.onTrade({ a: msg.a, p: Number(msg.p), q: Number(msg.q), T: msg.T, m: msg.m === true });
    };
    ws.onerror = () => { /* onclose always follows */ };
    ws.onclose = () => {
      if (this.closed) return;
      this._scheduleReconnect(new Error('socket closed'));
    };
  }

  _scheduleReconnect(err) {
    this.attempt += 1;
    if (this.attempt % 2 === 0) this.hostIndex = (this.hostIndex + 1) % WS_HOSTS.length;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
    this.onStatus({ state: 'reconnecting', delay, error: String(err?.message || err) });
    setTimeout(() => this._connect(), delay);
  }

  stop() {
    this.closed = true;
    this.onStatus({ state: 'closed' });
    try { this.ws?.close(); } catch { /* already gone */ }
    this.ws = null;
  }
}

export { REST_HOSTS, WS_HOSTS };
