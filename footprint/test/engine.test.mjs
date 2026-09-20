// Engine tests for the DOM-free half of the app: footprint construction,
// signal generation and the backtester's accounting.
//
//   node --test test/
//
// Everything runs against synthetic trades, so the tests need no network.

import test from 'node:test';
import assert from 'node:assert/strict';

import { FootprintBuilder, buildBars } from '../js/footprint.js';
import { generateSignals, DEFAULT_SIGNAL_CONFIG, RULES } from '../js/signals.js';
import { runBacktest, buyAndHold, DEFAULT_BACKTEST_CONFIG } from '../js/backtest.js';
import { atr, sma, rollingZ, pivots } from '../js/indicators.js';
import { computeStats } from '../js/stats.js';
import { decimalsFor, bucketStart, intervalMs } from '../js/util.js';

const TICK = 0.1;
const INTERVAL = 60_000;

/** Deterministic PRNG so a failure is always reproducible. */
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Synthetic aggregated trades: a drifting random walk on a tick grid. */
function syntheticTrades({ count = 20_000, start = 1_700_000_000_000, price = 30_000, seed = 7 } = {}) {
  const rand = rng(seed);
  const trades = [];
  let p = price;
  let t = start;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 900) * 0.6;
    const step = (rand() - 0.5 + drift * 0.08) * 6 * TICK;
    p = Math.max(TICK, p + step);
    const gridded = Math.round(p / TICK) * TICK;
    t += Math.max(1, Math.round(rand() * 400));
    trades.push({
      a: i,
      p: Number(gridded.toFixed(4)),
      q: Number((0.001 + rand() * 0.9).toFixed(6)),
      T: t,
      m: rand() < 0.5 - drift * 0.05,
    });
  }
  return trades;
}

const TRADES = syntheticTrades();
const BARS = buildBars(TRADES, { tickSize: TICK, intervalMs: INTERVAL, config: { rowTicks: 2 } });

/* ------------------------------------------------------------- util basics */

test('decimalsFor derives display precision from a tick size', () => {
  assert.equal(decimalsFor(0.01), 2);
  assert.equal(decimalsFor(0.1), 1);
  assert.equal(decimalsFor(1), 0);
  assert.equal(decimalsFor(0.00001), 5);
  assert.equal(decimalsFor(0.00000001), 8);
});

test('bucketStart aligns to the interval grid', () => {
  assert.equal(bucketStart(1_700_000_061_234, 60_000), 1_700_000_040_000);
  assert.equal(bucketStart(1_700_000_060_000, 60_000), 1_700_000_040_000);
  assert.equal(intervalMs('4h'), 4 * 3_600_000);
});

/* ------------------------------------------------------------- footprint */

test('bars cover every trade exactly once', () => {
  const total = BARS.reduce((s, b) => s + b.trades, 0);
  assert.equal(total, TRADES.length);
  assert.ok(BARS.length > 20, `expected a meaningful number of bars, got ${BARS.length}`);
});

test('bar OHLC and volume match the trades that built them', () => {
  const byBar = new Map();
  for (const t of TRADES) {
    const k = bucketStart(t.T, INTERVAL);
    if (!byBar.has(k)) byBar.set(k, []);
    byBar.get(k).push(t);
  }
  for (const bar of BARS) {
    const group = byBar.get(bar.openTime);
    assert.ok(group, `no trades for bar at ${bar.openTime}`);
    assert.equal(bar.open, group[0].p);
    assert.equal(bar.close, group[group.length - 1].p);
    assert.equal(bar.high, Math.max(...group.map((t) => t.p)));
    assert.equal(bar.low, Math.min(...group.map((t) => t.p)));
    const vol = group.reduce((s, t) => s + t.q, 0);
    assert.ok(Math.abs(bar.volume - vol) < 1e-9, `volume mismatch: ${bar.volume} vs ${vol}`);
  }
});

