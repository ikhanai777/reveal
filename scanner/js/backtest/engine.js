// Event-driven backtester.
//
// It replays bars through the same scoring and risk code the live scanner
// uses, so a backtested edge and a live signal come from one implementation.
// Warm-up bars are excluded from the tradable range, and every decision at bar
// i sees only bars <= i.

import { scoreTechnicals } from '../engines/ta.js';
import { scoreOrderFlow } from '../engines/orderflow.js';
import { scoreDerivatives } from '../engines/derivatives.js';
import { scoreSentiment } from '../engines/sentiment.js';
import { Forecaster, scoreForecast } from '../engines/forecast.js';
import { evaluate, DEFAULT_WEIGHTS } from '../signal/scoring.js';
import { buildTradePlan, positionSize, trailStop, DEFAULT_RISK } from '../signal/risk.js';
import { quadraticSlippage, fee, fundingCost } from './slippage.js';
import { computeMetrics } from './metrics.js';
import { barsPerYear } from '../core/timeframe.js';
import { volumeProfile } from '../engines/vpvr.js';

export const DEFAULT_BACKTEST = {
  warmup: 250,
  window: 300,          // bars of context handed to the engines
  equity: 10_000,
  riskFraction: 0.01,
  feeTier: 'vip0',
  entryLiquidity: 'maker',
  exitLiquidity: 'taker',
  impactBps: 12,
  halfSpreadBps: 0.5,
  fundingIntervalMs: 8 * 3_600_000,
  maxConcurrent: 1,
  maxLeverage: 5,
  // Never take more than this share of the bar's traded notional: past it the
  // quadratic impact model is extrapolating well beyond anything observable.
  maxParticipation: 0.25,
  // Reject a setup whose expected entry slippage eats more than this share of
  // the stop distance. A 2% slip against a 0.1% stop is not a trade.
  maxSlippageOfRisk: 0.25,
  allowLong: true,
  allowShort: true,
  useForecaster: true,
  profileEvery: 10,     // rebuild VPVR every N bars; it dominates the hot loop
};

/**
 * @param {object} args
 * @param {object[]} args.candles  closed candles, oldest-first
 * @param {string}   args.timeframe
 * @param {object}   [args.weights]
 * @param {object}   [args.risk]
 * @param {object}   [args.config]
 * @param {object[]} [args.funding] [{ts, rate}] oldest-first
 * @param {object[]} [args.openInterest] [{ts, oi}]
 * @param {function} [args.onProgress]
 */
export function runBacktest({
  candles, timeframe = '5m', weights = DEFAULT_WEIGHTS, risk = DEFAULT_RISK,
  config = {}, funding = [], openInterest = [], sentimentEngine = null, onProgress = null, symbol = 'BTC/USDT',
}) {
  const cfg = { ...DEFAULT_BACKTEST, ...config };
  if (!candles || candles.length <= cfg.warmup + 10) {
    throw new Error(`need more than ${cfg.warmup + 10} bars, got ${candles?.length ?? 0}`);
  }

  const forecaster = cfg.useForecaster ? new Forecaster() : null;
  const trades = [];
  const equityCurve = [];
  const rejections = [];
  let equity = cfg.equity;
  let open = [];
  let profile = null;

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i];
    const history = candles.slice(Math.max(0, i - cfg.window + 1), i + 1);

    if (forecaster && i >= 60) forecaster.observe(history);

    if (i < cfg.warmup) { equityCurve.push({ ts: bar.t, value: equity }); continue; }

    // --- Manage open positions against this bar ---------------------------
    open = open.filter((pos) => {
      const done = managePosition(pos, bar, cfg);
      if (done) {
        equity += pos.pnl;
        trades.push(finalizeTrade(pos, funding, cfg));
        return false;
      }
      return true;
    });

    // --- Score ------------------------------------------------------------
    if (i % cfg.profileEvery === 0 || !profile) {
      profile = volumeProfile(history, { rows: 60 });
    }

    const ta = scoreTechnicals(history);
    const of = scoreOrderFlow({ candles: history, profile });
    const fa = scoreDerivatives({
      candles: history,
      fundingHistory: funding.filter((f) => f.ts <= bar.t).slice(-60),
      oiHistory: openInterest.filter((o) => o.ts <= bar.t).slice(-60),
    });
    const news = sentimentEngine
      ? scoreSentiment(sentimentEngine, symbol, bar.t)
      : { score: 0, components: [], context: { ready: false, reason: 'no news feed in this run' } };
    const ml = forecaster ? scoreForecast(forecaster.predict(history)) : { score: 0, components: [], context: { ready: false } };

    const evaluation = evaluate({ ta, orderFlow: of, derivatives: fa, news, ml }, { weights });

    // --- Entry -------------------------------------------------------------
    const dir = evaluation.classification.direction;
    const allowed = dir > 0 ? cfg.allowLong : dir < 0 ? cfg.allowShort : false;
    if (evaluation.actionable && allowed && open.length < cfg.maxConcurrent) {
      const plan = buildTradePlan({
        direction: dir,
        price: bar.c,
        atr: ta.context.atr,
        profile,
        structure: { swingHigh: ta.context.swingHigh, swingLow: ta.context.swingLow },
        fvgs: ta.context.fvgs || [],
        cfg: risk,
      });
      if (plan && !plan.rejected) {
        const pos = openPosition({ plan, bar, equity, cfg, evaluation, timeframe, symbol, index: i });
        if (pos?.rejected) rejections.push({ ts: bar.t, reason: pos.reason });
        else if (pos) open.push(pos);
      } else if (plan?.rejected) {
        rejections.push({ ts: bar.t, reason: plan.reason });
      }
    } else if (!evaluation.filters.pass && dir !== 0) {
      rejections.push({ ts: bar.t, reason: evaluation.filters.vetoes.join('; ') });
    }

    // Mark to market so the equity curve reflects open risk, not just closes.
    const unrealized = open.reduce((a, p) => a + markToMarket(p, bar.c), 0);
    equityCurve.push({ ts: bar.t, value: equity + unrealized });

    if (onProgress && i % 200 === 0) onProgress({ i, total: candles.length, equity, trades: trades.length });
  }

  // Close anything still open at the final bar.
  const lastBar = candles[candles.length - 1];
  for (const pos of open) {
    closePosition(pos, lastBar.c, lastBar.t, 'END_OF_DATA', cfg);
    equity += pos.pnl;
    trades.push(finalizeTrade(pos, funding, cfg));
  }
  if (equityCurve.length) equityCurve[equityCurve.length - 1] = { ts: lastBar.t, value: equity };

  const metrics = computeMetrics({ trades, equity: equityCurve, periodsPerYear: barsPerYear(timeframe) });
  return { trades, equityCurve, metrics, rejections, config: cfg, weights, timeframe, symbol };
}

