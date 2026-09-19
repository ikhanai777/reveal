// Order Flow factor: footprint delta, imbalance stacks, CVD divergence,
// book imbalance, absorption and spoofing. This is the heaviest-weighted
// factor in the matrix (30%), so its components stay deliberately literal.

import { blend } from './ta.js';
import { cvdDivergence } from './cvd.js';
import { orderBookImbalance } from './orderbook.js';
import { volumeProfile, valueLocation } from './vpvr.js';
import { clamp, squash, mean } from '../core/num.js';

/**
 * @param {object} ctx
 * @param {object[]} ctx.candles       closed candles, oldest-first
 * @param {object[]} [ctx.footprints]  FootprintCandle instances, oldest-first
 * @param {object}   [ctx.book]        normalized L2 book
 * @param {object}   [ctx.wallTracker]
 * @param {object}   [ctx.profile]     precomputed VPVR (built here when absent)
 */
export function scoreOrderFlow(ctx) {
  const { candles = [], footprints = [], book = null, wallTracker = null } = ctx;
  if (candles.length < 20) {
    return { score: 0, components: [], context: { ready: false, reason: 'warming up' } };
  }
  const price = candles[candles.length - 1].c;
  const profile = ctx.profile || volumeProfile(candles, { rows: 60 });

  // --- Candle delta: recent aggression, normalized by volume ---------------
  const recent = candles.slice(-10);
  const deltaPcts = recent.map((c) => {
    const v = (c.buyVol ?? 0) + (c.sellVol ?? 0);
    return v ? ((c.buyVol ?? 0) - (c.sellVol ?? 0)) / v : 0;
  });
  const lastDelta = deltaPcts[deltaPcts.length - 1] ?? 0;
  const deltaScore = clamp(0.6 * lastDelta * 2 + 0.4 * mean(deltaPcts) * 2, -1, 1);

  // --- Footprint imbalance stacks -----------------------------------------
  let stackScore = 0;
  let stacks = [];
  if (footprints.length) {
    const look = footprints.slice(-5);
    stacks = look.flatMap((fp, idx) =>
      fp.imbalanceStacks({ ratio: 3, minRun: 3 }).map((s) => ({ ...s, recency: (idx + 1) / look.length })));
    if (stacks.length) {
      let acc = 0, w = 0;
      for (const s of stacks) {
        const weight = s.recency * Math.min(1, s.size / 5) * Math.min(1, s.volume / 50 + 0.3);
        acc += s.dir * weight;
        w += weight;
      }
      stackScore = w ? clamp(acc / w, -1, 1) : 0;
    }
  }

  // --- CVD divergence ------------------------------------------------------
  const div = cvdDivergence(candles, { strength: 3, lookback: 80 });
  let cvdScore = 0;
  const fresh = (d) => d && d.barsAgo <= 5;
  if (fresh(div.bullish)) cvdScore += 0.5 + 0.5 * div.bullish.strength;
  if (fresh(div.bearish)) cvdScore -= 0.5 + 0.5 * div.bearish.strength;
  // With no divergence, lean on the slope of CVD itself.
  if (cvdScore === 0 && div.series?.length > 10) {
    const s = div.series;
    const change = s[s.length - 1] - s[s.length - 11];
    const scaleRef = Math.max(1e-9, mean(candles.slice(-10).map((c) => c.v ?? 0)) * 10);
    cvdScore = clamp(squash(change / scaleRef, 0.5), -1, 1) * 0.6;
  }
  cvdScore = clamp(cvdScore, -1, 1);

  // --- Order book imbalance ------------------------------------------------
  let obiScore = 0;
  let obi = null;
  if (book) {
    obi = orderBookImbalance(book, 20);
    // Weighted OBI dominates: near-touch size is what actually absorbs flow.
    obiScore = clamp(0.35 * obi.obi + 0.65 * obi.weightedObi, -1, 1);
  }

  // --- Absorption and spoofing --------------------------------------------
  let absorptionScore = 0;
  let absorbing = [], spoofs = [];
  if (wallTracker) {
    absorbing = wallTracker.absorption();
    spoofs = wallTracker.recentSpoofs();
    for (const w of absorbing) {
      // A held bid wall is support (bullish); a held ask wall is resistance.
      absorptionScore += (w.side === 'bid' ? 1 : -1) * clamp(w.zScore / 6, 0, 0.5);
    }
    // Spoofs on one side imply the opposite intent.
    for (const s of spoofs) absorptionScore += (s.side === 'bid' ? -1 : 1) * 0.12;
    absorptionScore = clamp(absorptionScore, -1, 1);
  }

  // --- Value-area location -------------------------------------------------
  const loc = valueLocation(profile, price);
  const locScore = loc === 'above' ? 0.4 : loc === 'below' ? -0.4 : 0;

  const out = blend([
    { key: 'delta', label: 'Footprint delta', score: deltaScore, weight: 0.24, detail: `${(lastDelta * 100).toFixed(0)}% of candle volume` },
    { key: 'stacks', label: 'Imbalance stacks', score: stackScore, weight: 0.18, detail: `${stacks.length} stack${stacks.length === 1 ? '' : 's'}` },
    { key: 'cvd', label: 'CVD divergence', score: cvdScore, weight: 0.22, detail: fresh(div.bullish) ? 'bullish absorption' : fresh(div.bearish) ? 'bearish exhaustion' : 'trend-aligned' },
    { key: 'obi', label: 'Book imbalance (20)', score: obiScore, weight: 0.18, detail: obi ? `${(obi.weightedObi * 100).toFixed(0)}% weighted` : 'no book' },
    { key: 'absorption', label: 'Walls / absorption', score: absorptionScore, weight: 0.1, detail: `${absorbing.length} held, ${spoofs.length} pulled` },
    { key: 'value', label: 'VPVR location', score: locScore, weight: 0.08, detail: `${loc} value` },
  ]);

  return {
    ...out,
    context: {
      ready: true,
      delta: lastDelta,
      // The spec gates Strong Long/Short on raw order flow delta sign.
      orderFlowDelta: recent.reduce((a, c) => a + ((c.buyVol ?? 0) - (c.sellVol ?? 0)), 0),
      profile,
      valueLocation: loc,
      cvd: div,
      obi,
      stacks,
      absorbing,
      spoofs,
    },
  };
}