test('row volumes sum to bar volume and split bid/ask correctly', () => {
  for (const bar of BARS) {
    let bid = 0;
    let ask = 0;
    for (const row of bar.rows.values()) { bid += row.bid; ask += row.ask; }
    assert.ok(Math.abs(bid - bar.bidVolume) < 1e-9);
    assert.ok(Math.abs(ask - bar.askVolume) < 1e-9);
    assert.ok(Math.abs(bid + ask - bar.volume) < 1e-9);
    assert.ok(Math.abs(bar.delta - (bar.askVolume - bar.bidVolume)) < 1e-9);
  }
});

test('trade classification follows the maker flag', () => {
  const bar = buildBars([
    { a: 1, p: 100, q: 2, T: 0, m: true },   // buyer was maker -> aggressive sell -> bid
    { a: 2, p: 100, q: 5, T: 1, m: false },  // aggressive buy -> ask
  ], { tickSize: 1, intervalMs: INTERVAL, config: { rowTicks: 1 } })[0];
  assert.equal(bar.bidVolume, 2);
  assert.equal(bar.askVolume, 5);
  assert.equal(bar.delta, 3);
  assert.equal(bar.rows.get(100).bid, 2);
  assert.equal(bar.rows.get(100).ask, 5);
});

test('POC is the heaviest row and the value area contains it', () => {
  for (const bar of BARS) {
    let heaviest = -1;
    for (const row of bar.rows.values()) heaviest = Math.max(heaviest, row.bid + row.ask);
    assert.ok(Math.abs(bar.pocVolume - heaviest) < 1e-9);
    assert.ok(bar.valRow <= bar.pocRow && bar.pocRow <= bar.vahRow);
    assert.ok(bar.valPrice <= bar.pocPrice && bar.pocPrice <= bar.vahPrice);
    assert.ok(bar.valPrice >= bar.low - bar.rowSize && bar.vahPrice <= bar.high + bar.rowSize);
  }
});

test('value area holds at least the configured share of volume', () => {
  for (const bar of BARS) {
    if (bar.rowCount < 4) continue;
    let inside = 0;
    for (const [i, row] of bar.rows) {
      if (i >= bar.valRow && i <= bar.vahRow) inside += row.bid + row.ask;
    }
    // The area grows in pairs, so it can overshoot but must never undershoot
    // unless it already spans the whole bar.
    const spansAll = bar.valRow <= bar.lowRow && bar.vahRow >= bar.highRow;
    assert.ok(spansAll || inside >= bar.volume * 0.7 - 1e-9,
      `value area holds ${inside} of ${bar.volume}`);
  }
});

test('imbalances obey the diagonal ratio rule', () => {
  const bars = buildBars([
    // row 100: bid 1 ; row 101: ask 10  -> buy imbalance at 101 (10 >= 3 * 1)
    { a: 1, p: 100, q: 1, T: 0, m: true },
    { a: 2, p: 101, q: 10, T: 1, m: false },
  ], { tickSize: 1, intervalMs: INTERVAL, config: { rowTicks: 1, imbalanceRatio: 3 } });
  const bar = bars[0];
  assert.equal(bar.imbalances.get(101)?.buy, true);
  assert.ok(!bar.imbalances.get(100)?.sell);
});

test('stacked imbalances need consecutive rows', () => {
  const trades = [];
  let id = 0;
  // Build three stacked buy imbalances across rows 101-103.
  for (const p of [100, 101, 102]) trades.push({ a: id++, p, q: 1, T: id, m: true });
  for (const p of [101, 102, 103]) trades.push({ a: id++, p, q: 20, T: id, m: false });
  const bar = buildBars(trades, {
    tickSize: 1, intervalMs: INTERVAL, config: { rowTicks: 1, imbalanceRatio: 3, stackLength: 3 },
  })[0];
  assert.equal(bar.buyStacks.length, 1);
  assert.equal(bar.buyStacks[0].count, 3);
  assert.equal(bar.buyStacks[0].fromRow, 101);
  assert.equal(bar.buyStacks[0].toRow, 103);
});

test('cumulative delta is the running sum of bar deltas', () => {
  let acc = 0;
  for (const bar of BARS) {
    acc += bar.delta;
    assert.ok(Math.abs(bar.cumDelta - acc) < 1e-6, `cumDelta drifted at bar ${bar.index}`);
  }
});