// --- Position mechanics -----------------------------------------------------

function openPosition({ plan, bar, equity, cfg, evaluation, timeframe, symbol, index }) {
  // Entry fills at the zone edge nearest the current bar, as a resting limit.
  const entryPrice = plan.direction > 0
    ? Math.min(plan.entry.high, Math.max(plan.entry.low, bar.c))
    : Math.max(plan.entry.low, Math.min(plan.entry.high, bar.c));

  // ~2% of a bar's traded notional is resting within reach of the touch.
  const depthNotional = (bar.v || 1) * bar.c * 0.02;
  const maxNotional = depthNotional * cfg.maxParticipation;
  const slipFor = (notional) => quadraticSlippage({
    notional, depthNotional, halfSpreadBps: cfg.halfSpreadBps, impactBps: cfg.impactBps,
  });

  // Size, slip, then re-size against the price actually filled. Sizing on the
  // intended price and only then applying impact understates risk badly when
  // the stop is tight: the slip alone can exceed the whole stop distance.
  let sizing = positionSize({
    equity, riskFraction: cfg.riskFraction, entryPrice, stopPrice: plan.stop, maxLeverage: cfg.maxLeverage,
  });
  if (!(sizing.qty > 0)) return null;

  let notional = Math.min(sizing.notional, maxNotional);
  let slipFrac = slipFor(notional);
  let fillPrice = entryPrice * (1 + slipFrac * plan.direction);

  const intendedRisk = Math.abs(entryPrice - plan.stop);
  const slipCost = Math.abs(fillPrice - entryPrice);
  if (!(intendedRisk > 0) || slipCost > intendedRisk * cfg.maxSlippageOfRisk) {
    return { rejected: true, reason: `expected slippage ${(slipFrac * 100).toFixed(2)}% too large against a ${((intendedRisk / entryPrice) * 100).toFixed(2)}% stop` };
  }

  // Re-size on the real fill so the loss at the stop matches the risk budget.
  sizing = positionSize({
    equity, riskFraction: cfg.riskFraction, entryPrice: fillPrice, stopPrice: plan.stop, maxLeverage: cfg.maxLeverage,
  });
  if (!(sizing.qty > 0)) return null;
  if (sizing.notional > maxNotional) {
    sizing = { qty: maxNotional / fillPrice, notional: maxNotional };
    slipFrac = slipFor(maxNotional);
    fillPrice = entryPrice * (1 + slipFrac * plan.direction);
  }

  return {
    symbol, timeframe, index,
    direction: plan.direction,
    openTs: bar.t,
    signalPrice: plan.entry.mid,
    entryPrice: fillPrice,
    qty: sizing.qty,
    notional: sizing.qty * fillPrice,
    stop: plan.stop,
    initialStop: plan.stop,
    targets: plan.targets.map((t) => ({ ...t, hit: false })),
    remaining: 1,
    trail: plan.trail,
    scs: evaluation.scs,
    bias: evaluation.classification.bias,
    breakdown: evaluation.breakdown.map((b) => ({ key: b.key, score: b.score, weight: b.weight })),
    realized: 0,
    fees: fee({ notional: sizing.notional, liquidity: cfg.entryLiquidity, tier: cfg.feeTier }),
    slippageCost: sizing.notional * slipFrac,
    slippageBps: slipFrac * 10_000,
    mfe: 0, mae: 0,
    barsHeld: 0,
    expiryBars: plan.expiryBars,
    closed: false,
    pnl: 0,
  };
}

