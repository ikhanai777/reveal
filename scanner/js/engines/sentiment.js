// News & sentiment factor.
//
// The classifier is pluggable: production wires an LLM adapter through
// `setClassifier`, and the built-in lexicon scorer is the deterministic
// fallback so the factor still contributes offline and in tests. Both return
// the same contract — a polarity in [-1, 1] with a confidence.

import { blend } from './ta.js';
import { clamp, mean, stdev } from '../core/num.js';

/** High-impact keywords, weighted by how hard they historically move price. */
export const IMPACT_KEYWORDS = [
  { re: /\b(hack|hacked|exploit|drained|rug ?pull)\b/i, tag: 'exploit', weight: -1.0 },
  { re: /\b(sec (approval|approves)|etf approv\w*)\b/i, tag: 'sec-approval', weight: 1.0 },
  { re: /\b(sec (sues|charges|lawsuit)|enforcement|subpoena)\b/i, tag: 'regulatory', weight: -0.8 },
  { re: /\b(delisting|delisted|halt(ed)? withdrawals?|insolvency|bankrupt\w*)\b/i, tag: 'venue-risk', weight: -0.9 },
  { re: /\b(mainnet|upgrade|hard ?fork|halving)\b/i, tag: 'upgrade', weight: 0.6 },
  { re: /\b(partnership|integration|listing|listed on)\b/i, tag: 'listing', weight: 0.5 },
  { re: /\b(unlock|vesting|token release)\b/i, tag: 'unlock', weight: -0.5 },
  { re: /\b(liquidat\w+|cascade|deleverag\w+)\b/i, tag: 'liquidation', weight: -0.6 },
  { re: /\b(inflow|accumulat\w+|buyback|treasury purchase)\b/i, tag: 'accumulation', weight: 0.5 },
];

const POSITIVE = ['surge', 'rally', 'soar', 'bullish', 'breakout', 'adoption', 'approval', 'record high', 'gain', 'inflow', 'upgrade', 'optimism', 'beat'];
const NEGATIVE = ['plunge', 'crash', 'dump', 'bearish', 'breakdown', 'ban', 'fraud', 'exploit', 'outflow', 'selloff', 'fear', 'lawsuit', 'liquidation', 'downgrade'];

/** Deterministic lexicon scorer: polarity in [-1,1] with a coverage-based confidence. */
export function lexiconScore(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return { polarity: 0, confidence: 0, tags: [] };
  let hits = 0, acc = 0;
  for (const w of POSITIVE) if (t.includes(w)) { acc += 1; hits++; }
  for (const w of NEGATIVE) if (t.includes(w)) { acc -= 1; hits++; }
  const tags = [];
  for (const k of IMPACT_KEYWORDS) {
    if (k.re.test(text)) { tags.push(k.tag); acc += k.weight * 2; hits += 2; }
  }
  const polarity = hits ? clamp(acc / Math.max(2, hits), -1, 1) : 0;
  return { polarity, confidence: hits ? clamp(0.3 + hits * 0.15, 0, 0.9) : 0, tags };
}

export class SentimentEngine {
  constructor({ halfLifeMs = 45 * 60_000, keep = 400 } = {}) {
    this.halfLifeMs = halfLifeMs;
    this.keep = keep;
    this.items = [];                 // { ts, symbol, headline, source, polarity, confidence, tags }
    this.classifier = null;          // async (text) => { polarity, confidence, tags }
    this.mentionBuckets = new Map(); // symbol -> [{ minute, count }]
  }

  /** Wire an LLM (or any async scorer) in place of the lexicon fallback. */
  setClassifier(fn) { this.classifier = fn; }

  async ingest({ ts = Date.now(), symbol = null, headline, source = 'unknown', body = '' }) {
    const text = `${headline} ${body}`.trim();
    let scored;
    if (this.classifier) {
      try { scored = await this.classifier(text); } catch { scored = null; }
    }
    if (!scored || typeof scored.polarity !== 'number') scored = lexiconScore(text);
    const item = {
      ts, symbol, headline, source,
      polarity: clamp(scored.polarity, -1, 1),
      confidence: clamp(scored.confidence ?? 0.5, 0, 1),
      tags: scored.tags || [],
    };
    this.items.push(item);
    if (this.items.length > this.keep) this.items.shift();
    this.countMention(symbol, ts);
    return item;
  }

