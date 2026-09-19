// Backtest statistics: return, risk, risk-adjusted ratios, trade stats.

import { mean, stdev, downsideDeviation } from '../core/num.js';

/** Peak-to-trough drawdown series plus the deepest and longest episodes. */
export function drawdownProfile(equity) {
  if (!equity.length) return { max: 0, maxDurationMs: 0, avgDurationMs: 0, series: [], episodes: [] };
  let peak = equity[0].value;
  let peakTs = equity[0].ts;
  const series = [];
  const episodes = [];
  let current = null;

  for (const p of equity) {
    if (p.value >= peak) {
      if (current) {
        current.recoveredTs = p.ts;
        current.durationMs = p.ts - current.startTs;
        episodes.push(current);
        current = null;
      }
      peak = p.value;
      peakTs = p.ts;
    }
    const dd = peak > 0 ? (p.value - peak) / peak : 0;
    series.push({ ts: p.ts, dd });
    if (dd < 0) {
      if (!current) current = { startTs: peakTs, depth: dd, troughTs: p.ts, recoveredTs: null, durationMs: null };
      if (dd < current.depth) { current.depth = dd; current.troughTs = p.ts; }
    }
  }
  if (current) {
    current.durationMs = equity[equity.length - 1].ts - current.startTs;
    episodes.push(current);
  }

  const durations = episodes.map((e) => e.durationMs).filter((d) => d != null);
  return {
    max: Math.min(0, ...series.map((s) => s.dd)),
    maxDurationMs: durations.length ? Math.max(...durations) : 0,
    avgDurationMs: durations.length ? mean(durations) : 0,
    series,
    episodes,
  };
}

/** Per-period simple returns from an equity curve. */
export function periodReturns(equity) {
  const out = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) out.push(equity[i].value / prev - 1);
  }
  return out;
}

export function sharpe(returns, periodsPerYear, riskFree = 0) {
  if (returns.length < 2) return 0;
  const excess = returns.map((r) => r - riskFree / periodsPerYear);
  const sd = stdev(excess);
  return sd === 0 ? 0 : (mean(excess) / sd) * Math.sqrt(periodsPerYear);
}

export function sortino(returns, periodsPerYear, target = 0) {
  if (returns.length < 2) return 0;
  const dd = downsideDeviation(returns, target / periodsPerYear);
  return dd === 0 ? 0 : ((mean(returns) - target / periodsPerYear) / dd) * Math.sqrt(periodsPerYear);
}

/** Shortest span over which annualizing a return is worth reporting. */
export const MIN_ANNUALIZE_DAYS = 30;

export function spanDays(equity) {
  if (equity.length < 2) return 0;
  return (equity[equity.length - 1].ts - equity[0].ts) / 86_400_000;
}

/**
 * Compound annual growth rate. Returns NaN for a span too short to annualize:
 * raising a few days of return to the 365th power produces a number in the
 * hundreds of thousands of percent, which is arithmetic, not information.
 */
export function cagr(equity) {
  if (equity.length < 2) return 0;
  const days = spanDays(equity);
  if (days < MIN_ANNUALIZE_DAYS) return NaN;
  const years = days / 365;
  if (years <= 0 || equity[0].value <= 0) return 0;
  const growth = equity[equity.length - 1].value / equity[0].value;
  return growth <= 0 ? -1 : growth ** (1 / years) - 1;
}

export function calmar(equity) {
  const dd = drawdownProfile(equity).max;
  const c = cagr(equity);
  if (!Number.isFinite(c)) return NaN;   // inherits CAGR's short-span guard
  return dd === 0 ? 0 : c / Math.abs(dd);
}

/** Longest run of consecutive losers. */
export function maxConsecutive(trades, predicate) {
  let best = 0, run = 0;
  for (const t of trades) {
    if (predicate(t)) { run++; best = Math.max(best, run); } else run = 0;
  }
  return best;
}

/** Calendar-month returns, keyed 'YYYY-MM', for the heatmap. */
export function monthlyReturns(equity) {
  const byMonth = new Map();
  for (const p of equity) {
    const d = new Date(p.ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    if (!byMonth.has(key)) byMonth.set(key, { first: p.value, last: p.value });
    else byMonth.get(key).last = p.value;
  }
  return [...byMonth.entries()].map(([month, v]) => ({
    month,
    ret: v.first > 0 ? v.last / v.first - 1 : 0,
  }));
}

/**
 * Full statistics block.
 * @param {object[]} trades   closed trades with { pnl, pnlPct, openTs, closeTs }
 * @param {object[]} equity   [{ ts, value }]
 */
export function computeMetrics({ trades, equity, periodsPerYear = 365 * 24 * 12, riskFree = 0 }) {
  const rets = periodReturns(equity);
  const dd = drawdownProfile(equity);
  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl <= 0);
  const grossWin = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const start = equity[0]?.value ?? 0;
  const end = equity[equity.length - 1]?.value ?? start;

  return {
    // Returns
    startEquity: start,
    endEquity: end,
    cumulativeReturn: start > 0 ? end / start - 1 : 0,
    cagr: cagr(equity),
    spanDays: spanDays(equity),
    monthly: monthlyReturns(equity),
    // Risk
    maxDrawdown: dd.max,
    maxDrawdownDurationMs: dd.maxDurationMs,
    avgDrawdownDurationMs: dd.avgDurationMs,
    volatility: stdev(rets) * Math.sqrt(periodsPerYear),
    drawdownSeries: dd.series,
    // Risk-adjusted
    sharpe: sharpe(rets, periodsPerYear, riskFree),
    sortino: sortino(rets, periodsPerYear, riskFree),
    calmar: calmar(equity),
    profitFactor: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
    // Trades
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    payoffRatio: losses.length && wins.length ? (grossWin / wins.length) / (grossLoss / losses.length) : 0,
    maxConsecutiveLosses: maxConsecutive(trades, (t) => t.pnl <= 0),
    maxConsecutiveWins: maxConsecutive(trades, (t) => t.pnl > 0),
    avgHoldingMs: trades.length ? mean(trades.map((t) => t.closeTs - t.openTs)) : 0,
    totalFees: trades.reduce((a, t) => a + (t.fees || 0), 0),
    totalFunding: trades.reduce((a, t) => a + (t.funding || 0), 0),
    totalSlippage: trades.reduce((a, t) => a + (t.slippageCost || 0), 0),
  };
}
