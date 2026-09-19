import { describe, it, assert } from './harness.js';
import { computeMetrics, drawdownProfile, sharpe, sortino, cagr, maxConsecutive, monthlyReturns } from '../js/backtest/metrics.js';
import { quadraticSlippage, walkBook, fee, fundingCost } from '../js/backtest/slippage.js';
import { monteCarlo } from '../js/backtest/montecarlo.js';
import { runBacktest } from '../js/backtest/engine.js';
import { walkForward, weightGrid, defaultObjective } from '../js/backtest/walkforward.js';
import { syntheticCandles } from '../js/ingest/synthetic.js';
import { TokenBucket, RateLimiter, backoff } from '../js/ingest/ratelimit.js';

describe('metrics', () => {
  it('measures peak-to-trough drawdown', () => {
    const eq = [100, 120, 90, 110, 80, 130].map((v, i) => ({ ts: i * 86_400_000, value: v }));
    const dd = drawdownProfile(eq);
    assert.close(dd.max, (80 - 120) / 120, 1e-9);
  });

  it('reports no drawdown on a monotonic curve', () => {
    const eq = [100, 110, 120].map((v, i) => ({ ts: i, value: v }));
    assert.close(drawdownProfile(eq).max, 0);
  });

  it('gives a zero Sharpe to a flat curve', () => {
    assert.close(sharpe([0, 0, 0, 0], 252), 0);
  });

  it('scores Sortino above Sharpe when losses are rare', () => {
    const rets = [0.02, 0.03, -0.005, 0.025, 0.02, 0.03];
    assert.ok(sortino(rets, 252) > sharpe(rets, 252));
  });

  it('annualizes CAGR over the curve span', () => {
    const eq = [
      { ts: 0, value: 100 },
      { ts: 365 * 86_400_000, value: 200 },
    ];
    assert.close(cagr(eq), 1, 1e-6);
  });

  it('counts the longest losing streak', () => {
    const trades = [1, -1, -1, -1, 1, -1].map((pnl) => ({ pnl }));
    assert.equal(maxConsecutive(trades, (t) => t.pnl <= 0), 3);
  });

  it('buckets returns by calendar month', () => {
    const eq = [
      { ts: Date.UTC(2024, 0, 1), value: 100 },
      { ts: Date.UTC(2024, 0, 28), value: 110 },
      { ts: Date.UTC(2024, 1, 5), value: 121 },
    ];
    const m = monthlyReturns(eq);
    assert.equal(m[0].month, '2024-01');
    assert.close(m[0].ret, 0.1, 1e-9);
  });

  it('computes a full statistics block', () => {
    const trades = [
      { pnl: 100, pnlPct: 0.01, openTs: 0, closeTs: 3600_000, fees: 1, funding: 0, slippageCost: 0.5 },
      { pnl: -50, pnlPct: -0.005, openTs: 3600_000, closeTs: 7200_000, fees: 1, funding: 0, slippageCost: 0.5 },
      { pnl: 75, pnlPct: 0.0075, openTs: 7200_000, closeTs: 10800_000, fees: 1, funding: 0, slippageCost: 0.5 },
    ];
    const eq = [10_000, 10_100, 10_050, 10_125].map((v, i) => ({ ts: i * 3600_000, value: v }));
    const m = computeMetrics({ trades, equity: eq, periodsPerYear: 8760 });
    assert.close(m.winRate, 2 / 3, 1e-9);
    assert.close(m.profitFactor, 175 / 50, 1e-9);
    assert.equal(m.trades, 3);
    assert.close(m.totalFees, 3);
    assert.ok(m.cumulativeReturn > 0);
  });
});

