// Timeframe vocabulary shared by the rollup engine, the UI and the backtester.

export const TF_MS = {
  '1s': 1_000,
  '1m': 60_000,
  '5m': 300_000,
  '15m': 900_000,
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
};

export const TIMEFRAMES = Object.keys(TF_MS);

export function tfMs(tf) {
  const ms = TF_MS[tf];
  if (!ms) throw new Error(`unknown timeframe: ${tf}`);
  return ms;
}

/** Open time of the bucket containing `ts`, aligned to the UTC epoch. */
export function bucketStart(ts, tf) {
  const ms = tfMs(tf);
  return Math.floor(ts / ms) * ms;
}

export function nextBucket(ts, tf) {
  return bucketStart(ts, tf) + tfMs(tf);
}

/** Bars per year, used to annualize backtest statistics. */
export function barsPerYear(tf) {
  return (365 * 86_400_000) / tfMs(tf);
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}
