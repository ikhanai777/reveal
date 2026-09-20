// Event-driven backtester over footprint bars.
//
// Execution model, stated plainly because every assumption here flatters or
// punishes the results:
//
//  * A signal is produced at the CLOSE of bar i and filled at the OPEN of bar
//    i+1 (default). "At signal close" is available but is an optimistic fill.
//  * Entries and market exits pay `slippageTicks`; limit targets fill at the
//    target price exactly.
//  * When a bar's range contains both the stop and the target, the ORDER IS
//    UNKNOWABLE from bar data. `pessimisticFills` (default on) assumes the stop
//    filled first. Turning it off flatters every result — it is there to measure
//    the size of that ambiguity, not to produce a better number.
//  * Gaps through a stop fill at the open, not at the stop price.
//  * One position at a time; no pyramiding.

import { atr as atrSeries } from './indicators.js';
import { computeStats, breakdown } from './stats.js';

export const DEFAULT_BACKTEST_CONFIG = {
  initialCapital: 10_000,
  direction: 'both',          // 'both' | 'long' | 'short'
  entry: 'nextOpen',          // 'nextOpen' | 'signalClose'

  sizing: 'risk',             // 'risk' | 'fixedNotional' | 'fixedQty'
  riskPct: 1,                 // % of equity risked per trade when sizing = risk
  fixedNotional: 1000,
  fixedQty: 0.01,
  maxNotionalPct: 100,        // cap position notional at % of equity

  stopMode: 'atr',            // 'atr' | 'ticks' | 'percent' | 'barExtreme'
  stopAtr: 1.5,
  stopTicks: 50,
  stopPct: 0.4,
  stopBufferTicks: 2,         // extra room beyond the bar extreme

  targetMode: 'rr',           // 'rr' | 'atr' | 'ticks' | 'percent' | 'none'
  targetR: 2,
  targetAtr: 3,
  targetTicks: 100,
  targetPct: 0.8,

  trailMode: 'off',           // 'off' | 'atr' | 'priorBar' | 'breakeven'
  trailAtr: 2,
  breakevenAtR: 1,            // move stop to entry once this much R is banked

  maxBars: 30,                // time stop (0 = disabled)
  exitOnOpposite: true,

  feeBps: 10,                 // per side; Binance spot taker is 10 bps
  slippageTicks: 1,
  pessimisticFills: true,

  atrPeriod: 14,
  oosSplitPct: 0,             // 0 = no split; else % of the range used in-sample
};

const dirOf = (side) => (side === 'long' ? 1 : -1);

function initialStop(bar, side, cfg, atrVal, tickSize) {
  const dir = dirOf(side);
  const price = bar.close;
  switch (cfg.stopMode) {
    case 'ticks':
      return price - dir * cfg.stopTicks * tickSize;
    case 'percent':
      return price * (1 - dir * cfg.stopPct / 100);
    case 'barExtreme':
      return side === 'long'
        ? bar.low - cfg.stopBufferTicks * tickSize
        : bar.high + cfg.stopBufferTicks * tickSize;
    case 'atr':
    default: {
      const a = Number.isFinite(atrVal) && atrVal > 0 ? atrVal : Math.max(bar.range, tickSize * 10);
      return price - dir * cfg.stopAtr * a;
    }
  }
}

function initialTarget(entryPrice, stopPrice, side, cfg, atrVal, tickSize) {
  const dir = dirOf(side);
  const risk = Math.abs(entryPrice - stopPrice);
  switch (cfg.targetMode) {
    case 'none':
      return null;
    case 'atr': {
      const a = Number.isFinite(atrVal) && atrVal > 0 ? atrVal : risk;
      return entryPrice + dir * cfg.targetAtr * a;
    }
    case 'ticks':
      return entryPrice + dir * cfg.targetTicks * tickSize;
    case 'percent':
      return entryPrice * (1 + dir * cfg.targetPct / 100);
    case 'rr':
    default:
      return entryPrice + dir * cfg.targetR * risk;
  }
}

/**
 * @param bars     finalised footprint bars
 * @param signals  output of generateSignals()
 * @param opts     { tickSize, intervalMs, config }
 */