test('streaming trades one at a time matches a bulk rebuild', () => {
  const builder = new FootprintBuilder({ tickSize: TICK, intervalMs: INTERVAL, config: { rowTicks: 2 } });
  for (const t of TRADES) builder.addTrade(t);
  const streamed = builder.flush();
  assert.equal(streamed.length, BARS.length);
  for (let i = 0; i < streamed.length; i++) {
    assert.equal(streamed[i].close, BARS[i].close);
    assert.ok(Math.abs(streamed[i].delta - BARS[i].delta) < 1e-9);
    assert.equal(streamed[i].pocRow, BARS[i].pocRow);
  }
});

/* ------------------------------------------------------------- indicators */

test('ATR is positive once seeded and NaN before', () => {
  const a = atr(BARS, 14);
  assert.ok(Number.isNaN(a[12]));
  for (let i = 13; i < a.length; i++) assert.ok(a[i] > 0, `ATR not positive at ${i}`);
});

test('SMA of a constant series is that constant', () => {
  const v = new Array(30).fill(5);
  const s = sma(v, 10);
  assert.ok(Math.abs(s[29] - 5) < 1e-12);
  assert.ok(Number.isNaN(s[3]));
});

test('rolling z-score is zero for a flat series and finite otherwise', () => {
  const flat = rollingZ(new Array(40).fill(3), 10);
  assert.ok(Number.isNaN(flat[20]) || flat[20] === 0);
  const z = rollingZ(BARS.map((b) => b.volume), 20);
  assert.ok(z.slice(25).some(Number.isFinite));
});

test('pivots only mark strict local extremes', () => {
  const p = pivots(BARS, 2, 2);
  for (let i = 0; i < BARS.length; i++) {
    if (!p.highs[i]) continue;
    for (let j = i - 2; j <= i + 2; j++) {
      if (j === i) continue;
      assert.ok(BARS[j].high < BARS[i].high);
    }
  }
});

/* ---------------------------------------------------------------- signals */

const SIGNAL_CFG = {
  ...DEFAULT_SIGNAL_CONFIG,
  threshold: 0.6,
  cooldownBars: 1,
  rules: Object.fromEntries(RULES.map((r) => [r.id, {
    enabled: true,
    weight: r.weight,
    params: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, v.value])),
  }])),
};

test('signals are produced and well-formed', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  assert.ok(signals.length > 0, 'expected at least one signal from synthetic data');
  for (const s of signals) {
    assert.ok(s.side === 'long' || s.side === 'short');
    assert.ok(Number.isFinite(s.score) && s.score > 0);
    assert.ok(s.barIndex >= 0 && s.barIndex < BARS.length);
    assert.equal(s.time, BARS[s.barIndex].closeTime);
    assert.equal(s.price, BARS[s.barIndex].close);
    assert.ok(Array.isArray(s.reasons) && s.reasons.length > 0);
  }
});

test('signals never look ahead: a prefix of the data yields the same signals', () => {
  const full = generateSignals(BARS, SIGNAL_CFG);
  const cut = Math.floor(BARS.length * 0.6);
  const prefix = generateSignals(BARS.slice(0, cut), SIGNAL_CFG);
  const fullPrefix = full.filter((s) => s.barIndex < cut);

  assert.equal(prefix.length, fullPrefix.length,
    `prefix produced ${prefix.length} signals but the full run produced ${fullPrefix.length} over the same bars`);
  for (let i = 0; i < prefix.length; i++) {
    assert.equal(prefix[i].barIndex, fullPrefix[i].barIndex);
    assert.equal(prefix[i].side, fullPrefix[i].side);
    assert.equal(prefix[i].type, fullPrefix[i].type);
    assert.equal(prefix[i].score, fullPrefix[i].score);
  }
});

