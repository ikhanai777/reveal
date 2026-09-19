// Weighted token bucket for REST endpoints.
// Binance/Bybit/OKX all publish request budgets per interval; a bucket manager
// keeps historical backfill from tripping a 429 ban mid-scan.

export class TokenBucket {
  constructor({ capacity, refillPerMs, now = () => Date.now() }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMs;
    this.now = now;
    this.last = now();
  }

  refill() {
    const t = this.now();
    const elapsed = t - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.last = t;
  }

  /** Milliseconds until `weight` tokens are available (0 when available now). */
  delayFor(weight) {
    this.refill();
    if (this.tokens >= weight) return 0;
    return Math.ceil((weight - this.tokens) / this.refillPerMs);
  }

  take(weight) {
    this.refill();
    if (this.tokens < weight) return false;
    this.tokens -= weight;
    return true;
  }
}

/** Serializes weighted calls behind a bucket, preserving submission order. */
export class RateLimiter {
  constructor({ capacity = 1200, intervalMs = 60_000, sleep = defaultSleep, now = () => Date.now() } = {}) {
    this.bucket = new TokenBucket({ capacity, refillPerMs: capacity / intervalMs, now });
    this.sleep = sleep;
    this.chain = Promise.resolve();
  }

  /** Run `fn` once the bucket can pay `weight`. Calls run one at a time. */
  schedule(fn, weight = 1) {
    const run = this.chain.then(async () => {
      for (;;) {
        const wait = this.bucket.delayFor(weight);
        if (wait === 0) break;
        await this.sleep(wait);
      }
      this.bucket.take(weight);
      return fn();
    });
    // Keep the chain alive even when a call rejects.
    this.chain = run.then(() => {}, () => {});
    return run;
  }
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reconnect backoff with jitter, capped. */
export function backoff(attempt, { base = 1000, cap = 30_000, jitter = 0.3 } = {}) {
  const raw = Math.min(cap, base * 2 ** Math.max(0, attempt));
  const j = raw * jitter;
  return Math.round(raw - j + Math.random() * 2 * j);
}
