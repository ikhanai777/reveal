// Technical Analysis factor.
// Produces a directional score in [-1, 1] plus the per-component breakdown the
// UI renders as a radar and the tracker stores with each signal.

import { emaRibbon, macd, rsi, adx, atr, bbSqueeze } from './indicators.js';
import { marketStructure, fairValueGaps, divergence } from './structure.js';
import { clamp, squash, scale } from '../core/num.js';

/** Weighted blend of components, each carrying its own [-1,1] score. */
export function blend(components) {
  let num = 0, den = 0;
  for (const c of components) {
    if (c.score == null || Number.isNaN(c.score)) continue;
    num += c.score * c.weight;
    den += c.weight;
  }
  const score = den ? clamp(num / den, -1, 1) : 0;
  return {
    score,
    components: components.map((c) => ({
      ...c,
      contribution: den && c.score != null ? (c.score * c.weight) / den : 0,
    })),
  };
}

/**
 * @param {object[]} candles closed candles, oldest-first
 * @returns {{score:number, components:object[], context:object}}
 */
export function scoreTechnicals(candles, { adxTrendFloor = 20 } = {}) {
  if (!candles || candles.length < 60) {
    return { score: 0, components: [], context: { ready: false, reason: 'warming up' } };
  }
  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const price = closes[i];

  const ribbon = emaRibbon(closes);
  const m = macd(closes);
  const r = rsi(closes, 14);
  const a = adx(candles, 14);
  const atrArr = atr(candles, 14);
  const sq = bbSqueeze(closes);
  const ms = marketStructure(candles, { strength: 3 });
  const fvgs = fairValueGaps(candles);
  const rsiDiv = divergence(candles, r, { strength: 3, lookback: 60 });

  const atrNow = atrArr[i] ?? null;
  const atrPct = atrNow && price ? atrNow / price : null;
  const adxNow = a.adx[i];
  const diSpread = a.plusDI[i] != null && a.minusDI[i] != null ? a.plusDI[i] - a.minusDI[i] : null;

  // --- Components -----------------------------------------------------------

  // Ribbon: stack direction, damped when the ribbon is compressed (no trend).
  const ribbonScore = ribbon.ready
    ? ribbon.stack * clamp((ribbon.width ?? 0) / 0.01, 0.25, 1)
    : 0;

  // MACD histogram relative to ATR, so the reading is comparable across assets.
  const histNow = m.hist[i];
  const histPrev = m.hist[i - 1];
  const macdScore = histNow != null && atrNow
    ? clamp(squash(histNow / atrNow, 0.6) * (histPrev != null && Math.abs(histNow) > Math.abs(histPrev) ? 1 : 0.7), -1, 1)
    : 0;

  // RSI: mean-reverting at the extremes, trend-confirming in the middle.
  const rsiNow = r[i];
  let rsiScore = 0;
  if (rsiNow != null) {
    if (rsiNow >= 70) rsiScore = scale(rsiNow, 70, 90, 0.2, -0.8);        // overbought fades
    else if (rsiNow <= 30) rsiScore = scale(rsiNow, 10, 30, 0.8, -0.2);   // oversold bids
    else rsiScore = scale(rsiNow, 30, 70, -0.55, 0.55);
  }
  if (rsiDiv.bullish && rsiDiv.bullish.barsAgo <= 4) rsiScore = clamp(rsiScore + 0.45, -1, 1);
  if (rsiDiv.bearish && rsiDiv.bearish.barsAgo <= 4) rsiScore = clamp(rsiScore - 0.45, -1, 1);

  // ADX is a strength gate, not a direction: it scales the DI spread.
  const trendStrength = adxNow != null ? clamp((adxNow - adxTrendFloor) / 25, 0, 1) : 0;
  const adxScore = diSpread != null ? clamp(squash(diSpread, 20) * (0.4 + 0.6 * trendStrength), -1, 1) : 0;

  // Structure: the last MSB/ChoCh, decayed by how long ago it fired.
  let structureScore = 0;
  if (ms.lastEvent) {
    const decay = clamp(1 - (ms.barsSinceEvent ?? 0) / 40, 0, 1);
    structureScore = ms.lastEvent.dir * decay * (ms.lastEvent.type === 'ChoCh' ? 1 : 0.75);
  }

  // Unfilled FVGs near price pull toward themselves.
  const openGaps = fvgs.filter((g) => !g.filled).slice(-6);
  let fvgScore = 0;
  if (openGaps.length) {
    let acc = 0, w = 0;
    for (const g of openGaps) {
      const center = (g.from + g.to) / 2;
      const dist = Math.abs(center - price) / price;
      const weight = Math.exp(-dist * 300) * clamp(g.size * 400, 0.2, 1);
      acc += g.dir * weight;
      w += weight;
    }
    fvgScore = w ? clamp(acc / w, -1, 1) : 0;
  }

  // A squeeze is directionless until it expands; then it amplifies the ribbon.
  const squeezeScore = sq.squeeze ? 0 : sq.expanding ? ribbonScore * 0.8 : ribbonScore * 0.3;

  const out = blend([
    { key: 'ribbon', label: 'EMA ribbon 8/21/55/200', score: ribbonScore, weight: 0.22, detail: ribbon.ready ? `stack ${ribbon.stack > 0 ? 'bullish' : ribbon.stack < 0 ? 'bearish' : 'tangled'}` : 'warming up' },
    { key: 'macd', label: 'MACD histogram', score: macdScore, weight: 0.16, detail: histNow != null ? histNow.toFixed(4) : '—' },
    { key: 'rsi', label: 'RSI + divergence', score: rsiScore, weight: 0.18, detail: rsiNow != null ? `RSI ${rsiNow.toFixed(1)}${rsiDiv.bullish?.barsAgo <= 4 ? ' • bull div' : ''}${rsiDiv.bearish?.barsAgo <= 4 ? ' • bear div' : ''}` : '—' },
    { key: 'adx', label: 'ADX / DI spread', score: adxScore, weight: 0.14, detail: adxNow != null ? `ADX ${adxNow.toFixed(1)}` : '—' },
    { key: 'structure', label: 'MSB / ChoCh', score: structureScore, weight: 0.18, detail: ms.lastEvent ? `${ms.lastEvent.type} ${ms.lastEvent.dir > 0 ? 'up' : 'down'} ${ms.barsSinceEvent} bars ago` : 'no break' },
    { key: 'fvg', label: 'Fair value gaps', score: fvgScore, weight: 0.06, detail: `${openGaps.length} open` },
    { key: 'squeeze', label: 'BB squeeze / expansion', score: squeezeScore, weight: 0.06, detail: sq.squeeze ? 'coiled' : sq.expanding ? 'expanding' : 'neutral' },
  ]);

  return {
    ...out,
    context: {
      ready: true,
      price,
      atr: atrNow,
      atrPct,
      adx: adxNow,
      trendStrength,
      rsi: rsiNow,
      ribbon,
      squeeze: sq,
      structure: ms,
      fvgs: openGaps,
      rsiDivergence: rsiDiv,
      swingHigh: ms.lastSwingHigh?.price ?? null,
      swingLow: ms.lastSwingLow?.price ?? null,
    },
  };
}