test('the cooldown is respected per side', () => {
  const cfg = { ...SIGNAL_CFG, cooldownBars: 5 };
  const signals = generateSignals(BARS, cfg);
  const last = { long: -Infinity, short: -Infinity };
  for (const s of signals) {
    assert.ok(s.barIndex - last[s.side] >= 5, `cooldown violated at bar ${s.barIndex}`);
    last[s.side] = s.barIndex;
  }
});

test('disabling every rule produces no signals', () => {
  const cfg = {
    ...SIGNAL_CFG,
    rules: Object.fromEntries(Object.entries(SIGNAL_CFG.rules).map(([k, v]) => [k, { ...v, enabled: false }])),
  };
  assert.equal(generateSignals(BARS, cfg).length, 0);
});

test('the trend filter only admits signals on the right side of the EMA', () => {
  const withTrend = generateSignals(BARS, { ...SIGNAL_CFG, trendFilter: 'with', trendPeriod: 10 });
  const against = generateSignals(BARS, { ...SIGNAL_CFG, trendFilter: 'against', trendPeriod: 10 });
  const off = generateSignals(BARS, { ...SIGNAL_CFG, trendFilter: 'off', trendPeriod: 10 });
  assert.ok(withTrend.length <= off.length);
  assert.ok(against.length <= off.length);
});

/* --------------------------------------------------------------- backtest */

const BT_CFG = {
  ...DEFAULT_BACKTEST_CONFIG,
  initialCapital: 10_000,
  riskPct: 1,
  maxBars: 20,
  oosSplitPct: 70,
};

test('backtest books a coherent set of trades', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  assert.ok(res.trades.length > 0, 'expected trades from the synthetic run');

  for (const t of res.trades) {
    assert.ok(t.exitBar >= t.entryBar, 'exit precedes entry');
    assert.ok(t.entryTime >= t.signalTime, 'filled before the signal existed');
    assert.ok(t.qty > 0 && Number.isFinite(t.qty));
    assert.ok(t.fees >= 0);
    const dir = t.side === 'long' ? 1 : -1;
    const expectedGross = (t.exitPrice - t.entryPrice) * t.qty * dir;
    assert.ok(Math.abs(t.gross - expectedGross) < 1e-6, 'gross P&L does not match the fill prices');
    assert.ok(Math.abs(t.pnl - (t.gross - t.fees)) < 1e-6, 'net P&L does not equal gross minus fees');
  }
});

test('one position at a time — trades never overlap', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  for (let i = 1; i < res.trades.length; i++) {
    assert.ok(res.trades[i].entryBar >= res.trades[i - 1].exitBar,
      `trade ${res.trades[i].id} opened at bar ${res.trades[i].entryBar} before trade ${res.trades[i - 1].id} closed at ${res.trades[i - 1].exitBar}`);
  }
});

test('equity accounting reconciles: initial + Σ P&L = final', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  const sum = res.trades.reduce((s, t) => s + t.pnl, 0);
  assert.ok(Math.abs(res.stats.finalEquity - (BT_CFG.initialCapital + sum)) < 1e-6);

  let running = BT_CFG.initialCapital;
  for (const t of res.trades) {
    running += t.pnl;
    assert.ok(Math.abs(t.equityAfter - running) < 1e-6, `equityAfter drifted on trade ${t.id}`);
  }
});

test('entries fill on the bar after the signal by default', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  for (const t of res.trades) {
    const sigBar = BARS.findIndex((b) => b.closeTime === t.signalTime);
    assert.ok(t.entryBar > sigBar, `trade ${t.id} filled on the signal bar itself`);
    assert.equal(t.entryTime, BARS[t.entryBar].openTime);
  }
});

test('stop and target fills land on the correct side of the entry', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, {
    tickSize: TICK,
    intervalMs: INTERVAL,
    config: { ...BT_CFG, trailMode: 'off', slippageTicks: 0 },
  });
  for (const t of res.trades) {
    const dir = t.side === 'long' ? 1 : -1;
    if (t.exitReason === 'target') {
      assert.ok((t.exitPrice - t.entryPrice) * dir > 0, `target exit on trade ${t.id} was not in profit`);
      assert.ok(Math.abs(t.exitPrice - t.targetPrice) < 1e-6);
    }
    if (t.exitReason === 'stop') {
      assert.ok((t.exitPrice - t.entryPrice) * dir < 0, `stop exit on trade ${t.id} was not a loss`);
    }
  }
});

