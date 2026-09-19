// Fixed-capacity ring buffer for in-memory time series.
// The scanner holds many symbols x many timeframes, so every rollup is bounded.

export class Ring {
  constructor(capacity = 1024) {
    this.capacity = Math.max(1, capacity | 0);
    this.buf = new Array(this.capacity);
    this.start = 0;
    this.length = 0;
  }

  push(v) {
    const idx = (this.start + this.length) % this.capacity;
    this.buf[idx] = v;
    if (this.length < this.capacity) this.length++;
    else this.start = (this.start + 1) % this.capacity;
    return v;
  }

  /** Negative indices count back from the end; -1 is the newest item. */
  at(i) {
    if (this.length === 0) return undefined;
    const n = i < 0 ? this.length + i : i;
    if (n < 0 || n >= this.length) return undefined;
    return this.buf[(this.start + n) % this.capacity];
  }

  get last() { return this.at(-1); }
  get first() { return this.at(0); }

  /** Replace the newest item (used when a streaming candle updates in place). */
  replaceLast(v) {
    if (this.length === 0) return this.push(v);
    this.buf[(this.start + this.length - 1) % this.capacity] = v;
    return v;
  }

  /** Newest `n` items, oldest-first. Omit `n` for everything. */
  tail(n) {
    const take = n == null ? this.length : Math.min(n, this.length);
    const out = new Array(take);
    for (let i = 0; i < take; i++) out[i] = this.at(this.length - take + i);
    return out;
  }

  toArray() { return this.tail(); }

  map(fn) { return this.toArray().map(fn); }

  clear() { this.start = 0; this.length = 0; this.buf = new Array(this.capacity); }
}

/** Rolling window that keeps sum/mean available in O(1) per push. */
export class RollingMean {
  constructor(period) {
    this.period = Math.max(1, period | 0);
    this.ring = new Ring(this.period);
    this.sum = 0;
  }

  push(v) {
    if (this.ring.length === this.period) this.sum -= this.ring.first;
    this.ring.push(v);
    this.sum += v;
    return this.value;
  }

  get ready() { return this.ring.length === this.period; }
  get value() { return this.ring.length ? this.sum / this.ring.length : NaN; }
}
