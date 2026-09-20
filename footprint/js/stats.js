// Performance statistics for a finished backtest run.

import { mean, stdev } from './util.js';

const YEAR_MS = 365 * 24 * 3600 * 1000;

/**
 * Worst peak-to-trough decline. The winner is chosen by PERCENTAGE — equity
 * compounds, so a $50 dip from $1,100 hurts more than a $50 dip from $1,250 —
 * and the absolute figure reported is that same episode's, never a mix of two.
 */
function maxDrawdown(curve) {
  let peak = -Infinity;
  let peakIdx = 0;
  let worst = { abs: 0, pct: 0, peakIdx: 0, troughIdx: 0 };
  let longest = 0;
  let underwaterFrom = null;

  for (let i = 0; i < curve.length; i++) {
    const v = curve[i].equity;
    if (v > peak) {
      peak = v;
      peakIdx = i;
      if (underwaterFrom !== null) {
        longest = Math.max(longest, curve[i].time - curve[underwaterFrom].time);
        underwaterFrom = null;
      }
      continue;
    }
    if (underwaterFrom === null) underwaterFrom = peakIdx;
    const abs = peak - v;
    const pct = peak > 0 ? abs / peak : 0;
    if (pct > worst.pct) worst = { abs, pct, peakIdx, troughIdx: i };
  }
  if (underwaterFrom !== null && curve.length) {
    longest = Math.max(longest, curve[curve.length - 1].time - curve[underwaterFrom].time);
  }
  return {
    abs: worst.abs,
    pct: worst.pct * 100,
    peakTime: curve[worst.peakIdx]?.time ?? null,
    troughTime: curve[worst.troughIdx]?.time ?? null,
    longestMs: longest,
  };
}

function consecutive(trades) {
  let win = 0;
  let loss = 0;
  let maxWin = 0;
  let maxLoss = 0;
  for (const t of trades) {
    if (t.pnl > 0) { win++; loss = 0; } else if (t.pnl < 0) { loss++; win = 0; } else { win = 0; loss = 0; }
    maxWin = Math.max(maxWin, win);
    maxLoss = Math.max(maxLoss, loss);
  }
  return { maxWin, maxLoss };
}

/**
 * @param trades  closed trades
 * @param curve   per-bar mark-to-market equity: [{ time, equity }]
 * @param opts    { initialCapital, intervalMs, barsInMarket, totalBars }
 */
export function computeStats(trades, curve, opts = {}) {
  const { initialCapital = 10_000, intervalMs = 60_000, barsInMarket = 0, totalBars = 0 } = opts;

  const wins = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const netProfit = trades.reduce((s, t) => s + t.pnl, 0);
  const fees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  const finalEquity = initialCapital + netProfit;

  const rMultiples = trades.map((t) => t.r).filter(Number.isFinite);

  // Per-bar returns drive the risk ratios, so flat periods correctly dampen them.
  const returns = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    if (prev > 0) returns.push(curve[i].equity / prev - 1);
  }
  const barsPerYear = YEAR_MS / intervalMs;
  const rMean = mean(returns);
  const rStd = stdev(returns);
  const downside = returns.filter((r) => r < 0);
  const dStd = downside.length > 1 ? Math.sqrt(downside.reduce((s, r) => s + r * r, 0) / downside.length) : NaN;

  const sharpe = Number.isFinite(rMean) && rStd > 0 ? (rMean / rStd) * Math.sqrt(barsPerYear) : NaN;
  const sortino = Number.isFinite(rMean) && dStd > 0 ? (rMean / dStd) * Math.sqrt(barsPerYear) : NaN;

  const dd = maxDrawdown(curve.length ? curve : [{ time: 0, equity: initialCapital }]);
  const spanMs = curve.length > 1 ? curve[curve.length - 1].time - curve[0].time : 0;
  const years = spanMs / YEAR_MS;
  const cagr = years > 0 && initialCapital > 0 && finalEquity > 0
    ? ((finalEquity / initialCapital) ** (1 / years) - 1) * 100
    : NaN;

  const streaks = consecutive(trades);

  return {
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length) * 100 : NaN,
    netProfit,
    netProfitPct: initialCapital > 0 ? (netProfit / initialCapital) * 100 : NaN,
    finalEquity,
    grossProfit,
    grossLoss,
    fees,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : NaN),
    avgWin: wins.length ? grossProfit / wins.length : NaN,
    avgLoss: losses.length ? -grossLoss / losses.length : NaN,
    payoff: wins.length && losses.length ? (grossProfit / wins.length) / (grossLoss / losses.length) : NaN,
    expectancy: trades.length ? netProfit / trades.length : NaN,
    expectancyR: rMultiples.length ? mean(rMultiples) : NaN,
    bestTrade: trades.length ? Math.max(...trades.map((t) => t.pnl)) : NaN,
    worstTrade: trades.length ? Math.min(...trades.map((t) => t.pnl)) : NaN,
    maxDrawdown: dd.abs,
    maxDrawdownPct: dd.pct,
    longestDrawdownMs: dd.longestMs,
    sharpe,
    sortino,
    cagr,
    maxConsecWins: streaks.maxWin,
    maxConsecLosses: streaks.maxLoss,
    avgHoldBars: trades.length ? mean(trades.map((t) => t.bars)) : NaN,
    avgHoldMs: trades.length ? mean(trades.map((t) => t.exitTime - t.entryTime)) : NaN,
    exposurePct: totalBars ? (barsInMarket / totalBars) * 100 : NaN,
    spanMs,
  };
}

/** Group trades by an arbitrary key and compute a compact scorecard for each. */
export function breakdown(trades, keyFn) {
  const groups = new Map();
  for (const t of trades) {
    const k = keyFn(t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const rows = [];
  for (const [key, ts] of groups) {
    const wins = ts.filter((t) => t.pnl > 0);
    const gp = wins.reduce((s, t) => s + t.pnl, 0);
    const gl = Math.abs(ts.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
    const rs = ts.map((t) => t.r).filter(Number.isFinite);
    rows.push({
      key,
      trades: ts.length,
      winRate: (wins.length / ts.length) * 100,
      netProfit: ts.reduce((s, t) => s + t.pnl, 0),
      profitFactor: gl > 0 ? gp / gl : (gp > 0 ? Infinity : NaN),
      expectancyR: rs.length ? mean(rs) : NaN,
    });
  }
  rows.sort((a, b) => b.netProfit - a.netProfit);
  return rows;
}
