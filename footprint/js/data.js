// Range loading: stitches the IndexedDB cache together with REST backfill.
//
// The range is split into clock hours. A fully-elapsed hour is served from cache
// when present and written back after a fetch; the in-progress hour is always
// fetched fresh and never cached.

import { tradeCache, HOUR_MS } from './cache.js';

export function hourBuckets(start, end) {
  const out = [];
  let b = Math.floor(start / HOUR_MS) * HOUR_MS;
  while (b < end) {
    out.push(b);
    b += HOUR_MS;
  }
  return out;
}

/**
 * @returns {Promise<{trades: Array, stats: object}>} trades in ascending time order.
 */
export async function loadTrades({
  client,
  symbol,
  start,
  end,
  useCache = true,
  maxTrades = 3_000_000,
  onProgress = () => {},
  signal,
}) {
  const buckets = hourBuckets(start, end);
  const trades = [];
  const stats = { cachedHours: 0, fetchedHours: 0, requests: 0, truncated: false };
  const now = Date.now();

  for (let i = 0; i < buckets.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const bucket = buckets[i];
    const bucketEnd = bucket + HOUR_MS;
    const from = Math.max(bucket, start);
    const to = Math.min(bucketEnd, end);
    const cacheable = useCache && bucketEnd <= now && from === bucket && to === bucketEnd;

    let hourTrades = null;
    if (cacheable) {
      const hit = await tradeCache.get(symbol, bucket);
      if (hit) {
        hourTrades = hit;
        stats.cachedHours++;
      }
    }

    if (!hourTrades) {
      hourTrades = [];
      const before = stats.requests;
      for await (const batch of client.aggTradeBatches(symbol, from, to, { signal })) {
        stats.requests++;
        for (const t of batch) hourTrades.push(t);
        onProgress({
          phase: 'fetching',
          hour: i + 1,
          hours: buckets.length,
          trades: trades.length + hourTrades.length,
          ...stats,
        });
        if (trades.length + hourTrades.length > maxTrades) {
          stats.truncated = true;
          break;
        }
      }
      // A cached hour costs no requests; only count hours we actually hit the API for.
      if (stats.requests > before) stats.fetchedHours++;
      if (cacheable && !stats.truncated) await tradeCache.put(symbol, bucket, hourTrades);
    }

    for (const t of hourTrades) {
      if (t.T >= from && t.T < to) trades.push(t);
    }

    onProgress({
      phase: 'loading',
      hour: i + 1,
      hours: buckets.length,
      trades: trades.length,
      ...stats,
    });

    if (stats.truncated) break;
  }

  // Cached hours are stored sorted, but a fetch boundary can interleave by a
  // millisecond or two; one sort keeps the builder's ordering contract.
  trades.sort((a, b) => a.T - b.T || (a.a ?? 0) - (b.a ?? 0));
  onProgress({ phase: 'done', hours: buckets.length, hour: buckets.length, trades: trades.length, ...stats });
  return { trades, stats };
}

/** Rough request count for a range, shown before a big backfill is started. */
export function estimateRequests(hours, tradesPerHour = 30_000) {
  return Math.ceil((hours * tradesPerHour) / 1000);
}