test('pessimistic fills never beat optimistic fills', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const pess = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, pessimisticFills: true } });
  const opt = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, pessimisticFills: false } });
  assert.ok(opt.stats.netProfit >= pess.stats.netProfit - 1e-6,
    `optimistic ${opt.stats.netProfit} should not be worse than pessimistic ${pess.stats.netProfit}`);
});

test('higher fees never improve the result', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const cheap = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, feeBps: 0, sizing: 'fixedQty', fixedQty: 0.01 } });
  const dear = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, feeBps: 50, sizing: 'fixedQty', fixedQty: 0.01 } });
  assert.ok(dear.stats.netProfit <= cheap.stats.netProfit + 1e-9);
  assert.ok(dear.stats.fees > cheap.stats.fees);
});

test('direction filters restrict the trades taken', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const longs = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, direction: 'long' } });
  assert.ok(longs.trades.every((t) => t.side === 'long'));
  const shorts = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, direction: 'short' } });
  assert.ok(shorts.trades.every((t) => t.side === 'short'));
});

test('the time stop caps holding period', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: { ...BT_CFG, maxBars: 5 } });
  for (const t of res.trades) assert.ok(t.bars <= 5, `trade ${t.id} held ${t.bars} bars`);
});

test('the in-sample / out-of-sample split partitions the trades', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  assert.ok(res.segments, 'expected segment stats when oosSplitPct is set');
  const inS = res.trades.filter((t) => t.segment === 'in-sample').length;
  const outS = res.trades.filter((t) => t.segment === 'out-of-sample').length;
  assert.equal(inS + outS, res.trades.length);
  assert.equal(res.segments.inSample.trades, inS);
  assert.equal(res.segments.outOfSample.trades, outS);
});

test('positions clipped by the notional cap are flagged, not silently shrunk', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  // 50% risk on a tight ATR stop asks for far more notional than the account has.
  const res = runBacktest(BARS, signals, {
    tickSize: TICK,
    intervalMs: INTERVAL,
    config: { ...BT_CFG, sizing: 'risk', riskPct: 50, maxNotionalPct: 100 },
  });
  assert.ok(res.cappedTrades > 0, 'expected the notional cap to bind');
  assert.ok(res.warnings.some((w) => w.includes('max-notional')), 'expected a warning about the cap');
  for (const t of res.trades) {
    assert.ok(t.notional <= t.equityAfter - t.pnl + 1e-6 || t.notional <= BT_CFG.initialCapital * 1.001,
      `trade ${t.id} exceeded the notional cap`);
  }

  // A generous cap should bind far less often.
  const loose = runBacktest(BARS, signals, {
    tickSize: TICK,
    intervalMs: INTERVAL,
    config: { ...BT_CFG, sizing: 'risk', riskPct: 0.1, maxNotionalPct: 100 },
  });
  assert.ok(loose.cappedTrades <= res.cappedTrades);
});

test('fixed-quantity sizing ignores equity and the risk model', () => {
  const signals = generateSignals(BARS, SIGNAL_CFG);
  const res = runBacktest(BARS, signals, {
    tickSize: TICK,
    intervalMs: INTERVAL,
    config: { ...BT_CFG, sizing: 'fixedQty', fixedQty: 0.005, maxNotionalPct: 1000 },
  });
  for (const t of res.trades) assert.ok(Math.abs(t.qty - 0.005) < 1e-12, `trade ${t.id} sized ${t.qty}`);
});