describe('execution realism', () => {
  it('grows slippage with the square of participation', () => {
    const small = quadraticSlippage({ notional: 1000, depthNotional: 100_000 });
    const big = quadraticSlippage({ notional: 10_000, depthNotional: 100_000 });
    const spread = 0.5 / 10_000;
    assert.close((big - spread) / (small - spread), 100, 1e-6);
  });

  it('caps slippage so a thin book cannot produce nonsense', () => {
    assert.close(quadraticSlippage({ notional: 1e9, depthNotional: 1, cap: 0.02 }), 0.02);
  });

  it('walks a book to a volume-weighted fill', () => {
    const vwap = walkBook({ levels: [[100, 1], [101, 1]], qty: 2, side: 1 });
    assert.close(vwap, 100.5, 1e-9);
  });

  it('penalizes the unfilled remainder past the book', () => {
    const vwap = walkBook({ levels: [[100, 1]], qty: 2, side: 1, fallbackBps: 100 });
    assert.ok(vwap > 100.4, `expected a penalty on the unfilled half, got ${vwap}`);
  });

  it('charges maker below taker', () => {
    assert.ok(fee({ notional: 10_000, liquidity: 'maker' }) < fee({ notional: 10_000, liquidity: 'taker' }));
  });

  it('charges a long for positive funding at each settlement', () => {
    const eightH = 8 * 3_600_000;
    const rates = [{ ts: 0, rate: 0.0001 }];
    const cost = fundingCost({ rates, from: 1, to: eightH * 2 + 1, notional: 10_000, direction: 1 });
    assert.close(cost, 2 * 10_000 * 0.0001, 1e-9);
  });

  it('pays a short when funding is positive', () => {
    const rates = [{ ts: 0, rate: 0.0001 }];
    const cost = fundingCost({ rates, from: 1, to: 8 * 3_600_000 + 1, notional: 10_000, direction: -1 });
    assert.ok(cost < 0);
  });

  it('charges nothing for a position closed inside one interval', () => {
    const rates = [{ ts: 0, rate: 0.0001 }];
    assert.close(fundingCost({ rates, from: 1, to: 1000, notional: 10_000, direction: 1 }), 0);
  });
});

describe('rate limiting', () => {
  it('refills the bucket over time', () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 10, refillPerMs: 0.01, now: () => now });
    assert.equal(b.take(10), true);
    assert.equal(b.take(1), false);
    now = 1000;                      // 10 tokens restored
    assert.equal(b.take(10), true);
  });

  it('reports the wait needed for a weighted call', () => {
    let now = 0;
    const b = new TokenBucket({ capacity: 10, refillPerMs: 0.01, now: () => now });
    b.take(10);
    assert.equal(b.delayFor(5), 500);
  });

  it('defers a call until the budget allows it', async () => {
    let now = 0;
    const limiter = new RateLimiter({
      capacity: 2, intervalMs: 1000,
      now: () => now,
      sleep: (ms) => { now += ms; return Promise.resolve(); },
    });
    const order = [];
    await Promise.all([
      limiter.schedule(() => order.push('a'), 2),
      limiter.schedule(() => order.push('b'), 2),
    ]);
    assert.deep(order, ['a', 'b']);
    assert.ok(now >= 1000, 'second call waited for a refill');
  });

  it('bounds backoff by the cap', () => {
    for (let i = 0; i < 20; i++) assert.ok(backoff(i, { cap: 30_000 }) <= 30_000 * 1.3);
  });
});

describe('Monte Carlo', () => {
  const trades = Array.from({ length: 60 }, (_, i) => ({ pnl: i % 3 === 0 ? -80 : 60 }));

  it('preserves the terminal equity when only the order is shuffled', () => {
    const mc = monteCarlo(trades, { runs: 200, startEquity: 10_000, seed: 3 });
    assert.close(mc.finalEquity.min, mc.finalEquity.max, 1e-6);
  });

  it('produces a drawdown distribution with real dispersion', () => {
    const mc = monteCarlo(trades, { runs: 500, startEquity: 10_000, seed: 5 });
    assert.ok(mc.maxDrawdown.p05 < mc.maxDrawdown.p95);
    assert.ok(mc.drawdown95 <= 0);
  });

  it('varies terminal equity under bootstrap resampling', () => {
    const mc = monteCarlo(trades, { runs: 200, startEquity: 10_000, seed: 9, resample: true });
    assert.ok(mc.finalEquity.max > mc.finalEquity.min);
  });

  it('is reproducible for a given seed', () => {
    const a = monteCarlo(trades, { runs: 100, seed: 11 });
    const b = monteCarlo(trades, { runs: 100, seed: 11 });
    assert.close(a.maxDrawdown.median, b.maxDrawdown.median, 1e-12);
  });
});

