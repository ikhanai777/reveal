// Numeric helpers shared by every analytical engine.
// Pure functions, no DOM, safe to import from Node for tests.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Map v from [inLo,inHi] onto [outLo,outHi], clamped. */
export function scale(v, inLo, inHi, outLo, outHi) {
  if (inHi === inLo) return outLo;
  const t = clamp((v - inLo) / (inHi - inLo), 0, 1);
  return outLo + t * (outHi - outLo);
}

/** Squash an unbounded value into [-1,1]. `k` is the half-saturation point. */
export const squash = (v, k) => (k <= 0 ? 0 : v / (Math.abs(v) + k));

export const sum = (xs) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);

export function stdev(xs, sample = true) {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return 0;
  const m = mean(xs);
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (sample ? n - 1 : n));
}

/** Population stdev of the negative-only deviations below `target`. */
export function downsideDeviation(xs, target = 0) {
  if (!xs.length) return 0;
  const ss = xs.reduce((a, x) => {
    const d = Math.min(0, x - target);
    return a + d * d;
  }, 0);
  return Math.sqrt(ss / xs.length);
}

/** Linear-interpolated quantile, q in [0,1]. Input need not be sorted. */
export function quantile(xs, q) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Percentile rank of `v` within `xs`, in [0,1]. */
export function percentRank(xs, v) {
  if (!xs.length) return 0.5;
  let below = 0;
  for (const x of xs) if (x < v) below++;
  return below / xs.length;
}

/** Pearson correlation; 0 when either series is flat. */
export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = mean(a.slice(0, n));
  const mb = mean(b.slice(0, n));
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b[i] - mb;
    num += x * y; da += x * x; db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** Least-squares slope of ys against its own index. */
export function slope(ys) {
  const n = ys.length;
  if (n < 2) return 0;
  const mx = (n - 1) / 2;
  const my = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx;
    num += dx * (ys[i] - my);
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-clamp(z, -40, 40)));

/** Round to the nearest multiple of `step` (used for price-ladder bucketing). */
export function roundToStep(v, step) {
  if (!(step > 0)) return v;
  const r = Math.round(v / step) * step;
  // Kill float dust: 0.1+0.2 style artefacts break Map keys.
  const decimals = Math.max(0, Math.ceil(-Math.log10(step)) + 2);
  return Number(r.toFixed(decimals));
}

/** Round up to the nearest 1/2/5 x 10^n — a human-readable axis or ladder step. */
export function niceStep(v) {
  if (!(v > 0)) return 0;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const frac = v / base;
  const snapped = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return snapped * base;
}

/** Deterministic PRNG (mulberry32) so Monte Carlo runs are reproducible. */
export function rng(seed = 1) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle against a supplied PRNG. Returns a new array. */
export function shuffle(xs, rand) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