test('no signals means no trades and a flat curve', () => {
  const res = runBacktest(BARS, [], { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  assert.equal(res.trades.length, 0);
  assert.equal(res.stats.netProfit, 0);
  assert.ok(res.curve.every((p) => Math.abs(p.equity - BT_CFG.initialCapital) < 1e-9));
});

test('an empty bar series does not throw', () => {
  const res = runBacktest([], [], { tickSize: TICK, intervalMs: INTERVAL, config: BT_CFG });
  assert.equal(res.trades.length, 0);
  assert.equal(res.curve.length, 0);
  assert.equal(buyAndHold([], 10_000).curve.length, 0);
});

/* ------------------------------------------------------------------ stats */

test('stats match a hand-computed set of trades', () => {
  const trades = [
    { pnl: 100, r: 2, bars: 3, fees: 1, entryTime: 0, exitTime: 3 },
    { pnl: -50, r: -1, bars: 2, fees: 1, entryTime: 4, exitTime: 6 },
    { pnl: 200, r: 4, bars: 5, fees: 1, entryTime: 7, exitTime: 12 },
    { pnl: -50, r: -1, bars: 1, fees: 1, entryTime: 13, exitTime: 14 },
  ];
  const curve = [
    { time: 0, equity: 1000 },
    { time: 1, equity: 1100 },
    { time: 2, equity: 1050 },
    { time: 3, equity: 1250 },
    { time: 4, equity: 1200 },
  ];
  const s = computeStats(trades, curve, { initialCapital: 1000, intervalMs: 60_000, barsInMarket: 11, totalBars: 15 });
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.winRate, 50);
  assert.equal(s.netProfit, 200);
  assert.equal(s.grossProfit, 300);
  assert.equal(s.grossLoss, 100);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.expectancy, 50);
  assert.equal(s.expectancyR, 1);
  assert.equal(s.maxConsecWins, 1);
  assert.equal(s.maxConsecLosses, 1);
  assert.equal(s.bestTrade, 200);
  assert.equal(s.worstTrade, -50);
  // Two $50 dips: 1100 -> 1050 (4.545%) and 1250 -> 1200 (4.0%). The deeper one
  // in percentage terms wins, and the absolute figure comes from that same episode.
  assert.ok(Math.abs(s.maxDrawdown - 50) < 1e-9);
  assert.ok(Math.abs(s.maxDrawdownPct - (50 / 1100) * 100) < 1e-9);
});

test('buy and hold tracks the close', () => {
  const bh = buyAndHold(BARS, 10_000);
  const expected = (10_000 / BARS[0].open) * BARS[BARS.length - 1].close;
  assert.ok(Math.abs(bh.curve[bh.curve.length - 1].equity - expected) < 1e-6);
});

test('suggestRowTicks sizes rows from the data, not the price', async () => {
  const { suggestRowTicks } = await import('../js/footprint.js');
  const r = suggestRowTicks(TRADES, { tickSize: TICK, intervalMs: INTERVAL, targetRows: 10 });
  assert.ok(r >= 1 && Number.isInteger(r));
  const bars = buildBars(TRADES, { tickSize: TICK, intervalMs: INTERVAL, config: { rowTicks: r } });
  const rows = bars.map((b) => b.rowCount).sort((a, b) => a - b);
  const median = rows[Math.floor(rows.length / 2)];
  assert.ok(median >= 4 && median <= 30, `median rows per bar was ${median}, expected roughly ten`);
  assert.equal(suggestRowTicks([], { tickSize: TICK, intervalMs: INTERVAL }), 1);
});

/* ------------------------------------------------- per-rule trigger proofs */
//
// Each rule gets a hand-built bar series that provably exhibits the pattern it
// claims to find. Random-walk data has almost no footprint structure, so
// without these a rule could quietly never fire and every aggregate test would
// still pass.

/** Build bars from an explicit list of fills per bar: [price, qty, isAggressiveSell]. */
function mkBars(spec, { tickSize = 1, rowTicks = 1, config = {} } = {}) {
  const trades = [];
  let id = 0;
  spec.forEach((fills, bi) => {
    const base = bi * INTERVAL;
    fills.forEach(([p, q, sell], k) => {
      trades.push({ a: id++, p, q, T: base + k + 1, m: !!sell });
    });
  });
  return buildBars(trades, { tickSize, intervalMs: INTERVAL, config: { rowTicks, ...config } });
}