  countMention(symbol, ts) {
    if (!symbol) return;
    const minute = Math.floor(ts / 60_000);
    if (!this.mentionBuckets.has(symbol)) this.mentionBuckets.set(symbol, []);
    const arr = this.mentionBuckets.get(symbol);
    const last = arr[arr.length - 1];
    if (last && last.minute === minute) last.count++;
    else arr.push({ minute, count: 1 });
    if (arr.length > 240) arr.shift();
  }

  /** Mention rate vs its own 60-minute baseline, in standard deviations. */
  socialVelocity(symbol, now = Date.now()) {
    const arr = this.mentionBuckets.get(symbol) || [];
    if (arr.length < 10) return { z: 0, current: 0, baseline: 0 };
    const minute = Math.floor(now / 60_000);
    const current = arr.filter((b) => minute - b.minute <= 5).reduce((a, b) => a + b.count, 0) / 5;
    const hist = arr.filter((b) => minute - b.minute > 5).map((b) => b.count);
    const base = mean(hist);
    const sd = stdev(hist) || 1;
    return { z: (current - base) / sd, current, baseline: base };
  }

  /** Exponentially time-decayed, confidence-weighted polarity for a symbol. */
  aggregate(symbol, now = Date.now()) {
    const relevant = this.items.filter((i) => !i.symbol || i.symbol === symbol);
    if (!relevant.length) return { polarity: 0, weight: 0, items: [], tags: [] };
    let num = 0, den = 0;
    const tags = new Set();
    for (const i of relevant) {
      const age = Math.max(0, now - i.ts);
      const decay = Math.pow(0.5, age / this.halfLifeMs);
      // Market-wide headlines count for less than symbol-specific ones.
      const relevance = i.symbol === symbol ? 1 : 0.45;
      const w = decay * i.confidence * relevance;
      if (w < 0.01) continue;
      num += i.polarity * w;
      den += w;
      for (const t of i.tags) tags.add(t);
    }
    return {
      polarity: den ? clamp(num / den, -1, 1) : 0,
      weight: den,
      tags: [...tags],
      items: relevant.slice(-12).reverse(),
    };
  }
}

/** Factor score. `newsSentiment` in the return is the value the gates read. */
export function scoreSentiment(engine, symbol, now = Date.now()) {
  const agg = engine.aggregate(symbol, now);
  const vel = engine.socialVelocity(symbol, now);

  const newsScore = agg.polarity;
  // Velocity is an amplifier, not a direction: a mention spike with no polarity
  // is noise, and one aligned with polarity is conviction.
  const velScore = clamp(Math.tanh(vel.z / 2) * Math.sign(agg.polarity || 0) * Math.min(1, Math.abs(agg.polarity) * 2), -1, 1);
  const keywordHit = agg.tags.length
    ? clamp(agg.tags.reduce((a, t) => a + (IMPACT_KEYWORDS.find((k) => k.tag === t)?.weight ?? 0), 0) / 2, -1, 1)
    : 0;

  const out = blend([
    { key: 'news', label: 'Headline sentiment', score: newsScore, weight: 0.55, detail: agg.weight ? `${agg.polarity.toFixed(2)} across ${agg.items.length}` : 'no coverage' },
    { key: 'keywords', label: 'High-impact triggers', score: keywordHit, weight: 0.25, detail: agg.tags.length ? agg.tags.join(', ') : 'none' },
    { key: 'velocity', label: 'Social velocity', score: velScore, weight: 0.2, detail: `${vel.z.toFixed(1)}σ` },
  ]);

  return {
    ...out,
    // Coverage gate: no news means no opinion, not a neutral vote against.
    score: agg.weight < 0.05 ? 0 : out.score,
    context: {
      ready: true,
      newsSentiment: agg.polarity,
      coverage: agg.weight,
      tags: agg.tags,
      velocity: vel,
      items: agg.items,
    },
  };
}
