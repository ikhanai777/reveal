import { describe, it, assert } from './harness.js';
import { FootprintCandle, FootprintAggregator } from '../js/engines/footprint.js';
import { cvdSeries, cvdDivergence } from '../js/engines/cvd.js';
import { volumeProfile, valueLocation, nextNode } from '../js/engines/vpvr.js';
import { orderBookImbalance, liquidityWalls, WallTracker } from '../js/engines/orderbook.js';
import { BookBuilder } from '../js/ingest/bookbuilder.js';
import { swings, fairValueGaps, marketStructure } from '../js/engines/structure.js';

const tr = (price, size, side, ts = 1) => ({ price, size, side, ts });

describe('footprint', () => {
  it('splits aggressive buys from sells', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    fp.add(tr(100, 5, 1));
    fp.add(tr(100, 2, -1));
    fp.add(tr(101, 3, 1));
    assert.close(fp.buyVol, 8);
    assert.close(fp.sellVol, 2);
    assert.close(fp.delta, 6);
    assert.close(fp.deltaPct, 0.6);
  });

  it('builds a descending ladder', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    fp.add(tr(100, 1, 1));
    fp.add(tr(102, 1, -1));
    fp.add(tr(101, 1, 1));
    assert.deep(fp.ladder().map((r) => r.price), [102, 101, 100]);
  });

  it('flags a diagonal buy imbalance', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    // ask 30 at 101 against bid 2 at 100 -> 15x, a bullish imbalance at 101.
    fp.add(tr(101, 30, 1));
    fp.add(tr(100, 2, -1));
    const imb = fp.imbalances({ ratio: 3 });
    assert.equal(imb.length, 1);
    assert.equal(imb[0].dir, 1);
    assert.equal(imb[0].price, 101);
  });

  it('ignores a diagonal inside the ratio', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    fp.add(tr(101, 10, 1));
    fp.add(tr(100, 5, -1));
    assert.equal(fp.imbalances({ ratio: 3 }).length, 0);
  });

  it('groups consecutive imbalances into a stack', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    for (const p of [100, 101, 102, 103]) {
      fp.add(tr(p, 40, 1));
      fp.add(tr(p, 1, -1));
    }
    const stacks = fp.imbalanceStacks({ ratio: 3, minRun: 3 });
    assert.equal(stacks.length, 1);
    assert.equal(stacks[0].dir, 1);
    assert.ok(stacks[0].size >= 3);
  });

  it('finds the in-candle point of control', () => {
    const fp = new FootprintCandle(0, '1m', 1);
    fp.add(tr(100, 1, 1));
    fp.add(tr(101, 9, 1));
    fp.add(tr(101, 5, -1));
    assert.equal(fp.pointOfControl().price, 101);
  });

  it('rolls into a new candle on the bucket boundary', () => {
    const agg = new FootprintAggregator({ tf: '1m', tickSize: 1 });
    assert.equal(agg.addTrade(tr(100, 1, 1, 0)), null);
    const closed = agg.addTrade(tr(101, 1, 1, 60_001));
    assert.ok(closed, 'first candle closes when the minute rolls');
    assert.equal(closed.closed, true);
    assert.equal(agg.candles.length, 2);
  });
});