/**
 * Run the provider with exactly one rule enabled. The rules map is built in
 * full — a partial map would be merged over the defaults, silently leaving the
 * default-enabled rules switched on.
 */
function fireOnly(ruleId, bars, paramOverrides = {}) {
  const rules = Object.fromEntries(RULES.map((r) => [r.id, {
    enabled: r.id === ruleId,
    weight: 1,
    params: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, v.value])),
  }]));
  Object.assign(rules[ruleId].params, paramOverrides);
  return generateSignals(bars, {
    ...DEFAULT_SIGNAL_CONFIG,
    mode: 'any',
    cooldownBars: 0,
    minVolumeZ: -5,
    trendFilter: 'off',
    rules,
  });
}

/** A filler bar that trades flat at one price, so it never triggers anything. */
const flat = (price, n = 4) => Array.from({ length: n }, (_, k) => [price, 1, k % 2 === 0]);

test('rule: stacked imbalance fires long on a buy stack at the low', () => {
  const bars = mkBars([[
    [100, 1, true], [101, 1, true], [102, 1, true],      // thin bid rows 100-102
    [101, 20, false], [102, 20, false], [103, 20, false], // heavy ask rows 101-103
  ]]);
  assert.equal(bars[0].buyStacks.length, 1, 'expected the bar to carry one buy stack');
  const signals = fireOnly('stackedImbalance', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'long');
  assert.match(signals[0].reasons[0], /stacked buy imbalances/);
});

test('rule: stacked imbalance fires short on a sell stack at the high', () => {
  const bars = mkBars([[
    [103, 1, false], [102, 1, false], [101, 1, false],
    [102, 20, true], [101, 20, true], [100, 20, true],
  ]]);
  assert.equal(bars[0].sellStacks.length, 1);
  const signals = fireOnly('stackedImbalance', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'short');
});

test('rule: delta divergence fires long on a lower low with better delta', () => {
  const spec = [];
  for (let i = 0; i < 12; i++) spec.push(flat(200));
  spec[6] = [[200, 1, false], [190, 100, true], [195, 1, true]];        // swing low, delta -102
  spec.push([[195, 50, false], [189, 50, true], [193, 1, false]]);      // lower low, delta ~0
  const bars = mkBars(spec);
  const signals = fireOnly('deltaDivergence', bars);
  const last = signals.filter((s) => s.barIndex === bars.length - 1);
  assert.equal(last.length, 1, `expected a divergence on the final bar, got ${JSON.stringify(signals)}`);
  assert.equal(last[0].side, 'long');
  assert.match(last[0].reasons[0], /lower low on higher delta/);
});

test('rule: delta divergence fires short on a higher high with worse delta', () => {
  const spec = [];
  for (let i = 0; i < 12; i++) spec.push(flat(200));
  spec[6] = [[200, 1, true], [210, 100, false], [205, 1, false]];       // swing high, delta +102
  spec.push([[205, 50, true], [211, 50, false], [207, 1, true]]);       // higher high, delta ~0
  const bars = mkBars(spec);
  const last = fireOnly('deltaDivergence', bars).filter((s) => s.barIndex === bars.length - 1);
  assert.equal(last.length, 1);
  assert.equal(last[0].side, 'short');
});

test('rule: absorption fires long when selling at the low is soaked up', () => {
  const bars = mkBars([[
    [102, 1, false],
    [100, 50, true], [100, 1, false],                     // heavy, bid-dominated low row
    [101, 5, false], [102, 5, false], [103, 5, false], [104, 5, false],
    [103, 1, false],                                      // close in the upper part
  ]]);
  const bar = bars[0];
  assert.ok(bar.lowRowVolume >= 2.5 * bar.avgRowVolume, 'low row is not an outsized node');
  assert.ok(bar.closeLocation >= 0.55, `close location was ${bar.closeLocation}`);
  const signals = fireOnly('absorption', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'long');
  assert.match(signals[0].reasons[0], /absorbed at the low/);
});

