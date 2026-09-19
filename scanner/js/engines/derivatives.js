// Derivatives and on-chain factor: funding, open interest, squeeze geometry,
// token unlocks and stablecoin supply ratio.
//
// Squeeze conditions from the spec:
//   Long squeeze  — rising price + extreme negative funding + rising OI
//   Short squeeze — falling price + extreme positive funding + rising OI
// Both are fuel for a move against the crowded side, so a short squeeze is
// scored bullish and a long squeeze bearish.

import { blend } from './ta.js';
import { clamp, squash, mean, percentRank } from '../core/num.js';

/**
 * 8h funding regimes, in basis points of the rate.
 * The venue-neutral baseline is 0.01% (1bp); 0.05% (5bp) means one side is
 * paying up to stay on, and 0.1% (10bp) is the crowding that precedes a
 * liquidation cascade.
 */
export function fundingRegime(rate) {
  const bps = rate * 10_000;
  const a = Math.abs(bps);
  const level = a >= 10 ? 'extreme' : a >= 5 ? 'elevated' : a >= 1.5 ? 'mild' : 'neutral';
  return { bps, level, sign: Math.sign(rate) };
}

/**
 * @param {object} ctx
 * @param {object[]} ctx.candles
 * @param {{rate:number, ts:number}[]} [ctx.fundingHistory] oldest-first
 * @param {{oi:number, ts:number}[]}   [ctx.oiHistory]      oldest-first
 * @param {object} [ctx.onchain] { netExchangeFlow, activeAddressesChange, ssr, unlocks }
 */