describe('backtest engine', () => {
  const candles = syntheticCandles({ bars: 900, tf: '5m', tfMsValue: 300_000, seed: 21 });

  it('runs end to end and returns a consistent equity curve', () => {
    const res = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, useForecaster: false } });
    assert.equal(res.equityCurve.length, candles.length);
    assert.ok(res.metrics.trades >= 0);
    const netFromTrades = res.trades.reduce((a, t) => a + t.pnl, 0);
    assert.close(res.equityCurve[res.equityCurve.length - 1].value, res.config.equity + netFromTrades, 1e-6);
  });

  it('never reads a bar it has not reached', () => {
    // Truncating the tail must not change decisions made before the cut.
    const a = runBacktest({ candles: candles.slice(0, 600), timeframe: '5m', config: { warmup: 260, useForecaster: false } });
    const b = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, useForecaster: false } });
    const aFirst = a.trades[0];
    const bFirst = b.trades[0];
    if (aFirst && bFirst) {
      assert.equal(aFirst.openTs, bFirst.openTs, 'the first trade must be identical');
      assert.close(aFirst.entryPrice, bFirst.entryPrice, 1e-9);
    }
  });

  it('charges fees and slippage on every trade', () => {
    const res = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, useForecaster: false } });
    for (const t of res.trades) {
      assert.ok(t.fees > 0, 'fees charged');
      assert.ok(t.slippageCost >= 0, 'slippage accounted');
    }
  });

  it('keeps every loss near the risk budget', () => {
    // Regression: sizing used to run before slippage, so a tight stop plus a
    // large fill could lose many multiples of the intended risk per trade.
    const res = runBacktest({
      candles, timeframe: '5m',
      config: { warmup: 260, useForecaster: false, equity: 10_000, riskFraction: 0.01 },
    });
    const budget = 10_000 * 0.01;
    for (const t of res.trades) {
      // Costs and a stop gapping through allow some overshoot, never a multiple.
      assert.ok(t.pnl > -budget * 3, `loss ${t.pnl.toFixed(2)} exceeds 3x the ${budget} risk budget`);
    }
  });

  it('caps position notional at the participation limit', () => {
    const res = runBacktest({
      candles, timeframe: '5m',
      config: { warmup: 260, useForecaster: false, maxParticipation: 0.05 },
    });
    for (const t of res.trades) {
      assert.ok(t.slippageBps < 200, `slippage ${t.slippageBps.toFixed(0)}bps implies an uncapped size`);
    }
  });

  it('rejects an entry whose slippage would swamp the stop', () => {
    const strict = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, useForecaster: false, maxSlippageOfRisk: 0.001 } });
    const loose = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, useForecaster: false, maxSlippageOfRisk: 10 } });
    assert.ok(strict.trades.length < loose.trades.length, 'a strict slippage budget must filter entries out');
    assert.ok(strict.rejections.some((r) => r.reason.includes('slippage')));
  });

  it('honours a long-only configuration', () => {
    const res = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, allowShort: false, useForecaster: false } });
    assert.ok(res.trades.every((t) => t.direction === 1));
  });

  it('respects max concurrent positions', () => {
    const res = runBacktest({ candles, timeframe: '5m', config: { warmup: 260, maxConcurrent: 1, useForecaster: false } });
    const sorted = [...res.trades].sort((a, b) => a.openTs - b.openTs);
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].openTs >= sorted[i - 1].closeTs, 'no overlapping positions');
    }
  });

  it('refuses a history shorter than warm-up', () => {
    assert.throws(() => runBacktest({ candles: candles.slice(0, 50), timeframe: '5m' }));
  });
});

describe('walk-forward', () => {
  it('builds a deduplicated weight grid that sums to one', () => {
    const grid = weightGrid();
    assert.ok(grid.length > 1);
    for (const w of grid) {
      assert.close(Object.values(w).reduce((a, b) => a + b, 0), 1, 0.002);
    }
  });

  it('penalizes an objective with too few trades', () => {
    const many = defaultObjective({ trades: 50, sharpe: 2, maxDrawdown: -0.1 });
    const few = defaultObjective({ trades: 2, sharpe: 2, maxDrawdown: -0.1 });
    assert.ok(many > few);
    assert.equal(defaultObjective({ trades: 0, sharpe: 5, maxDrawdown: 0 }), -Infinity);
  });

  it('splits into folds and validates out-of-sample', () => {
    const candles = syntheticCandles({ bars: 2400, tf: '5m', tfMsValue: 300_000, seed: 31 });
    const res = walkForward({
      candles, timeframe: '5m', windowMonths: 2,
      candidates: weightGrid({ steps: [0, 0.08], keys: ['orderFlow'] }),
      config: { warmup: 260, useForecaster: false },
    });
    assert.ok(res.folds.length >= 1, 'at least one fold');
    for (const f of res.folds) {
      assert.ok(f.inSampleRange[1] <= f.outSampleRange[1], 'out-of-sample ends after in-sample');
      assert.ok(f.weights);
    }
    assert.ok(res.summary.consensusWeights.orderFlow > 0);
  });
});
