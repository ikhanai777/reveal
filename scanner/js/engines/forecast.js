// ML forecasting factor.
//
// Ships an online multinomial logistic classifier over engineered market
// features, producing P(up) / P(down) / P(side) per horizon. It learns from
// realized outcomes as bars close, so it is useful from a cold start and needs
// no training pipeline to deploy.
//
// The heavier TFT/XGBoost ensemble in the spec is a served model, not a
// browser one: implement the `Forecaster` interface below (`predict`, and
// optionally `observe`) against your inference endpoint and hand it to the
// scoring engine in place of this class. `RemoteForecaster` is that adapter.

import { sigmoid, clamp, mean, stdev } from '../core/num.js';
import { ema, rsi, atr, macd } from './indicators.js';

export const CLASSES = ['down', 'side', 'up'];

/** Running standardizer: keeps features comparable as regimes shift. */
class Standardizer {
  constructor(n) {
    this.n = 0;
    this.meanV = new Array(n).fill(0);
    this.m2 = new Array(n).fill(0);
  }

  update(x) {
    this.n++;
    for (let i = 0; i < x.length; i++) {
      const d = x[i] - this.meanV[i];
      this.meanV[i] += d / this.n;
      this.m2[i] += d * (x[i] - this.meanV[i]);
    }
  }

  transform(x) {
    return x.map((v, i) => {
      const sd = this.n > 2 ? Math.sqrt(this.m2[i] / (this.n - 1)) : 0;
      return sd > 1e-9 ? clamp((v - this.meanV[i]) / sd, -5, 5) : 0;
    });
  }
}

/**
 * Feature vector from a candle window. Deliberately small and all
 * scale-invariant, so one model generalizes across symbols.
 */
export function features(candles) {
  if (candles.length < 60) return null;
  const closes = candles.map((c) => c.c);
  const i = closes.length - 1;
  const price = closes[i];
  const a = atr(candles, 14)[i] || price * 0.001;
  const e8 = ema(closes, 8)[i], e21 = ema(closes, 21)[i], e55 = ema(closes, 55)[i];
  const r = rsi(closes, 14)[i] ?? 50;
  const m = macd(closes);
  const vols = candles.slice(-20).map((c) => c.v ?? 0);
  const volNow = candles[i].v ?? 0;
  const volMean = mean(vols) || 1;
  const deltas = candles.slice(-10).map((c) => {
    const v = (c.buyVol ?? 0) + (c.sellVol ?? 0);
    return v ? ((c.buyVol ?? 0) - (c.sellVol ?? 0)) / v : 0;
  });
  const ret = (n) => (closes[i - n] ? (price - closes[i - n]) / closes[i - n] : 0);

  return [
    ret(1) / (a / price),                       // 1-bar return in ATR units
    ret(5) / (a / price),
    ret(20) / (a / price),
    e8 != null && e21 != null ? (e8 - e21) / a : 0,
    e21 != null && e55 != null ? (e21 - e55) / a : 0,
    (r - 50) / 25,
    m.hist[i] != null ? m.hist[i] / a : 0,
    (volNow - volMean) / (stdev(vols) || volMean),
    mean(deltas),
    deltas[deltas.length - 1] ?? 0,
    a / price * 100,                            // volatility level
    (Math.max(...closes.slice(-20)) - price) / a, // distance to 20-bar high
    (price - Math.min(...closes.slice(-20))) / a, // distance to 20-bar low
  ];
}

/** Online softmax regression over the three outcome classes. */
export class OnlineSoftmax {
  constructor(nFeatures, { lr = 0.05, l2 = 1e-4 } = {}) {
    this.nf = nFeatures;
    this.lr = lr;
    this.l2 = l2;
    this.W = CLASSES.map(() => new Array(nFeatures).fill(0));
    this.b = CLASSES.map(() => 0);
    this.std = new Standardizer(nFeatures);
    this.samples = 0;
    this.correct = 0;
  }

  probs(xRaw) {
    const x = this.std.transform(xRaw);
    const logits = this.W.map((w, k) => w.reduce((a, wi, i) => a + wi * x[i], 0) + this.b[k]);
    const mx = Math.max(...logits);
    const exps = logits.map((z) => Math.exp(clamp(z - mx, -40, 40)));
    const s = exps.reduce((a, b) => a + b, 0) || 1;
    return exps.map((e) => e / s);
  }

  /** One SGD step against a realized class index. */
  learn(xRaw, classIdx) {
    this.std.update(xRaw);
    const p = this.probs(xRaw);
    const x = this.std.transform(xRaw);
    if (p.indexOf(Math.max(...p)) === classIdx) this.correct++;
    this.samples++;
    for (let k = 0; k < CLASSES.length; k++) {
      const g = p[k] - (k === classIdx ? 1 : 0);
      for (let i = 0; i < this.nf; i++) {
        this.W[k][i] -= this.lr * (g * x[i] + this.l2 * this.W[k][i]);
      }
      this.b[k] -= this.lr * g;
    }
    return p;
  }

  get accuracy() { return this.samples ? this.correct / this.samples : 0; }