export function scoreDerivatives(ctx) {
  const { candles = [], fundingHistory = [], oiHistory = [], onchain = {} } = ctx;
  if (candles.length < 20) {
    return { score: 0, components: [], context: { ready: false, reason: 'warming up' } };
  }
  // With no derivatives or on-chain data at all this factor has no opinion.
  // Reporting a neutral 0 would drag the SCS toward 50 and silently mute every
  // other factor, so it abstains instead and the scorer redistributes its weight.
  if (!fundingHistory.length && !oiHistory.length && !Object.keys(onchain).length) {
    return { score: 0, components: [], context: { ready: false, reason: 'no derivatives or on-chain feed' } };
  }

  const price = candles[candles.length - 1].c;
  const priorPrice = candles[Math.max(0, candles.length - 13)].c;
  const priceChange = priorPrice ? (price - priorPrice) / priorPrice : 0;

  const funding = fundingHistory[fundingHistory.length - 1]?.rate ?? null;
  const regime = funding != null ? fundingRegime(funding) : null;

  const oiNow = oiHistory[oiHistory.length - 1]?.oi ?? null;
  const oiPrior = oiHistory.length > 12 ? oiHistory[oiHistory.length - 13].oi : oiHistory[0]?.oi ?? null;
  const oiChange = oiNow && oiPrior ? (oiNow - oiPrior) / oiPrior : 0;

  // --- Funding: crowded positioning is a contrarian input ------------------
  // Positive funding = longs paying shorts = crowded long = bearish pressure.
  // Half-saturation at 5bp: elevated funding reads as a meaningful lean, and
  // extreme funding saturates rather than dominating the whole factor.
  const fundingScore = funding != null ? clamp(-squash(regime.bps, 5), -1, 1) : 0;

  // --- Squeeze geometry ----------------------------------------------------
  const oiRising = oiChange > 0.01;
  let squeezeScore = 0;
  let squeezeLabel = 'none';
  if (regime && oiRising) {
    if (priceChange > 0.002 && regime.bps <= -5) {
      // Price up while shorts pay longs and OI builds: shorts trapped.
      squeezeScore = clamp(0.6 + Math.min(0.4, Math.abs(regime.bps) / 30), 0, 1);
      squeezeLabel = 'long squeeze setup (shorts trapped)';
    } else if (priceChange < -0.002 && regime.bps >= 5) {
      squeezeScore = -clamp(0.6 + Math.min(0.4, regime.bps / 30), 0, 1);
      squeezeLabel = 'short squeeze setup (longs trapped)';
    }
  }

  // --- OI + price: the four-quadrant read ----------------------------------
  // Rising price + rising OI = new longs (continuation).
  // Falling price + rising OI = new shorts (continuation lower).
  // Rising price + falling OI = short covering (weak).
  let oiScore = 0;
  let oiLabel = 'flat';
  if (Math.abs(oiChange) > 0.005) {
    const mag = clamp(Math.abs(oiChange) / 0.05, 0.2, 1);
    if (priceChange > 0 && oiChange > 0) { oiScore = 0.7 * mag; oiLabel = 'new longs'; }
    else if (priceChange < 0 && oiChange > 0) { oiScore = -0.7 * mag; oiLabel = 'new shorts'; }
    else if (priceChange > 0 && oiChange < 0) { oiScore = 0.2 * mag; oiLabel = 'short covering'; }
    else { oiScore = -0.2 * mag; oiLabel = 'long liquidation'; }
  }

  // --- On-chain ------------------------------------------------------------
  // Net exchange inflow is supply arriving to be sold; outflow is accumulation.
  const flow = onchain.netExchangeFlow;
  const flowScore = flow != null ? clamp(-squash(flow, 1), -1, 1) : null;
  const addrScore = onchain.activeAddressesChange != null
    ? clamp(squash(onchain.activeAddressesChange, 0.15), -1, 1) : null;
  // A high stablecoin supply ratio means little dry powder per unit of market cap.
  const ssrScore = onchain.ssr != null ? clamp(-squash(onchain.ssr - 10, 8), -1, 1) : null;

  // Unlocks above 1% of float inside 48h are a scheduled supply overhang.
  const unlocks = onchain.unlocks || [];
  const imminent = unlocks.filter((u) => u.hoursAway <= 48 && u.pctOfSupply >= 1);
  const unlockScore = imminent.length
    ? -clamp(imminent.reduce((a, u) => a + u.pctOfSupply, 0) / 5, 0.2, 1)
    : null;

  const out = blend([
    { key: 'funding', label: 'Funding rate', score: fundingScore, weight: 0.26, detail: regime ? `${regime.bps.toFixed(3)} bps (${regime.level})` : 'no data' },
    { key: 'squeeze', label: 'Squeeze condition', score: squeezeScore, weight: 0.24, detail: squeezeLabel },
    { key: 'oi', label: 'Open interest delta', score: oiScore, weight: 0.22, detail: `${(oiChange * 100).toFixed(2)}% • ${oiLabel}` },
    { key: 'flow', label: 'Exchange net flow', score: flowScore, weight: 0.12, detail: flow != null ? `${flow > 0 ? '+' : ''}${flow.toFixed(2)}σ` : 'no data' },
    { key: 'network', label: 'Active addresses', score: addrScore, weight: 0.06, detail: onchain.activeAddressesChange != null ? `${(onchain.activeAddressesChange * 100).toFixed(1)}%` : 'no data' },
    { key: 'ssr', label: 'Stablecoin supply ratio', score: ssrScore, weight: 0.05, detail: onchain.ssr != null ? onchain.ssr.toFixed(1) : 'no data' },
    { key: 'unlocks', label: 'Token unlocks', score: unlockScore, weight: 0.05, detail: imminent.length ? `${imminent.length} within 48h` : 'none within 48h' },
  ]);

  return {
    ...out,
    context: {
      ready: true,
      funding, fundingRegime: regime, oi: oiNow, oiChange, priceChange,
      squeeze: squeezeLabel, unlocks: imminent,
      fundingPercentile: fundingHistory.length > 20
        ? percentRank(fundingHistory.map((f) => f.rate), funding) : null,
      oiTrend: oiHistory.length > 3 ? mean(oiHistory.slice(-5).map((o) => o.oi)) : null,
    },
  };
}
