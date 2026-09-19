// Local L2 book maintained from a REST snapshot plus a diff-depth stream,
// following the exchange-documented sync procedure:
//   buffer diffs -> fetch snapshot -> drop stale diffs -> verify continuity.
// A continuity gap means the book is untrustworthy, so it resyncs rather than
// quietly serving a book with holes in it.

export class BookBuilder {
  constructor({ depthLimit = 1000, continuity = 'spot' } = {}) {
    this.depthLimit = depthLimit;
    this.continuity = continuity; // 'spot' uses U == prevU+1, 'futures' uses pu == prevU
    this.reset();
  }

  reset() {
    this.bids = new Map();
    this.asks = new Map();
    this.lastUpdateId = -1;
    this.buffer = [];
    this.synced = false;
    this.resyncs = 0;
  }

  /** Buffer a diff event: { U, u, pu, b: [[p,q]], a: [[p,q]], E } */
  onDiff(evt) {
    if (!this.synced) { this.buffer.push(evt); return { applied: false, needResync: false }; }
    return this.apply(evt);
  }

  /** Seed from a REST snapshot: { lastUpdateId, bids, asks }. */
  onSnapshot(snap) {
    this.bids = new Map();
    this.asks = new Map();
    for (const [p, q] of snap.bids || []) this.setLevel(this.bids, +p, +q);
    for (const [p, q] of snap.asks || []) this.setLevel(this.asks, +p, +q);
    this.lastUpdateId = Number(snap.lastUpdateId);
    this.synced = true;

    // Replay buffered diffs, discarding everything already in the snapshot.
    const pending = this.buffer.filter((e) => Number(e.u) > this.lastUpdateId);
    this.buffer = [];
    let needResync = false;
    for (let i = 0; i < pending.length; i++) {
      const e = pending[i];
      if (i === 0) {
        // First kept event must straddle the snapshot id.
        if (!(Number(e.U) <= this.lastUpdateId + 1 && Number(e.u) >= this.lastUpdateId + 1)) {
          needResync = true;
          break;
        }
        this.applyLevels(e);
        this.lastUpdateId = Number(e.u);
        continue;
      }
      const res = this.apply(e);
      if (res.needResync) { needResync = true; break; }
    }
    if (needResync) { this.synced = false; this.resyncs++; }
    return { synced: this.synced, needResync };
  }

  apply(evt) {
    const U = Number(evt.U);
    const u = Number(evt.u);
    const pu = evt.pu != null ? Number(evt.pu) : null;
    const contiguous = this.continuity === 'futures' && pu != null
      ? pu === this.lastUpdateId
      : U <= this.lastUpdateId + 1 && u >= this.lastUpdateId + 1;

    if (u <= this.lastUpdateId) return { applied: false, needResync: false }; // already seen
    if (!contiguous) {
      this.synced = false;
      this.resyncs++;
      this.buffer = [evt];
      return { applied: false, needResync: true };
    }
    this.applyLevels(evt);
    this.lastUpdateId = u;
    return { applied: true, needResync: false };
  }

  applyLevels(evt) {
    for (const [p, q] of evt.b || []) this.setLevel(this.bids, +p, +q);
    for (const [p, q] of evt.a || []) this.setLevel(this.asks, +p, +q);
  }

  setLevel(map, price, qty) {
    if (!(qty > 0)) map.delete(price);
    else map.set(price, qty);
  }

  /** Top `depth` levels per side, bids descending / asks ascending. */
  snapshot(depth = 20) {
    const bids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, depth);
    const asks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, depth);
    return { bids, asks, lastUpdateId: this.lastUpdateId, synced: this.synced };
  }
}