function markToMarket(pos, price) {
  return pos.realized + (price - pos.entryPrice) * pos.direction * pos.qty * pos.remaining - pos.fees;
}

/** @returns {boolean} true once the position is fully closed. */
function managePosition(pos, bar, cfg) {
  pos.barsHeld++;
  const dir = pos.direction;
  const favor = dir > 0 ? (bar.h - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - bar.l) / pos.entryPrice;
  const adverse = dir > 0 ? (bar.l - pos.entryPrice) / pos.entryPrice : (pos.entryPrice - bar.h) / pos.entryPrice;
  pos.mfe = Math.max(pos.mfe, favor);
  pos.mae = Math.min(pos.mae, adverse);

  // Stop before targets within the same bar: the pessimistic ordering.
  if (dir > 0 ? bar.l <= pos.stop : bar.h >= pos.stop) {
    closePosition(pos, pos.stop, bar.t, pos.stop === pos.initialStop ? 'STOP' : 'TRAIL', cfg);
    return true;
  }

  for (let i = 0; i < pos.targets.length; i++) {
    const t = pos.targets[i];
    if (t.hit) continue;
    const reached = dir > 0 ? bar.h >= t.price : bar.l <= t.price;
    if (!reached) break;
    t.hit = true;
    const closeQty = pos.qty * t.size;
    const gross = (t.price - pos.entryPrice) * dir * closeQty;
    const notional = closeQty * t.price;
    pos.realized += gross;
    pos.fees += fee({ notional, liquidity: cfg.exitLiquidity, tier: cfg.feeTier });
    pos.remaining = Math.max(0, +(pos.remaining - t.size).toFixed(6));
    if (i === 0) pos.stop = pos.entryPrice; // breakeven
    if (pos.remaining <= 1e-6) {
      finishClose(pos, t.price, bar.t, 'TARGETS');
      return true;
    }
  }

  if (pos.targets[1]?.hit && pos.trail?.atr) {
    pos.stop = trailStop({ direction: dir, currentStop: pos.stop, price: bar.c, atr: pos.trail.atr, mult: pos.trail.atrMult });
  }
  return false;
}

function closePosition(pos, price, ts, reason, cfg) {
  const closeQty = pos.qty * pos.remaining;
  const gross = (price - pos.entryPrice) * pos.direction * closeQty;
  pos.realized += gross;
  pos.fees += fee({ notional: closeQty * price, liquidity: cfg.exitLiquidity, tier: cfg.feeTier });
  pos.remaining = 0;
  finishClose(pos, price, ts, reason);
}

function finishClose(pos, price, ts, reason) {
  pos.closed = true;
  pos.exitPrice = price;
  pos.closeTs = ts;
  pos.closeReason = reason;
  pos.pnl = pos.realized - pos.fees;
}

function finalizeTrade(pos, fundingRates, cfg) {
  const fundingPaid = fundingCost({
    rates: fundingRates, from: pos.openTs, to: pos.closeTs,
    notional: pos.notional, direction: pos.direction, intervalMs: cfg.fundingIntervalMs,
  });
  pos.funding = fundingPaid;
  pos.pnl -= fundingPaid;
  pos.pnlPct = pos.notional ? pos.pnl / pos.notional : 0;
  return {
    symbol: pos.symbol,
    direction: pos.direction,
    openTs: pos.openTs,
    closeTs: pos.closeTs,
    entryPrice: pos.entryPrice,
    exitPrice: pos.exitPrice,
    qty: pos.qty,
    notional: pos.notional,
    pnl: pos.pnl,
    pnlPct: pos.pnlPct,
    fees: pos.fees,
    funding: pos.funding,
    slippageCost: pos.slippageCost,
    slippageBps: pos.slippageBps,
    mfe: pos.mfe,
    mae: pos.mae,
    barsHeld: pos.barsHeld,
    closeReason: pos.closeReason,
    scs: pos.scs,
    bias: pos.bias,
    breakdown: pos.breakdown,
  };
}
