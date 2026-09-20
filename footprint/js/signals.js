// Signal provider.
//
// Each rule is a pure function of `bars[0..i]` plus precomputed indicator arrays.
// Nothing reads bars[i+1..], so what the backtester sees is exactly what a live
// trader would have seen at the close of bar i. Rules score in [0,1] and vote
// long or short; the provider combines those votes into signals.

import { computeContext } from './indicators.js';
import { clamp } from './util.js';

const norm = (v, full) => clamp(v / full, 0, 1);

/**
 * Rule registry. `params` are the tunables surfaced in the UI; `weight` is the
 * rule's vote size in composite mode.
 */
export const RULES = [
  {
    id: 'stackedImbalance',
    label: 'Stacked imbalance',
    description:
      'Three or more consecutive diagonal imbalances printing at one end of the bar. '
      + 'A buy stack sitting at the low marks aggressive buyers defending; a sell stack at the high marks the reverse.',
    weight: 1.0,
    enabled: true,
    params: {
      minStack: { label: 'Min stacked rows', value: 3, min: 2, max: 10, step: 1 },
      zonePct: { label: 'Must sit within % of extreme', value: 40, min: 10, max: 100, step: 5 },
    },
    detect({ bar, params }) {
      if (!bar.stacks?.length || !(bar.range > 0)) return null;
      const zone = (params.zonePct / 100) * bar.range;
      let best = null;
      for (const s of bar.stacks) {
        if (s.count < params.minStack) continue;
        const inLowZone = s.fromPrice <= bar.low + zone;
        const inHighZone = s.toPrice >= bar.high - zone;
        if (s.side === 'buy' && inLowZone) {
          const strength = norm(s.count - params.minStack + 1, 4);
          if (!best || strength > best.strength) {
            best = { side: 'long', strength, reason: `${s.count} stacked buy imbalances at the low` };
          }
        }
        if (s.side === 'sell' && inHighZone) {
          const strength = norm(s.count - params.minStack + 1, 4);
          if (!best || strength > best.strength) {
            best = { side: 'short', strength, reason: `${s.count} stacked sell imbalances at the high` };
          }
        }
      }
      return best;
    },
  },

  {
    id: 'deltaDivergence',
    label: 'Delta divergence',
    description:
      'Price takes out the prior swing extreme but delta fails to confirm — a new low on less aggressive selling, '
      + 'or a new high on less aggressive buying.',
    weight: 1.0,
    enabled: true,
    params: {
      lookback: { label: 'Swing lookback (bars)', value: 12, min: 3, max: 60, step: 1 },
      minGapPct: { label: 'Min delta improvement (% of bar vol)', value: 5, min: 0, max: 200, step: 5 },
    },
    detect({ bars, i, bar, params }) {
      const from = i - params.lookback;
      if (from < 0) return null;
      let loIdx = from;
      let hiIdx = from;
      for (let j = from; j < i; j++) {
        if (bars[j].low < bars[loIdx].low) loIdx = j;
        if (bars[j].high > bars[hiIdx].high) hiIdx = j;
      }
      const minGap = (params.minGapPct / 100) * Math.max(bar.volume, 1e-9);

      if (bar.low < bars[loIdx].low && bar.delta - bars[loIdx].delta >= minGap) {
        return {
          side: 'long',
          strength: norm(bar.delta - bars[loIdx].delta, Math.max(bar.volume, 1e-9)),
          reason: 'lower low on higher delta',
        };
      }
      if (bar.high > bars[hiIdx].high && bars[hiIdx].delta - bar.delta >= minGap) {
        return {
          side: 'short',
          strength: norm(bars[hiIdx].delta - bar.delta, Math.max(bar.volume, 1e-9)),
          reason: 'higher high on lower delta',
        };
      }
      return null;
    },
  },

  {
    id: 'absorption',
    label: 'Absorption at the extreme',
    description:
      'An outsized volume node at the bar extreme traded almost entirely into one side, yet price refused to follow — '
      + 'passive size absorbing the aggressor.',
    weight: 1.0,
    enabled: true,
    params: {
      nodeMult: { label: 'Extreme row vol vs avg row', value: 2.5, min: 1.2, max: 12, step: 0.2 },
      sideRatio: { label: 'Aggressor dominance at row', value: 1.8, min: 1.1, max: 8, step: 0.1 },
      closeLoc: { label: 'Close must reject by (% of range)', value: 55, min: 20, max: 95, step: 5 },
    },
    detect({ bar, params }) {
      if (!(bar.range > 0) || !(bar.avgRowVolume > 0)) return null;
      const loc = bar.closeLocation;
      const thresh = params.closeLoc / 100;

      const lowHeavy = bar.lowRowVolume >= params.nodeMult * bar.avgRowVolume;
      const lowSellers = bar.lowRowBid >= params.sideRatio * Math.max(bar.lowRowAsk, 1e-12);
      if (lowHeavy && lowSellers && loc >= thresh) {
        return {
          side: 'long',
          strength: clamp(0.4 * norm(bar.lowRowVolume / bar.avgRowVolume - params.nodeMult, 5) + 0.6 * norm(loc - thresh, 1 - thresh), 0, 1),
          reason: 'selling absorbed at the low',
        };
      }

      const highHeavy = bar.highRowVolume >= params.nodeMult * bar.avgRowVolume;
      const highBuyers = bar.highRowAsk >= params.sideRatio * Math.max(bar.highRowBid, 1e-12);
      if (highHeavy && highBuyers && loc <= 1 - thresh) {
        return {
          side: 'short',
          strength: clamp(0.4 * norm(bar.highRowVolume / bar.avgRowVolume - params.nodeMult, 5) + 0.6 * norm((1 - thresh) - loc, 1 - thresh), 0, 1),
          reason: 'buying absorbed at the high',
        };
      }
      return null;
    },
  },

  {
    id: 'trappedTraders',
    label: 'Trapped aggressors',
    description:
      'Heavy one-sided aggression that ends the bar on the wrong end of the range. Those market orders are underwater '
      + 'at the close and tend to be the fuel for the move against them.',
    weight: 1.0,
    enabled: true,
    params: {
      deltaPct: { label: 'Min |delta| (% of bar vol)', value: 15, min: 5, max: 90, step: 5 },
      closeLoc: { label: 'Close within % of the wrong end', value: 33, min: 5, max: 50, step: 1 },
      minVolZ: { label: 'Min volume z-score', value: 0, min: -2, max: 4, step: 0.25 },
    },
    detect({ bar, i, ind, params }) {
      if (!(bar.range > 0) || !(bar.volume > 0)) return null;
      const volZ = ind.volumeZ[i];
      if (Number.isFinite(volZ) && volZ < params.minVolZ) return null;
      const dp = bar.deltaPct;
      const loc = bar.closeLocation;
      const need = params.deltaPct / 100;
      const edge = params.closeLoc / 100;

      if (dp <= -need && loc >= 1 - edge) {
        return { side: 'long', strength: clamp(norm(-dp - need, 0.5), 0, 1), reason: 'sellers trapped — negative delta, close at the high' };
      }
      if (dp >= need && loc <= edge) {
        return { side: 'short', strength: clamp(norm(dp - need, 0.5), 0, 1), reason: 'buyers trapped — positive delta, close at the low' };
      }
      return null;
    },
  },

  {
    id: 'exhaustionTail',
    label: 'Exhaustion tail',
    description:
      'A new extreme printed on almost no volume at the tip. The auction ran out of participants rather than being '
      + 'pushed back — often the last bar of a leg.',
    weight: 0.8,
    enabled: false,
    params: {
      lookback: { label: 'New-extreme lookback', value: 15, min: 3, max: 60, step: 1 },
      tailMult: { label: 'Max tip vol vs avg row', value: 0.35, min: 0.05, max: 1, step: 0.05 },
      minRows: { label: 'Min rows in bar', value: 5, min: 2, max: 40, step: 1 },
    },
    detect({ bars, i, bar, params }) {
      if (bar.rowCount < params.minRows || !(bar.avgRowVolume > 0)) return null;
      const from = i - params.lookback;
      if (from < 0) return null;
      let priorLow = Infinity;
      let priorHigh = -Infinity;
      for (let j = from; j < i; j++) {
        if (bars[j].low < priorLow) priorLow = bars[j].low;
        if (bars[j].high > priorHigh) priorHigh = bars[j].high;
      }
      const ratioLow = bar.lowRowVolume / bar.avgRowVolume;
      const ratioHigh = bar.highRowVolume / bar.avgRowVolume;

      if (bar.low < priorLow && ratioLow <= params.tailMult) {
        return { side: 'long', strength: clamp(1 - ratioLow / params.tailMult, 0, 1), reason: 'new low on an empty tail' };
      }
      if (bar.high > priorHigh && ratioHigh <= params.tailMult) {
        return { side: 'short', strength: clamp(1 - ratioHigh / params.tailMult, 0, 1), reason: 'new high on an empty tail' };
      }
      return null;
    },
  },

  {
    id: 'valueMigration',
    label: 'Value migration',
    description:
      'The point of control steps in one direction for several bars while cumulative delta agrees — '
      + 'an acceptance-driven trend rather than a spike.',
    weight: 0.7,
    enabled: false,
    params: {
      steps: { label: 'Consecutive POC steps', value: 3, min: 2, max: 10, step: 1 },
      minCumDelta: { label: 'Min cum-delta slope (% of avg vol)', value: 10, min: 0, max: 200, step: 5 },
    },
    detect({ bars, i, bar, ind, params }) {
      const n = params.steps;
      if (i < n) return null;
      let up = true;
      let down = true;
      for (let j = i - n + 1; j <= i; j++) {
        if (!(bars[j].pocPrice > bars[j - 1].pocPrice)) up = false;
        if (!(bars[j].pocPrice < bars[j - 1].pocPrice)) down = false;
      }
      if (!up && !down) return null;
      const slope = bar.cumDelta - bars[i - n].cumDelta;
      const scale = Math.max(ind.volumeSma[i] || bar.volume, 1e-9);
      const need = (params.minCumDelta / 100) * scale;
      if (up && slope >= need) {
        return { side: 'long', strength: clamp(norm(slope, scale * 2), 0, 1), reason: `POC up ${n} bars with buying cum-delta` };
      }
      if (down && -slope >= need) {
        return { side: 'short', strength: clamp(norm(-slope, scale * 2), 0, 1), reason: `POC down ${n} bars with selling cum-delta` };
      }
      return null;
    },
  },

  {
    id: 'deltaFlip',
    label: 'Delta flip at value',
    description:
      'Delta changes sign against the prior bar while price is inside the previous bar\'s value area — '
      + 'a rotation starting from balance rather than chasing a breakout.',
    weight: 0.6,
    enabled: false,
    params: {
      minFlip: { label: 'Min |delta| both bars (% of vol)', value: 8, min: 5, max: 80, step: 5 },
    },
    detect({ bars, i, bar, params }) {
      if (i < 1) return null;
      const prev = bars[i - 1];
      if (!(bar.volume > 0) || !(prev.volume > 0)) return null;
      const need = params.minFlip / 100;
      if (Math.abs(bar.deltaPct) < need || Math.abs(prev.deltaPct) < need) return null;
      const inValue = bar.close >= prev.valPrice && bar.close <= prev.vahPrice;
      if (!inValue) return null;
      if (prev.delta < 0 && bar.delta > 0) {
        return { side: 'long', strength: clamp(norm(bar.deltaPct, 0.6), 0, 1), reason: 'delta flipped positive inside prior value' };
      }
      if (prev.delta > 0 && bar.delta < 0) {
        return { side: 'short', strength: clamp(norm(-bar.deltaPct, 0.6), 0, 1), reason: 'delta flipped negative inside prior value' };
      }
      return null;
    },
  },
];