describe('CVD', () => {
  it('accumulates signed volume', () => {
    const candles = [
      { buyVol: 5, sellVol: 2 },
      { buyVol: 1, sellVol: 4 },
      { buyVol: 3, sellVol: 3 },
    ];
    assert.deep(cvdSeries(candles), [3, 0, 0]);
  });

  it('detects a higher price high against a lower CVD high', () => {
    // Two rallies: the second reaches higher on visibly weaker buying, so the
    // price pivot rises while the CVD pivot falls.
    const candles = [];
    const push = (c, buy, sell) => candles.push({ t: candles.length * 60_000, o: c, h: c + 0.4, l: c - 0.4, c, v: buy + sell, buyVol: buy, sellVol: sell });
    for (let i = 0; i < 10; i++) push(100, 1, 1);                    // flat, CVD 0
    for (const p of [101, 102, 103, 104, 105, 106]) push(p, 10, 1);  // pivot high @106, CVD +54
    for (const p of [105, 104, 103, 102, 101, 100]) push(p, 1, 8);   // pull back, CVD +12
    for (const p of [101, 103, 105, 107, 109]) push(p, 2, 1.8);      // higher high @109, CVD +13
    for (const p of [108, 107, 106, 105, 104]) push(p, 1, 6);        // confirms the pivot

    const d = cvdDivergence(candles, { strength: 2, lookback: 60 });
    assert.ok(d.bearish, 'expected a bearish CVD divergence');
    assert.ok(d.bearish.to.price > d.bearish.from.price, 'price made a higher high');
    assert.ok(d.bearish.to.cvd < d.bearish.from.cvd, 'CVD made a lower high');
  });
});

describe('VPVR', () => {
  const candles = [];
  for (let i = 0; i < 100; i++) {
    // Most volume transacts around 100; the tails are thin.
    const near = i % 5 !== 0;
    candles.push({ t: i, o: 100, h: near ? 100.5 : 104, l: near ? 99.5 : 96, c: 100, v: near ? 100 : 5, buyVol: near ? 50 : 2, sellVol: near ? 50 : 3 });
  }
  const prof = volumeProfile(candles, { rows: 40 });

  it('puts the POC where volume concentrated', () => {
    assert.between(prof.poc, 99, 101);
  });

  it('nests the value area inside the range', () => {
    assert.ok(prof.val <= prof.poc && prof.poc <= prof.vah);
    assert.ok(prof.val >= prof.low && prof.vah <= prof.high);
  });

  it('covers about 70% of volume in the value area', () => {
    assert.between(prof.valueAreaVolume / prof.total, 0.68, 0.92);
  });

  it('locates price relative to value', () => {
    assert.equal(valueLocation(prof, prof.vah + 5), 'above');
    assert.equal(valueLocation(prof, prof.val - 5), 'below');
    assert.equal(valueLocation(prof, prof.poc), 'inside');
  });

  it('finds the next node in the trade direction', () => {
    const node = nextNode(prof, prof.poc, 1);
    if (node) assert.ok(node.price > prof.poc);
  });
});

describe('order book', () => {
  const book = {
    bids: [[99, 10], [98, 8], [97, 6]],
    asks: [[100, 2], [101, 2], [102, 2]],
  };

  it('reports imbalance toward the heavier side', () => {
    const o = orderBookImbalance(book, 3);
    assert.ok(o.obi > 0.5, `expected bid-heavy OBI, got ${o.obi}`);
    assert.close(o.bidVol, 24);
    assert.close(o.askVol, 6);
  });

  it('is zero on a balanced book', () => {
    const o = orderBookImbalance({ bids: [[99, 5]], asks: [[100, 5]] }, 5);
    assert.close(o.obi, 0);
  });

  it('spots an outsized wall', () => {
    const walls = liquidityWalls({
      bids: [[99, 1], [98, 1], [97, 1], [96, 1]],
      asks: [[100, 1], [101, 400], [102, 1], [103, 1]],
    }, { sigma: 2 });
    assert.equal(walls.length, 1);
    assert.equal(walls[0].side, 'ask');
    assert.equal(walls[0].price, 101);
  });

  it('flags a wall pulled before it was ever tested as a spoof', () => {
    const tracker = new WallTracker({ spoofMs: 5000, wallOpts: { sigma: 2 } });
    const withWall = {
      ts: 1000,
      bids: [[90, 1], [89, 1], [88, 1], [87, 1]],
      asks: [[100, 1], [101, 500], [102, 1], [103, 1]],
    };
    tracker.update(withWall, 1000);
    tracker.update({ ...withWall, ts: 1500 }, 1500);
    // Wall vanishes while price never came near it.
    tracker.update({ ts: 4000, bids: withWall.bids, asks: [[100, 1], [101, 1], [102, 1], [103, 1]] }, 4000);
    assert.equal(tracker.recentSpoofs(60_000, 4000).length, 1);
  });
});

