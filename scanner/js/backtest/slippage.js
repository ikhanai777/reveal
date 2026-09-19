// Execution realism: slippage, fees, funding.

/**
 * Quadratic volume-impact slippage.
 *
 * Crossing the spread is unavoidable; beyond that, impact grows with the
 * square of the order's size relative to the depth available at the timestamp.
 * When a real book snapshot exists it is walked level by level instead, which
 * is exact rather than parametric.
 */
export function quadraticSlippage({ notional, depthNotional, halfSpreadBps = 0.5, impactBps = 12, cap = 0.02 }) {
  if (!(notional > 0)) return 0;
  const participation = depthNotional > 0 ? notional / depthNotional : 1;
  const frac = (halfSpreadBps / 10_000) + (impactBps / 10_000) * participation * participation;
  return Math.min(cap, frac);
}

/**
 * Walk a real book to fill `qty`, returning the volume-weighted average price.
 * Unfilled remainder is priced at the last level touched plus the parametric
 * model, so a thin book never silently fills at the touch.
 */
export function walkBook({ levels, qty, side, fallbackBps = 30 }) {
  let remaining = qty;
  let cost = 0;
  let last = levels[0]?.[0];
  for (const [price, size] of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, size);
    cost += take * price;
    remaining -= take;
    last = price;
  }
  if (remaining > 0 && last != null) {
    const penalty = last * (fallbackBps / 10_000) * (side > 0 ? 1 : -1);
    cost += remaining * (last + penalty);
    remaining = 0;
  }
  return qty > 0 ? cost / qty : NaN;
}

export const FEE_TIERS = {
  vip0: { maker: 0.0002, taker: 0.0005 },
  vip1: { maker: 0.00016, taker: 0.0004 },
  vip3: { maker: 0.00012, taker: 0.0003 },
};

export function fee({ notional, liquidity = 'taker', tier = 'vip0', schedule = FEE_TIERS }) {
  const rates = schedule[tier] || FEE_TIERS.vip0;
  return notional * (liquidity === 'maker' ? rates.maker : rates.taker);
}

/**
 * Funding accrued by a perpetual position between two timestamps.
 * A long pays when funding is positive.
 *
 * @param {object[]} rates oldest-first [{ ts, rate }]
 */
export function fundingCost({ rates, from, to, notional, direction, intervalMs = 8 * 3_600_000 }) {
  if (!rates?.length) return 0;
  let total = 0;
  // Settlements land on interval boundaries; a position pays each one it holds through.
  const firstBoundary = Math.ceil(from / intervalMs) * intervalMs;
  for (let t = firstBoundary; t <= to; t += intervalMs) {
    const rate = rateAt(rates, t);
    if (rate == null) continue;
    total += notional * rate * direction;
  }
  return total;
}

function rateAt(rates, ts) {
  let out = null;
  for (const r of rates) {
    if (r.ts <= ts) out = r.rate;
    else break;
  }
  return out;
}