test('rule: absorption fires short when buying at the high is soaked up', () => {
  const bars = mkBars([[
    [102, 1, true],
    [104, 50, false], [104, 1, true],
    [103, 5, true], [102, 5, true], [101, 5, true], [100, 5, true],
    [101, 1, true],
  ]]);
  const signals = fireOnly('absorption', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'short');
});

test('rule: trapped aggressors fires long on negative delta closing at the high', () => {
  const bars = mkBars([[
    [102, 1, true],
    [100, 30, true], [101, 30, true],     // 60 sold into the bid
    [102, 20, false], [103, 20, false],   // 40 bought
    [104, 1, false],                      // closes on the high
  ]]);
  const bar = bars[0];
  assert.ok(bar.deltaPct <= -0.15, `deltaPct was ${bar.deltaPct}`);
  assert.ok(bar.closeLocation >= 0.67);
  const signals = fireOnly('trappedTraders', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'long');
  assert.match(signals[0].reasons[0], /sellers trapped/);
});

test('rule: trapped aggressors fires short on positive delta closing at the low', () => {
  const bars = mkBars([[
    [102, 1, false],
    [104, 30, false], [103, 30, false],
    [102, 20, true], [101, 20, true],
    [100, 1, true],
  ]]);
  const signals = fireOnly('trappedTraders', bars);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].side, 'short');
});

test('rule: exhaustion tail fires long on a new low with a hollow tip', () => {
  const spec = [];
  for (let i = 0; i < 16; i++) spec.push(flat(200));
  const tail = [[200, 1, true], [195, 0.1, true]];                       // the hollow tip
  for (let p = 196; p <= 205; p++) tail.push([p, 10, p % 2 === 0]);
  spec.push(tail);
  const bars = mkBars(spec);
  const bar = bars[bars.length - 1];
  assert.ok(bar.rowCount >= 5);
  assert.ok(bar.lowRowVolume <= 0.35 * bar.avgRowVolume, 'tip is not hollow enough');
  const last = fireOnly('exhaustionTail', bars).filter((s) => s.barIndex === bars.length - 1);
  assert.equal(last.length, 1);
  assert.equal(last[0].side, 'long');
});

test('rule: value migration fires long on rising POCs with buying cum-delta', () => {
  const spec = [];
  for (let p = 100; p <= 103; p++) {
    spec.push([[p, 40, false], [p, 2, true], [p + 1, 1, false]]);        // POC steps up each bar
  }
  const bars = mkBars(spec);
  for (let i = 1; i < bars.length; i++) {
    assert.ok(bars[i].pocPrice > bars[i - 1].pocPrice, `POC did not step up at bar ${i}`);
  }
  const last = fireOnly('valueMigration', bars).filter((s) => s.barIndex === bars.length - 1);
  assert.equal(last.length, 1);
  assert.equal(last[0].side, 'long');
});

test('rule: delta flip fires long when delta reverses inside prior value', () => {
  const bars = mkBars([
    [[100, 8, true], [101, 8, true], [102, 8, true], [103, 8, true], [104, 8, true],
      [100, 2, false], [101, 2, false], [102, 2, false], [103, 2, false], [104, 2, false]],
    [[102, 20, false], [103, 20, false], [103, 1, false]],
  ]);
  assert.ok(bars[0].deltaPct <= -0.08);
  assert.ok(bars[1].deltaPct >= 0.08);
  assert.ok(bars[1].close >= bars[0].valPrice && bars[1].close <= bars[0].vahPrice, 'close is outside prior value');
  const last = fireOnly('deltaFlip', bars).filter((s) => s.barIndex === 1);
  assert.equal(last.length, 1);
  assert.equal(last[0].side, 'long');
});

test('every registered rule has a proof that it can fire', () => {
  // Guards against a rule being added to the registry with no trigger test.
  const proven = new Set([
    'stackedImbalance', 'deltaDivergence', 'absorption',
    'trappedTraders', 'exhaustionTail', 'valueMigration', 'deltaFlip',
  ]);
  for (const r of RULES) {
    assert.ok(proven.has(r.id), `rule "${r.id}" has no trigger test — add one to this file`);
  }
});
