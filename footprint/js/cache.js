// IndexedDB cache for aggregated trades, bucketed by clock hour.
//
// Backfilling a day of BTCUSDT is several hundred requests; without a cache every
// re-run of a backtest pays that again. Only hours that have fully elapsed are
// cached, so the in-progress hour is never frozen half-written.

const DB_NAME = 'footprint-cache';
const DB_VERSION = 1;
const STORE = 'aggTradeHours';

export const HOUR_MS = 3_600_000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('symbol', 'symbol', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const keyFor = (symbol, bucket) => `${symbol.toUpperCase()}|${bucket}`;

/** Columnar encoding — roughly 25 bytes/trade vs ~150 for an array of objects. */
function encode(trades) {
  const n = trades.length;
  const p = new Float64Array(n);
  const q = new Float64Array(n);
  const T = new Float64Array(n);
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    p[i] = trades[i].p;
    q[i] = trades[i].q;
    T[i] = trades[i].T;
    m[i] = trades[i].m ? 1 : 0;
  }
  return { n, p, q, T, m };
}

function decode(rec) {
  const out = new Array(rec.n);
  for (let i = 0; i < rec.n; i++) {
    out[i] = { p: rec.p[i], q: rec.q[i], T: rec.T[i], m: rec.m[i] === 1 };
  }
  return out;
}

export const tradeCache = {
  available: 'indexedDB' in globalThis,

  async get(symbol, bucket) {
    try {
      const db = await openDb();
      const rec = await wrap(tx(db, 'readonly').get(keyFor(symbol, bucket)));
      return rec ? decode(rec) : null;
    } catch {
      return null;
    }
  },

  async put(symbol, bucket, trades) {
    try {
      const db = await openDb();
      const enc = encode(trades);
      await wrap(tx(db, 'readwrite').put({
        key: keyFor(symbol, bucket),
        symbol: symbol.toUpperCase(),
        bucket,
        storedAt: Date.now(),
        ...enc,
      }));
      return true;
    } catch {
      // A full quota or private-browsing block should never break a backfill.
      return false;
    }
  },

  async stats() {
    try {
      const db = await openDb();
      const all = await wrap(tx(db, 'readonly').getAll());
      let trades = 0;
      const symbols = new Map();
      for (const rec of all) {
        trades += rec.n;
        symbols.set(rec.symbol, (symbols.get(rec.symbol) || 0) + 1);
      }
      return {
        hours: all.length,
        trades,
        symbols: [...symbols.entries()].map(([symbol, hours]) => ({ symbol, hours })),
        approxBytes: trades * 25,
      };
    } catch {
      return { hours: 0, trades: 0, symbols: [], approxBytes: 0 };
    }
  },

  async clear() {
    try {
      const db = await openDb();
      await wrap(tx(db, 'readwrite').clear());
      return true;
    } catch {
      return false;
    }
  },
};