describe('book builder', () => {
  it('applies contiguous diffs and rejects a gap', () => {
    const b = new BookBuilder({ continuity: 'spot' });
    b.onDiff({ U: 6, u: 7, b: [['99', '1']], a: [] });     // buffered pre-snapshot
    b.onSnapshot({ lastUpdateId: 5, bids: [['98', '2']], asks: [['100', '2']] });
    assert.equal(b.synced, true);
    assert.equal(b.lastUpdateId, 7);

    const ok = b.onDiff({ U: 8, u: 9, b: [['98', '3']], a: [] });
    assert.equal(ok.applied, true);

    const gap = b.onDiff({ U: 20, u: 21, b: [], a: [] });
    assert.equal(gap.needResync, true);
    assert.equal(b.synced, false);
  });

  it('drops levels whose quantity goes to zero', () => {
    const b = new BookBuilder();
    b.onSnapshot({ lastUpdateId: 1, bids: [['99', '5'], ['98', '5']], asks: [] });
    b.onDiff({ U: 2, u: 2, b: [['99', '0']], a: [] });
    assert.deep(b.snapshot(5).bids, [[98, 5]]);
  });

  it('honours the futures pu continuity rule', () => {
    const b = new BookBuilder({ continuity: 'futures' });
    b.onSnapshot({ lastUpdateId: 100, bids: [['99', '1']], asks: [['100', '1']] });
    assert.equal(b.onDiff({ pu: 100, U: 101, u: 105, b: [], a: [] }).applied, true);
    assert.equal(b.onDiff({ pu: 999, U: 106, u: 110, b: [], a: [] }).needResync, true);
  });
});

describe('market structure', () => {
  const zig = [];
  const add = (h, l) => zig.push({ t: zig.length * 60_000, o: (h + l) / 2, h, l, c: (h + l) / 2, v: 1, buyVol: 0.5, sellVol: 0.5 });
  // Up-down-up with each leg higher: higher highs and higher lows.
  for (const [h, l] of [[10, 9], [11, 10], [12, 11], [11, 10], [10, 9], [13, 12], [14, 13], [15, 14], [14, 13], [13, 12], [16, 15], [17, 16], [18, 17]]) add(h, l);

  it('finds confirmed fractal pivots only', () => {
    const s = swings(zig, 2);
    assert.ok(s.highs.length >= 1);
    for (const p of [...s.highs, ...s.lows]) {
      assert.ok(p.index >= 2 && p.index <= zig.length - 3, 'pivots stay inside the confirmed region');
    }
  });

  it('labels a break in the trend direction as MSB', () => {
    const ms = marketStructure(zig, { strength: 2 });
    assert.ok(ms.events.length >= 1);
    assert.equal(ms.trend, 1);
    assert.ok(ms.events.some((e) => e.type === 'MSB' || e.type === 'ChoCh'));
  });

  it('detects an unfilled bullish fair value gap', () => {
    const c = [
      { t: 0, o: 10, h: 10, l: 9, c: 10, v: 1 },
      { t: 1, o: 11, h: 14, l: 10, c: 14, v: 1 },
      { t: 2, o: 14, h: 15, l: 13, c: 15, v: 1 },   // gap: candle0.h=10 < candle2.l=13
      { t: 3, o: 15, h: 16, l: 14, c: 16, v: 1 },
    ];
    const gaps = fairValueGaps(c);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].dir, 1);
    assert.equal(gaps[0].filled, false);
  });

  it('marks a gap filled once price trades back through it', () => {
    const c = [
      { t: 0, o: 10, h: 10, l: 9, c: 10, v: 1 },
      { t: 1, o: 11, h: 14, l: 10, c: 14, v: 1 },
      { t: 2, o: 14, h: 15, l: 13, c: 15, v: 1 },
      { t: 3, o: 13, h: 13, l: 8, c: 9, v: 1 },     // retrace through the gap
    ];
    assert.equal(fairValueGaps(c)[0].filled, true);
  });
});
