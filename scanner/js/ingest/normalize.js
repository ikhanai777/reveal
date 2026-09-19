// Venue-neutral market data shapes.
// Every adapter converts to these before anything touches the bus, so an engine
// never learns which exchange a print came from.

/**
 * @typedef {Object} Trade
 * @property {string} venue
 * @property {string} symbol     normalized "BTC/USDT"
 * @property {number} ts         ms epoch
 * @property {number} price
 * @property {number} size       base units
 * @property {1|-1}   side       1 = aggressive buy (taker lifted the offer)
 * @property {string} [id]
 */

/**
 * @typedef {Object} BookLevel  [price, size]
 * @typedef {Object} Book
 * @property {string} venue
 * @property {string} symbol
 * @property {number} ts
 * @property {[number,number][]} bids  descending by price
 * @property {[number,number][]} asks  ascending by price
 */

const QUOTES = ['USDT', 'USDC', 'USD', 'BUSD', 'BTC', 'ETH', 'EUR', 'PERP'];

/** "BTCUSDT" / "BTC-USDT" / "btc_usdt" -> "BTC/USDT" */
export function normalizeSymbol(raw) {
  if (!raw) return '';
  const s = String(raw).toUpperCase().replace(/[-_]/g, '');
  if (s.includes('/')) return s;
  for (const q of QUOTES) {
    if (s.endsWith(q) && s.length > q.length) return `${s.slice(0, -q.length)}/${q}`;
  }
  return s;
}

/** "BTC/USDT" -> "BTCUSDT" (Binance REST/WS wire format). */
export function denormalizeSymbol(sym) {
  return String(sym).replace('/', '').toUpperCase();
}

export function makeTrade({ venue, symbol, ts, price, size, side, id }) {
  return {
    venue,
    symbol: normalizeSymbol(symbol),
    ts: Number(ts),
    price: Number(price),
    size: Number(size),
    side: side >= 0 ? 1 : -1,
    id: id != null ? String(id) : undefined,
  };
}

export function makeCandle(openTime, price, tf) {
  return {
    t: openTime,
    tf,
    o: price, h: price, l: price, c: price,
    v: 0,          // total base volume
    buyVol: 0,     // aggressive buy volume
    sellVol: 0,    // aggressive sell volume
    trades: 0,
    closed: false,
  };
}

export function candleDelta(c) { return c.buyVol - c.sellVol; }

/** Best bid/ask/mid/spread from a normalized book, tolerant of empty sides. */
export function topOfBook(book) {
  const bid = book?.bids?.[0]?.[0] ?? NaN;
  const ask = book?.asks?.[0]?.[0] ?? NaN;
  const mid = Number.isFinite(bid) && Number.isFinite(ask) ? (bid + ask) / 2 : NaN;
  return { bid, ask, mid, spread: ask - bid, spreadBps: ((ask - bid) / mid) * 10_000 };
}