export const DEFAULT_SIGNAL_CONFIG = {
  mode: 'composite',        // 'composite' (weighted vote) | 'any' (each rule fires)
  threshold: 1.0,           // min |score| in composite mode
  cooldownBars: 3,          // bars to wait before another signal on the same side
  trendFilter: 'off',       // 'off' | 'with' | 'against'
  trendPeriod: 34,
  minVolumeZ: -5,           // skip dead bars
  atrPeriod: 14,
  volPeriod: 20,
  rules: Object.fromEntries(
    RULES.map((r) => [
      r.id,
      {
        enabled: r.enabled,
        weight: r.weight,
        params: Object.fromEntries(Object.entries(r.params).map(([k, v]) => [k, v.value])),
      },
    ]),
  ),
};

export function ruleById(id) {
  return RULES.find((r) => r.id === id);
}

/**
 * Generate signals for a bar series.
 *
 * A signal produced on bar i is timestamped at that bar's close: it becomes
 * actionable on bar i+1. Unclosed bars are skipped.
 *
 * @returns {Array<object>} signals in bar order.
 */
export function generateSignals(bars, config = {}) {
  const cfg = { ...DEFAULT_SIGNAL_CONFIG, ...config, rules: { ...DEFAULT_SIGNAL_CONFIG.rules, ...(config.rules || {}) } };
  const ind = computeContext(bars, {
    atrPeriod: cfg.atrPeriod,
    volPeriod: cfg.volPeriod,
    lookback: cfg.trendPeriod,
  });

  const active = RULES.filter((r) => cfg.rules[r.id]?.enabled);
  const signals = [];
  const lastFired = { long: -Infinity, short: -Infinity };

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    if (!bar.closed || !(bar.volume > 0)) continue;

    const volZ = ind.volumeZ[i];
    if (Number.isFinite(volZ) && volZ < cfg.minVolumeZ) continue;

    let longScore = 0;
    let shortScore = 0;
    const hits = [];

    for (const rule of active) {
      const rc = cfg.rules[rule.id];
      let hit = null;
      try {
        hit = rule.detect({ bars, i, bar, ind, params: rc.params, config: cfg });
      } catch {
        hit = null; // a misconfigured rule must not take the whole run down
      }
      if (!hit) continue;
      const strength = clamp(Number(hit.strength) || 0, 0, 1);
      const contribution = rc.weight * (0.5 + 0.5 * strength);
      if (hit.side === 'long') longScore += contribution;
      else shortScore += contribution;
      hits.push({ rule: rule.id, label: rule.label, side: hit.side, strength, reason: hit.reason });
    }

    if (!hits.length) continue;

    const candidates = [];
    if (cfg.mode === 'any') {
      for (const h of hits) {
        candidates.push({
          side: h.side,
          score: cfg.rules[h.rule].weight * (0.5 + 0.5 * h.strength),
          type: h.rule,
          label: h.label,
          hits: [h],
        });
      }
    } else {
      const net = longScore - shortScore;
      if (Math.abs(net) >= cfg.threshold) {
        const side = net > 0 ? 'long' : 'short';
        const agreeing = hits.filter((h) => h.side === side);
        candidates.push({
          side,
          score: Math.abs(net),
          type: agreeing.map((h) => h.rule).join('+') || 'composite',
          label: agreeing.map((h) => h.label).join(' + '),
          hits: agreeing,
        });
      }
    }

    for (const c of candidates) {
      // Trend filter measured against the closing EMA, known at this bar.
      const trend = ind.ema[i];
      if (cfg.trendFilter !== 'off' && Number.isFinite(trend)) {
        const withTrend = c.side === 'long' ? bar.close > trend : bar.close < trend;
        if (cfg.trendFilter === 'with' && !withTrend) continue;
        if (cfg.trendFilter === 'against' && withTrend) continue;
      }
      if (i - lastFired[c.side] < cfg.cooldownBars) continue;
      lastFired[c.side] = i;

      signals.push({
        barIndex: i,
        time: bar.closeTime,
        signalTime: bar.closeTime,
        price: bar.close,
        side: c.side,
        type: c.type,
        label: c.label,
        score: Number(c.score.toFixed(3)),
        reasons: c.hits.map((h) => h.reason),
        hits: c.hits,
        atr: ind.atr[i],
        delta: bar.delta,
        volume: bar.volume,
      });
    }
  }

  return signals;
}
