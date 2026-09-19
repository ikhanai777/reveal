// Signal Confidence Score (SCS) matrix.
//
// Each factor reports a directional score in [-1, 1]. The weighted sum is
// mapped onto 0-100 with 50 as dead neutral, so the thresholds in the spec
// read directly off the number.

import { clamp } from '../core/num.js';

export const DEFAULT_WEIGHTS = {
  ta: 0.25,          // Technical Analysis
  orderFlow: 0.30,   // Order Flow & Footprint
  derivatives: 0.15, // Derivatives & On-Chain
  news: 0.15,        // News & Sentiment
  ml: 0.15,          // Machine Learning Forecast
};

export const FACTOR_LABELS = {
  ta: 'Technicals',
  orderFlow: 'Order Flow',
  derivatives: 'Derivatives / On-Chain',
  news: 'News & Sentiment',
  ml: 'ML Forecast',
};

export const THRESHOLDS = {
  strongLong: 80,
  weakLong: 65,
  weakShort: 35,
  strongShort: 20,
};

export const BIAS = {
  STRONG_LONG: 'STRONG_LONG',
  WEAK_LONG: 'WEAK_LONG',
  NEUTRAL: 'NEUTRAL',
  WEAK_SHORT: 'WEAK_SHORT',
  STRONG_SHORT: 'STRONG_SHORT',
};

/**
 * Combine factor results into an SCS.
 *
 * A factor that reports `context.ready === false` is excluded and its weight
 * is redistributed, rather than being counted as a neutral vote — an engine
 * that is still warming up must not drag every score toward 50.
 *
 * @param {Record<string, {score:number, components:object[], context:object}>} factors
 * @param {object} [weights]
 */
export function computeSCS(factors, weights = DEFAULT_WEIGHTS) {
  let num = 0, den = 0;
  const breakdown = [];
  for (const [key, w] of Object.entries(weights)) {
    const f = factors[key];
    const ready = f && f.context?.ready !== false;
    if (ready) { num += clamp(f.score, -1, 1) * w; den += w; }
    breakdown.push({
      key,
      label: FACTOR_LABELS[key] || key,
      weight: w,
      ready: !!ready,
      score: ready ? clamp(f.score, -1, 1) : null,
      scaled: ready ? 50 + 50 * clamp(f.score, -1, 1) : null,
      contribution: ready ? clamp(f.score, -1, 1) * w : 0,
      components: f?.components || [],
      detail: f?.context?.reason,
    });
  }
  const directional = den ? num / den : 0;
  return {
    scs: clamp(50 + 50 * directional, 0, 100),
    directional,
    coverage: den,           // total weight of factors that actually reported
    breakdown,
  };
}

/**
 * Regime and volatility filters. These do not change the SCS; they veto or
 * downgrade an emission, and every veto is recorded so the log explains why a
 * high score produced no trade.
 */
export function regimeFilters(ctx, cfg = {}) {
  const {
    minAdx = 15,
    maxSpreadBps = 8,
    minAtrPct = 0.0004,
    maxAtrPct = 0.06,
    newsBlackoutTags = ['exploit', 'venue-risk'],
    newsBlackoutMs = 15 * 60_000,
  } = cfg;

  const vetoes = [];
  const warnings = [];

  const adx = ctx.ta?.context?.adx;
  if (adx != null && adx < minAdx) warnings.push(`ADX ${adx.toFixed(1)} below trend floor ${minAdx}`);

  const atrPct = ctx.ta?.context?.atrPct;
  if (atrPct != null) {
    if (atrPct < minAtrPct) vetoes.push(`volatility too low (ATR ${(atrPct * 100).toFixed(3)}%)`);
    if (atrPct > maxAtrPct) vetoes.push(`volatility too high (ATR ${(atrPct * 100).toFixed(2)}%)`);
  }

  const spread = ctx.orderFlow?.context?.obi?.spreadBps;
  if (spread != null && Number.isFinite(spread) && spread > maxSpreadBps) {
    vetoes.push(`spread ${spread.toFixed(1)}bps above ${maxSpreadBps}bps`);
  }

  const news = ctx.news?.context;
  if (news?.tags?.some((t) => newsBlackoutTags.includes(t))) {
    const recent = news.items?.[0];
    if (recent && Date.now() - recent.ts < newsBlackoutMs) {
      vetoes.push(`news blackout: ${news.tags.filter((t) => newsBlackoutTags.includes(t)).join(', ')}`);
    }
  }

  return { pass: vetoes.length === 0, vetoes, warnings };
}

/**
 * Apply the spec's threshold ladder, including the confirmation gates that
 * separate a Strong signal from a Weak one.
 */
export function classify(scs, { orderFlowDelta = 0, newsSentiment = 0 } = {}, thresholds = THRESHOLDS) {
  if (scs >= thresholds.strongLong) {
    const gates = [];
    if (!(orderFlowDelta > 0)) gates.push('order flow delta not positive');
    if (!(newsSentiment >= -0.1)) gates.push('news sentiment below -0.1');
    return gates.length
      ? { bias: BIAS.WEAK_LONG, direction: 1, strength: 'weak', downgraded: true, gatesFailed: gates }
      : { bias: BIAS.STRONG_LONG, direction: 1, strength: 'strong', downgraded: false, gatesFailed: [] };
  }
  if (scs >= thresholds.weakLong) {
    return { bias: BIAS.WEAK_LONG, direction: 1, strength: 'weak', downgraded: false, gatesFailed: [] };
  }
  if (scs <= thresholds.strongShort) {
    const gates = [];
    if (!(orderFlowDelta < 0)) gates.push('order flow delta not negative');
    if (!(newsSentiment <= 0.1)) gates.push('news sentiment above 0.1');
    return gates.length
      ? { bias: BIAS.WEAK_SHORT, direction: -1, strength: 'weak', downgraded: true, gatesFailed: gates }
      : { bias: BIAS.STRONG_SHORT, direction: -1, strength: 'strong', downgraded: false, gatesFailed: [] };
  }
  if (scs <= thresholds.weakShort) {
    return { bias: BIAS.WEAK_SHORT, direction: -1, strength: 'weak', downgraded: false, gatesFailed: [] };
  }
  return { bias: BIAS.NEUTRAL, direction: 0, strength: 'none', downgraded: false, gatesFailed: [] };
}

/**
 * Full evaluation: score, classify, filter.
 * @returns {{scs:number, breakdown:object[], classification:object, filters:object, actionable:boolean}}
 */
export function evaluate(factors, { weights = DEFAULT_WEIGHTS, thresholds = THRESHOLDS, filterCfg } = {}) {
  const scored = computeSCS(factors, weights);
  const gateInputs = {
    orderFlowDelta: factors.orderFlow?.context?.orderFlowDelta ?? 0,
    newsSentiment: factors.news?.context?.newsSentiment ?? 0,
  };
  const classification = classify(scored.scs, gateInputs, thresholds);
  const filters = regimeFilters(factors, filterCfg);
  return {
    ...scored,
    gateInputs,
    classification,
    filters,
    actionable: classification.direction !== 0 && filters.pass,
  };
}