export function runBacktest(bars, signals, { tickSize = 0.01, intervalMs = 60_000, config = {} } = {}) {
  const cfg = { ...DEFAULT_BACKTEST_CONFIG, ...config };
  const atrVals = atrSeries(bars, cfg.atrPeriod);
  const slip = cfg.slippageTicks * tickSize;
  const feeRate = cfg.feeBps / 10_000;

  const signalsByBar = new Map();
  for (const s of signals) {
    if (cfg.direction !== 'both' && s.side !== cfg.direction) continue;
    if (!signalsByBar.has(s.barIndex)) signalsByBar.set(s.barIndex, s);
  }

  const trades = [];
  const curve = [];
  const rejected = [];
  let equity = cfg.initialCapital;
  let position = null;
  let pending = null;
  let barsInMarket = 0;

  const closeTrade = (exitPrice, exitTime, reason, barIndex) => {
    const dir = dirOf(position.side);
    const exitFee = Math.abs(exitPrice * position.qty) * feeRate;
    const gross = (exitPrice - position.entryPrice) * position.qty * dir;
    const fees = position.entryFee + exitFee;
    const pnl = gross - fees;
    equity += pnl;
    const riskAmount = position.riskPerUnit * position.qty;
    trades.push({
      id: trades.length + 1,
      side: position.side,
      type: position.signal.type,
      label: position.signal.label,
      score: position.signal.score,
      reasons: position.signal.reasons,
      signalTime: position.signal.time,
      entryTime: position.entryTime,
      entryBar: position.entryBar,
      entryPrice: position.entryPrice,
      exitTime,
      exitBar: barIndex,
      exitPrice,
      exitReason: reason,
      qty: position.qty,
      notional: position.qty * position.entryPrice,
      stopPrice: position.initialStop,
      targetPrice: position.target,
      gross,
      fees,
      pnl,
      r: riskAmount > 0 ? pnl / riskAmount : NaN,
      bars: barIndex - position.entryBar + 1,
      equityAfter: equity,
      segment: position.segment,
      capped: !!position.capped,
      riskAmount,
      riskPctActual: equity > 0 ? (riskAmount / (equity - pnl)) * 100 : NaN,
      feePctOfRisk: riskAmount > 0 ? (fees / riskAmount) * 100 : NaN,
    });
    position = null;
  };

  const splitIdx = cfg.oosSplitPct > 0
    ? Math.floor(bars.length * (cfg.oosSplitPct / 100))
    : bars.length;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar.closed) continue;

    // --- 1. Fill a pending entry at this bar's open.
    if (pending && !position) {
      const side = pending.side;
      const dir = dirOf(side);
      const entryPrice = bar.open + dir * slip;
      const stopPrice = pending.stopPrice;
      const riskPerUnit = Math.abs(entryPrice - stopPrice);

      if (riskPerUnit <= 0) {
        rejected.push({ time: bar.openTime, reason: 'zero risk distance', signal: pending.signal });
      } else {
        let qty;
        if (cfg.sizing === 'fixedQty') qty = cfg.fixedQty;
        else if (cfg.sizing === 'fixedNotional') qty = cfg.fixedNotional / entryPrice;
        else qty = (equity * cfg.riskPct / 100) / riskPerUnit;

        // A tight stop plus a high risk-% asks for more notional than an
        // unlevered account has. Clipping here is correct, but it quietly
        // shrinks the real risk per trade, so the clip is recorded and
        // surfaced rather than swallowed.
        const maxQty = (equity * cfg.maxNotionalPct / 100) / entryPrice;
        const capped = qty > maxQty;
        if (capped) qty = maxQty;

        if (!(qty > 0) || !Number.isFinite(qty)) {
          rejected.push({ time: bar.openTime, reason: 'position size rounded to zero', signal: pending.signal });
        } else {
          const target = initialTarget(entryPrice, stopPrice, side, cfg, atrVals[pending.barIndex], tickSize);
          // Both legs' fees are settled when the trade closes.
          const entryFee = Math.abs(entryPrice * qty) * feeRate;
          position = {
            side,
            qty,
            entryPrice,
            entryTime: bar.openTime,
            entryBar: i,
            stop: stopPrice,
            initialStop: stopPrice,
            target,
            riskPerUnit,
            entryFee,
            signal: pending.signal,
            segment: i < splitIdx ? 'in-sample' : 'out-of-sample',
            capped,
            peak: entryPrice,
            trough: entryPrice,
          };
        }
      }
      pending = null;
    }

    // --- 2. Manage an open position inside this bar.
    if (position) {
      barsInMarket++;
      const dir = dirOf(position.side);
      const long = position.side === 'long';

      // Gap through the stop: the open is the first tradeable price.
      const gapped = long ? bar.open <= position.stop : bar.open >= position.stop;
      if (gapped) {
        closeTrade(bar.open - dir * slip, bar.openTime, 'stop (gap)', i);
      } else {
        const hitStop = long ? bar.low <= position.stop : bar.high >= position.stop;
        const hitTarget = position.target !== null
          && (long ? bar.high >= position.target : bar.low <= position.target);

        if (hitStop && hitTarget) {
          if (cfg.pessimisticFills) {
            closeTrade(position.stop - dir * slip, bar.closeTime, 'stop (ambiguous bar)', i);
          } else {
            closeTrade(position.target, bar.closeTime, 'target (ambiguous bar)', i);
          }
        } else if (hitStop) {
          closeTrade(position.stop - dir * slip, bar.closeTime, 'stop', i);
        } else if (hitTarget) {
          closeTrade(position.target, bar.closeTime, 'target', i);
        }
      }

      // --- 3. Trail / time stop on a position that survived the bar.
      if (position) {
        position.peak = Math.max(position.peak, bar.high);
        position.trough = Math.min(position.trough, bar.low);

        if (cfg.trailMode === 'atr') {
          const a = atrVals[i];
          if (Number.isFinite(a) && a > 0) {
            const candidate = long ? bar.close - cfg.trailAtr * a : bar.close + cfg.trailAtr * a;
            position.stop = long ? Math.max(position.stop, candidate) : Math.min(position.stop, candidate);
          }
        } else if (cfg.trailMode === 'priorBar') {
          const candidate = long
            ? bar.low - cfg.stopBufferTicks * tickSize
            : bar.high + cfg.stopBufferTicks * tickSize;
          position.stop = long ? Math.max(position.stop, candidate) : Math.min(position.stop, candidate);
        } else if (cfg.trailMode === 'breakeven') {
          const banked = ((bar.close - position.entryPrice) * dir) / position.riskPerUnit;
          if (banked >= cfg.breakevenAtR) {
            position.stop = long
              ? Math.max(position.stop, position.entryPrice)
              : Math.min(position.stop, position.entryPrice);
          }
        }

        if (cfg.maxBars > 0 && i - position.entryBar + 1 >= cfg.maxBars) {
          closeTrade(bar.close - dir * slip, bar.closeTime, 'time stop', i);
        }
      }
    }

    // --- 4. Act on this bar's signal.
    const sig = signalsByBar.get(i);
    if (sig) {
      if (position && sig.side !== position.side && cfg.exitOnOpposite) {
        closeTrade(bar.close - dirOf(position.side) * slip, bar.closeTime, 'opposite signal', i);
      }
      if (!position && !pending) {
        const stopPrice = initialStop(bar, sig.side, cfg, atrVals[i], tickSize);
        const valid = sig.side === 'long' ? stopPrice < bar.close : stopPrice > bar.close;
        if (!valid) {
          rejected.push({ time: bar.closeTime, reason: 'stop on the wrong side of price', signal: sig });
        } else if (cfg.entry === 'signalClose') {
          // Optimistic mode: fill here, on the same close the signal was derived
          // from, rather than queueing for the next bar's open.
          const dir = dirOf(sig.side);
          const entryPrice = bar.close + dir * slip;
          const riskPerUnit = Math.abs(entryPrice - stopPrice);
          let qty;
          if (cfg.sizing === 'fixedQty') qty = cfg.fixedQty;
          else if (cfg.sizing === 'fixedNotional') qty = cfg.fixedNotional / entryPrice;
          else qty = (equity * cfg.riskPct / 100) / riskPerUnit;
          const maxQty = (equity * cfg.maxNotionalPct / 100) / entryPrice;
          const capped = qty > maxQty;
          if (capped) qty = maxQty;
          if (qty > 0 && Number.isFinite(qty) && riskPerUnit > 0) {
            position = {
              side: sig.side,
              qty,
              entryPrice,
              entryTime: bar.closeTime,
              entryBar: i,
              stop: stopPrice,
              initialStop: stopPrice,
              target: initialTarget(entryPrice, stopPrice, sig.side, cfg, atrVals[i], tickSize),
              riskPerUnit,
              entryFee: Math.abs(entryPrice * qty) * feeRate,
              signal: sig,
              segment: i < splitIdx ? 'in-sample' : 'out-of-sample',
              capped,
              peak: entryPrice,
              trough: entryPrice,
            };
          }
        } else {
          pending = { side: sig.side, stopPrice, signal: sig, barIndex: i };
        }
      }
    }

    // --- 5. Mark to market.
    let openPnl = 0;
    if (position) {
      const dir = dirOf(position.side);
      openPnl = (bar.close - position.entryPrice) * position.qty * dir - position.entryFee;
    }
    curve.push({ time: bar.closeTime, barIndex: i, equity: equity + openPnl, realized: equity, inPosition: !!position });
  }

  // Force-close anything still open on the last bar so the stats are complete.
  if (position && bars.length) {
    const last = bars[bars.length - 1];
    closeTrade(last.close - dirOf(position.side) * slip, last.closeTime, 'end of data', bars.length - 1);
    if (curve.length) curve[curve.length - 1].equity = equity;
  }

  const stats = computeStats(trades, curve, {
    initialCapital: cfg.initialCapital,
    intervalMs,
    barsInMarket,
    totalBars: bars.length,
  });

  // Warnings the numbers alone would hide.
  const warnings = [];
  const cappedTrades = trades.filter((t) => t.capped).length;
  if (cappedTrades) {
    warnings.push(
      `${cappedTrades} of ${trades.length} positions were clipped by the ${cfg.maxNotionalPct}% max-notional limit, `
      + 'so they risked less than the configured amount. Widen the stop, raise the notional cap, or size by notional instead.',
    );
  }
  const feeHeavy = trades.filter((t) => t.feePctOfRisk > 50).length;
  if (feeHeavy) {
    warnings.push(
      `${feeHeavy} trades paid more than half their risk in fees at ${cfg.feeBps} bps per side. `
      + 'At that ratio the edge has to beat the exchange before it beats the market.',
    );
  }
  if (trades.length && trades.length < 30) {
    warnings.push(`${trades.length} trades is too small a sample to conclude anything. Load a longer range before trusting these numbers.`);
  }

  const result = {
    config: cfg,
    trades,
    curve,
    rejected,
    warnings,
    cappedTrades,
    stats,
    byType: breakdown(trades, (t) => t.label || t.type),
    bySide: breakdown(trades, (t) => t.side),
    byExit: breakdown(trades, (t) => t.exitReason),
    splitIndex: cfg.oosSplitPct > 0 ? splitIdx : null,
  };

  if (cfg.oosSplitPct > 0) {
    const isTrades = trades.filter((t) => t.segment === 'in-sample');
    const oosTrades = trades.filter((t) => t.segment === 'out-of-sample');
    const isCurve = curve.filter((c) => c.barIndex < splitIdx);
    const oosCurve = curve.filter((c) => c.barIndex >= splitIdx);
    result.segments = {
      inSample: computeStats(isTrades, isCurve, {
        initialCapital: cfg.initialCapital,
        intervalMs,
        barsInMarket: isCurve.filter((c) => c.inPosition).length,
        totalBars: isCurve.length,
      }),
      outOfSample: computeStats(oosTrades, oosCurve, {
        initialCapital: oosCurve[0]?.equity ?? cfg.initialCapital,
        intervalMs,
        barsInMarket: oosCurve.filter((c) => c.inPosition).length,
        totalBars: oosCurve.length,
      }),
    };
  }

  return result;
}

/**
 * Buy-and-hold over the same bars, sized to the initial capital. Every strategy
 * result is shown against this — a footprint strategy that loses to holding spot
 * is not a strategy.
 */
export function buyAndHold(bars, initialCapital = 10_000) {
  if (!bars.length) return { curve: [], returnPct: NaN };
  const qty = initialCapital / bars[0].open;
  const curve = bars.map((b) => ({ time: b.closeTime, barIndex: b.index, equity: qty * b.close }));
  const last = curve[curve.length - 1].equity;
  return { curve, returnPct: ((last - initialCapital) / initialCapital) * 100 };
}
