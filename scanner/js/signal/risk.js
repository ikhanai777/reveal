// Automated risk and entry parameters.
//
// Entry: a limit zone anchored to the nearest POC or unfilled FVG.
// Stop:  the wider of ATR x mult and the last structural swing, with a buffer.
// TP1:   1.5R, closing 40% and moving the stop to breakeven.
// TP2:   the next VPVR volume node, closing a further 40%.
// TP3:   the remaining 20%, trailed by ATR.

import { nextNode } from '../engines/vpvr.js';
import { clamp } from '../core/num.js';

export const DEFAULT_RISK = {
  atrMult: 1.5,
  tp1R: 1.5,
  tp3R: 4,               // cap used when no node is reachable for TP3
  swingBufferAtr: 0.25,
  maxStopAtr: 3,         // ignore a structural stop further out than this
  entryBandAtr: 0.35,
  sizing: [0.4, 0.4, 0.2],
  trailAtrMult: 2,
  maxRiskPct: 0.05,      // reject a setup whose stop is further than 5% away
  expiryBars: 12,
};

/**
 * @param {object} args
 * @param {1|-1}   args.direction
 * @param {number} args.price     current mark
 * @param {number} args.atr
 * @param {object} args.profile   VPVR profile
 * @param {object} [args.structure] { swingHigh, swingLow }
 * @param {object[]} [args.fvgs]  unfilled gaps
 */
export function buildTradePlan({ direction, price, atr, profile, structure = {}, fvgs = [], cfg = {} }) {
  const c = { ...DEFAULT_RISK, ...cfg };
  if (!direction || !(atr > 0) || !(price > 0)) return null;

  // --- Entry zone ----------------------------------------------------------
  const anchors = [];
  if (Number.isFinite(profile?.poc)) anchors.push({ price: profile.poc, kind: 'POC' });
  for (const g of fvgs.filter((g) => !g.filled && g.dir === direction)) {
    anchors.push({ price: (g.from + g.to) / 2, kind: 'FVG' });
  }
  // Prefer an anchor price is retracing into, not one it has already left behind.
  const viable = anchors.filter((a) => (direction > 0 ? a.price <= price * 1.001 : a.price >= price * 0.999));
  viable.sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price));
  const anchor = viable[0] || { price, kind: 'market' };

  const band = atr * c.entryBandAtr;
  const entry = {
    anchor: anchor.kind,
    mid: anchor.price,
    low: anchor.price - band,
    high: anchor.price + band,
  };

  // --- Stop ----------------------------------------------------------------
  const atrStop = direction > 0 ? price - atr * c.atrMult : price + atr * c.atrMult;
  const swing = direction > 0 ? structure.swingLow : structure.swingHigh;
  let swingStop = Number.isFinite(swing)
    ? (direction > 0 ? swing - atr * c.swingBufferAtr : swing + atr * c.swingBufferAtr)
    : null;
  // The last confirmed swing can be hundreds of bars and many ATRs away; a stop
  // out there is not "structural", it is just an enormous stop. Past the cap,
  // fall back to the ATR stop rather than sizing a trade around stale structure.
  if (swingStop != null && Math.abs(price - swingStop) > atr * c.maxStopAtr) swingStop = null;
  // Otherwise take whichever sits further out: a stop inside structure gets hunted.
  const stop = swingStop != null
    ? (direction > 0 ? Math.min(atrStop, swingStop) : Math.max(atrStop, swingStop))
    : atrStop;

  const risk = Math.abs(entry.mid - stop);
  if (!(risk > 0)) return null;
  const riskPct = risk / entry.mid;
  if (riskPct > c.maxRiskPct) {
    return { rejected: true, reason: `stop distance ${(riskPct * 100).toFixed(2)}% exceeds ${(c.maxRiskPct * 100).toFixed(1)}%` };
  }

  // --- Targets -------------------------------------------------------------
  const tp1 = entry.mid + direction * risk * c.tp1R;
  const node = profile ? nextNode(profile, tp1, direction) : null;
  const tp2 = node && Number.isFinite(node.price) && (direction > 0 ? node.price > tp1 : node.price < tp1)
    ? node.price
    : entry.mid + direction * risk * (c.tp1R + 1);
  const tp3 = entry.mid + direction * risk * Math.max(c.tp3R, Math.abs(tp2 - entry.mid) / risk + 1);

  const rr = (target) => Math.abs(target - entry.mid) / risk;

  return {
    rejected: false,
    direction,
    entry,
    stop,
    risk,
    riskPct,
    targets: [
      { name: 'TP1', price: tp1, size: c.sizing[0], rr: rr(tp1), action: 'move stop to breakeven' },
      { name: 'TP2', price: tp2, size: c.sizing[1], rr: rr(tp2), action: node ? `VPVR node @ ${node.price.toFixed(2)}` : 'measured move' },
      { name: 'TP3', price: tp3, size: c.sizing[2], rr: rr(tp3), action: `trailing ATR x${c.trailAtrMult}` },
    ],
    trail: { atrMult: c.trailAtrMult, atr },
    expiryBars: c.expiryBars,
  };
}

/** Position size for a fixed fractional risk budget. */
export function positionSize({ equity, riskFraction, entryPrice, stopPrice, maxLeverage = 10 }) {
  const perUnitRisk = Math.abs(entryPrice - stopPrice);
  if (!(perUnitRisk > 0) || !(equity > 0)) return { qty: 0, notional: 0, leverage: 0 };
  const budget = equity * clamp(riskFraction, 0, 1);
  let qty = budget / perUnitRisk;
  let notional = qty * entryPrice;
  const maxNotional = equity * maxLeverage;
  if (notional > maxNotional) { notional = maxNotional; qty = notional / entryPrice; }
  return { qty, notional, leverage: notional / equity, riskAmount: qty * perUnitRisk };
}

/** ATR trailing stop for the runner, monotonic in the trade's favour. */
export function trailStop({ direction, currentStop, price, atr, mult = 2 }) {
  const candidate = direction > 0 ? price - atr * mult : price + atr * mult;
  if (currentStop == null) return candidate;
  return direction > 0 ? Math.max(currentStop, candidate) : Math.min(currentStop, candidate);
}