  toJSON() { return { W: this.W, b: this.b, samples: this.samples, correct: this.correct, mean: this.std.meanV, m2: this.std.m2, n: this.std.n }; }

  static fromJSON(j, nf) {
    const m = new OnlineSoftmax(nf);
    Object.assign(m, { W: j.W, b: j.b, samples: j.samples, correct: j.correct });
    m.std.meanV = j.mean; m.std.m2 = j.m2; m.std.n = j.n;
    return m;
  }
}

/**
 * Multi-horizon forecaster. Each horizon is its own model because the
 * feature-to-outcome relationship at 15m differs from 4h.
 */
export class Forecaster {
  constructor({ horizons = [3, 12, 48], sideBandAtr = 0.5 } = {}) {
    // Horizons are in bars; at 5m those are 15m / 1h / 4h.
    this.horizons = horizons;
    this.sideBandAtr = sideBandAtr;
    this.models = new Map(horizons.map((h) => [h, new OnlineSoftmax(13)]));
    this.pending = new Map(horizons.map((h) => [h, []]));
  }

  /** @returns {{horizons: Array<{bars:number,p:number[],confidence:number}>}|null} */
  predict(candles) {
    const x = features(candles);
    if (!x) return null;
    const out = [];
    for (const h of this.horizons) {
      const p = this.models.get(h).probs(x);
      // Confidence = margin between the top two classes, damped until the
      // model has actually seen data.
      const sorted = [...p].sort((a, b) => b - a);
      const warmth = clamp(this.models.get(h).samples / 200, 0, 1);
      out.push({ bars: h, p: { down: p[0], side: p[1], up: p[2] }, confidence: (sorted[0] - sorted[1]) * warmth });
    }
    return { horizons: out, features: x };
  }

  /**
   * Record the current state, then resolve any observation whose horizon has
   * now elapsed. Call once per closed bar.
   */
  observe(candles) {
    const x = features(candles);
    if (!x) return;
    const i = candles.length - 1;
    const price = candles[i].c;
    const a = atr(candles, 14)[i] || price * 0.002;

    for (const h of this.horizons) {
      const queue = this.pending.get(h);
      queue.push({ index: i, x, price, band: a * this.sideBandAtr });
      while (queue.length && i - queue[0].index >= h) {
        const s = queue.shift();
        const move = price - s.price;
        const cls = move > s.band ? 2 : move < -s.band ? 0 : 1;
        this.models.get(h).learn(s.x, cls);
      }
    }
  }

  get stats() {
    return this.horizons.map((h) => ({
      bars: h,
      samples: this.models.get(h).samples,
      accuracy: this.models.get(h).accuracy,
    }));
  }
}

/** Adapter for a served TFT/XGBoost endpoint. Same interface as `Forecaster`. */
export class RemoteForecaster {
  constructor({ url, fetchImpl, horizons = [3, 12, 48], timeoutMs = 1500 }) {
    this.url = url;
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.horizons = horizons;
    this.timeoutMs = timeoutMs;
    this.latest = null;
  }

  /** Synchronous read of the last response; `refresh` does the network call. */
  predict() { return this.latest; }

  async refresh(candles) {
    const x = features(candles);
    if (!x || !this.fetch) return null;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    try {
      const res = await this.fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ features: x, horizons: this.horizons }),
        signal: ctl?.signal,
      });
      if (!res.ok) return null;
      this.latest = await res.json();
      return this.latest;
    } catch {
      return null;   // stale-but-safe: scoring treats a missing forecast as neutral
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  observe() { /* training happens server-side */ }
}

/** Collapse a multi-horizon forecast into one [-1,1] directional score. */
export function scoreForecast(prediction) {
  if (!prediction?.horizons?.length) {
    return { score: 0, components: [], context: { ready: false, reason: 'no forecast' } };
  }
  // An untrained model's confidence is damped to ~0 by design. Reporting that
  // as a neutral 50 would spend 15% of the matrix on an opinion the model does
  // not have, muting every factor that does; it abstains until it has trained.
  if (prediction.horizons.every((h) => h.confidence < 0.02)) {
    return { score: 0, components: [], context: { ready: false, reason: 'model warming up' } };
  }
  // Near horizons dominate entry timing; far horizons set the bias.
  const weights = [0.45, 0.35, 0.2];
  let num = 0, den = 0;
  const components = prediction.horizons.map((h, idx) => {
    const dir = h.p.up - h.p.down;
    const w = weights[idx] ?? 0.2;
    num += dir * w * (0.4 + 0.6 * h.confidence);
    den += w;
    return {
      key: `h${h.bars}`,
      label: `${h.bars}-bar horizon`,
      score: clamp(dir, -1, 1),
      weight: w,
      detail: `up ${(h.p.up * 100).toFixed(0)}% / side ${(h.p.side * 100).toFixed(0)}% / down ${(h.p.down * 100).toFixed(0)}%`,
      contribution: dir * w,
    };
  });
  return {
    score: den ? clamp(num / den, -1, 1) : 0,
    components,
    context: { ready: true, horizons: prediction.horizons },
  };
}

export { sigmoid };
