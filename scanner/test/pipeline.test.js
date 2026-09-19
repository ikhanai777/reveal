import { describe, it, assert } from './harness.js';
import { Bus, TOPIC } from '../js/core/bus.js';
import { Ring, RollingMean } from '../js/core/series.js';
import { bucketStart, tfMs, barsPerYear } from '../js/core/timeframe.js';
import { normalizeSymbol, denormalizeSymbol, topOfBook } from '../js/ingest/normalize.js';
import { CandleSeries, MultiTimeframe } from '../js/engines/candles.js';
import { SyntheticFeed } from '../js/ingest/synthetic.js';
import { Scanner } from '../js/scanner.js';
import { SentimentEngine, lexiconScore, scoreSentiment } from '../js/engines/sentiment.js';
import { scoreDerivatives, fundingRegime } from '../js/engines/derivatives.js';
import { Forecaster, features, scoreForecast } from '../js/engines/forecast.js';
import { WebhookDispatcher } from '../js/delivery/webhooks.js';
import { toJsonPayload, toDiscord, toTelegram } from '../js/delivery/format.js';
import { SignalTracker } from '../js/signal/tracker.js';
import { syntheticCandles } from '../js/ingest/synthetic.js';

describe('core plumbing', () => {
  it('ring buffer evicts oldest first', () => {
    const r = new Ring(3);
    [1, 2, 3, 4].forEach((v) => r.push(v));
    assert.deep(r.toArray(), [2, 3, 4]);
    assert.equal(r.last, 4);
    assert.equal(r.at(-2), 3);
  });

  it('ring buffer replaces the newest item in place', () => {
    const r = new Ring(3);
    r.push(1); r.push(2);
    r.replaceLast(9);
    assert.deep(r.toArray(), [1, 9]);
  });

  it('rolling mean drops values leaving the window', () => {
    const m = new RollingMean(3);
    [1, 2, 3, 4].forEach((v) => m.push(v));
    assert.close(m.value, 3);
    assert.equal(m.ready, true);
  });

  it('bus isolates a throwing subscriber', () => {
    const bus = new Bus();
    let reached = false;
    bus.on('x', () => { throw new Error('boom'); });
    bus.on('x', () => { reached = true; });
    bus.emit('x', 1);
    assert.equal(reached, true);
  });

  it('bus unsubscribes cleanly', () => {
    const bus = new Bus();
    let n = 0;
    const off = bus.on('x', () => n++);
    bus.emit('x'); off(); bus.emit('x');
    assert.equal(n, 1);
  });

  it('aligns buckets to the UTC epoch', () => {
    assert.equal(bucketStart(Date.UTC(2024, 0, 1, 0, 7, 30), '5m'), Date.UTC(2024, 0, 1, 0, 5, 0));
    assert.equal(tfMs('4h'), 14_400_000);
    assert.close(barsPerYear('1d'), 365, 1e-9);
  });

  it('normalizes symbols both ways', () => {
    assert.equal(normalizeSymbol('BTCUSDT'), 'BTC/USDT');
    assert.equal(normalizeSymbol('eth-usdt'), 'ETH/USDT');
    assert.equal(denormalizeSymbol('BTC/USDT'), 'BTCUSDT');
  });

  it('reads top of book', () => {
    const t = topOfBook({ bids: [[99, 1]], asks: [[101, 1]] });
    assert.close(t.mid, 100);
    assert.close(t.spread, 2);
    assert.close(t.spreadBps, 200);
  });
});

describe('candle rollups', () => {
  it('folds ticks into OHLCV with aggressor split', () => {
    const s = new CandleSeries('1m');
    s.addTrade({ ts: 0, price: 100, size: 1, side: 1 });
    s.addTrade({ ts: 10_000, price: 105, size: 2, side: -1 });
    s.addTrade({ ts: 20_000, price: 98, size: 1, side: 1 });
    const c = s.last;
    assert.close(c.o, 100);
    assert.close(c.h, 105);
    assert.close(c.l, 98);
    assert.close(c.c, 98);
    assert.close(c.v, 4);
    assert.close(c.buyVol, 2);
    assert.close(c.sellVol, 2);
  });

  it('closes the previous candle on rollover', () => {
    const s = new CandleSeries('1m');
    s.addTrade({ ts: 0, price: 100, size: 1, side: 1 });
    const closed = s.addTrade({ ts: 61_000, price: 101, size: 1, side: 1 });
    assert.ok(closed);
    assert.equal(closed.closed, true);
    assert.equal(s.closed().length, 1);
  });

  it('excludes the forming candle from closed()', () => {
    const s = new CandleSeries('1m');
    s.addTrade({ ts: 0, price: 100, size: 1, side: 1 });
    assert.equal(s.closed().length, 0);
  });

  it('keeps every timeframe consistent from one tick stream', () => {
    const mtf = new MultiTimeframe({ symbol: 'BTC/USDT', timeframes: ['1m', '5m'] });
    for (let i = 0; i < 300; i++) {
      mtf.addTrade({ ts: i * 60_000, price: 100 + i, size: 1, side: 1 });
    }
    const oneMin = mtf.get('1m').closed();
    const fiveMin = mtf.get('5m').closed();
    assert.ok(oneMin.length > fiveMin.length);
    const volume1 = oneMin.reduce((a, c) => a + c.v, 0);
    const volume5 = fiveMin.reduce((a, c) => a + c.v, 0);
    // The 5m series ends later, so its closed volume is a subset of the 1m's.
    assert.ok(volume5 <= volume1 + 1e-9);
  });

  it('drops a late print from an already-closed bucket', () => {
    const s = new CandleSeries('1m');
    s.addTrade({ ts: 61_000, price: 100, size: 1, side: 1 });
    s.addTrade({ ts: 1_000, price: 500, size: 1, side: 1 });
    assert.close(s.last.h, 100);
  });
});

describe('sentiment', () => {
  it('scores obvious polarity from the lexicon', () => {
    assert.ok(lexiconScore('Bitcoin rally accelerates on record inflows').polarity > 0);
    assert.ok(lexiconScore('Exchange halted withdrawals after exploit').polarity < 0);
    assert.equal(lexiconScore('').polarity, 0);
  });

  it('tags high-impact keywords', () => {
    assert.ok(lexiconScore('Protocol hacked for $40m').tags.includes('exploit'));
    assert.ok(lexiconScore('SEC approves spot ETF').tags.includes('sec-approval'));
  });

  it('decays old headlines', async () => {
    const e = new SentimentEngine({ halfLifeMs: 1000 });
    const now = 1_000_000;
    await e.ingest({ ts: now - 60_000, symbol: 'BTC/USDT', headline: 'massive rally and record high inflow' });
    const stale = e.aggregate('BTC/USDT', now);
    await e.ingest({ ts: now, symbol: 'BTC/USDT', headline: 'massive rally and record high inflow' });
    const fresh = e.aggregate('BTC/USDT', now);
    assert.ok(fresh.weight > stale.weight);
  });

  it('prefers a wired classifier over the lexicon', async () => {
    const e = new SentimentEngine();
    e.setClassifier(async () => ({ polarity: -0.9, confidence: 1, tags: ['custom'] }));
    const item = await e.ingest({ symbol: 'BTC/USDT', headline: 'wonderful glorious rally' });
    assert.close(item.polarity, -0.9);
  });

  it('falls back to the lexicon when the classifier throws', async () => {
    const e = new SentimentEngine();
    e.setClassifier(async () => { throw new Error('model down'); });
    const item = await e.ingest({ symbol: 'BTC/USDT', headline: 'exchange exploit drained funds' });
    assert.ok(item.polarity < 0);
  });

  it('stays neutral with no coverage', () => {
    const e = new SentimentEngine();
    const s = scoreSentiment(e, 'BTC/USDT');
    assert.close(s.score, 0);
  });

  it('measures a mention spike as social velocity', async () => {
    const e = new SentimentEngine();
    const t0 = 1_000_000_000;
    for (let i = 0; i < 60; i++) await e.ingest({ ts: t0 + i * 60_000, symbol: 'X', headline: 'routine update' });
    const now = t0 + 62 * 60_000;
    for (let i = 0; i < 40; i++) await e.ingest({ ts: now, symbol: 'X', headline: 'breaking news' });
    assert.ok(e.socialVelocity('X', now).z > 1);
  });
});

describe('derivatives', () => {
  const candles = syntheticCandles({ bars: 120, tf: '5m', tfMsValue: 300_000, seed: 5 });

  it('classifies funding regimes', () => {
    assert.equal(fundingRegime(0.0001).level, 'neutral');
    assert.equal(fundingRegime(0.0006).level, 'elevated');
    assert.equal(fundingRegime(0.0015).level, 'extreme');
  });

  it('reads crowded longs as a bearish contribution', () => {
    const hot = scoreDerivatives({
      candles,
      fundingHistory: [{ ts: 1, rate: 0.002 }],
      oiHistory: [{ ts: 1, oi: 100 }],
    });
    const cold = scoreDerivatives({
      candles,
      fundingHistory: [{ ts: 1, rate: -0.002 }],
      oiHistory: [{ ts: 1, oi: 100 }],
    });
    const fundingOf = (r) => r.components.find((c) => c.key === 'funding').score;
    assert.ok(fundingOf(hot) < 0);
    assert.ok(fundingOf(cold) > 0);
  });

  it('flags a short-squeeze setup when longs are trapped', () => {
    const falling = candles.map((c, i) => ({ ...c, c: 100 - i * 0.1, o: 100 - i * 0.1, h: 100.5 - i * 0.1, l: 99.5 - i * 0.1 }));
    const oi = Array.from({ length: 20 }, (_, i) => ({ ts: i, oi: 100 * (1 + i * 0.01) }));
    const r = scoreDerivatives({
      candles: falling,
      fundingHistory: [{ ts: 1, rate: 0.001 }],
      oiHistory: oi,
    });
    assert.ok(r.context.squeeze.includes('short squeeze'));
    assert.ok(r.components.find((c) => c.key === 'squeeze').score < 0);
  });

  it('penalizes an imminent large unlock', () => {
    const withUnlock = scoreDerivatives({
      candles, fundingHistory: [{ ts: 1, rate: 0 }], oiHistory: [{ ts: 1, oi: 100 }],
      onchain: { unlocks: [{ hoursAway: 24, pctOfSupply: 3 }] },
    });
    assert.ok(withUnlock.components.find((c) => c.key === 'unlocks').score < 0);
  });

  it('ignores an unlock outside the 48h window', () => {
    const r = scoreDerivatives({
      candles, fundingHistory: [{ ts: 1, rate: 0 }], oiHistory: [{ ts: 1, oi: 100 }],
      onchain: { unlocks: [{ hoursAway: 200, pctOfSupply: 8 }] },
    });
    assert.equal(r.components.find((c) => c.key === 'unlocks').score, null);
  });
});

describe('ML forecast', () => {
  const candles = syntheticCandles({ bars: 400, tf: '5m', tfMsValue: 300_000, seed: 13 });

  it('builds a finite feature vector', () => {
    const x = features(candles);
    assert.equal(x.length, 13);
    for (const v of x) assert.ok(Number.isFinite(v), 'every feature is finite');
  });

  it('returns null before the warm-up window', () => {
    assert.equal(features(candles.slice(0, 20)), null);
  });

  it('emits probabilities that sum to one per horizon', () => {
    const f = new Forecaster();
    const p = f.predict(candles);
    for (const h of p.horizons) {
      assert.close(h.p.up + h.p.down + h.p.side, 1, 1e-9);
    }
  });

  it('learns from realized outcomes', () => {
    const f = new Forecaster();
    for (let i = 100; i < candles.length; i++) f.observe(candles.slice(0, i));
    assert.ok(f.stats[0].samples > 0, 'the near horizon trained');
  });

  it('abstains while untrained rather than voting neutral', () => {
    const f = new Forecaster();
    const s = scoreForecast(f.predict(candles));
    assert.equal(s.context.ready, false);
    assert.close(s.score, 0);
  });

  it('reports a score once it has trained', () => {
    const f = new Forecaster();
    for (let i = 100; i < candles.length; i++) f.observe(candles.slice(0, i));
    const s = scoreForecast(f.predict(candles));
    assert.equal(s.context.ready, true);
    assert.between(s.score, -1, 1);
  });

  it('treats a missing forecast as not ready', () => {
    assert.equal(scoreForecast(null).context.ready, false);
  });
});

describe('delivery', () => {
  const signal = {
    id: 'SIG-1', ts: Date.now(), symbol: 'BTC/USDT', venue: 'binance-futures', timeframe: '5m',
    bias: 'STRONG_LONG', direction: 1, scs: 84, strategy: 'scs-matrix',
    entry: { low: 63_900, high: 64_100, mid: 64_000, anchor: 'POC' },
    stop: 63_400, risk: 600,
    targets: [
      { name: 'TP1', price: 64_900, size: 0.4, rr: 1.5 },
      { name: 'TP2', price: 66_100, size: 0.4, rr: 3.5 },
      { name: 'TP3', price: 67_000, size: 0.2, rr: 5 },
    ],
    scoreBreakdown: [{ key: 'ta', label: 'Technicals', scaled: 78 }, { key: 'orderFlow', label: 'Order Flow', scaled: 88 }],
  };

  it('produces a stable JSON contract', () => {
    const p = toJsonPayload(signal);
    assert.equal(p.schema, 'scanner.signal.v1');
    assert.equal(p.direction, 'LONG');
    assert.equal(p.takeProfits.length, 3);
    assert.close(p.stopLoss, 63_400);
  });

  it('builds a Discord embed and a Telegram message', () => {
    assert.ok(toDiscord(signal).embeds[0].title.includes('BTC/USDT'));
    assert.ok(toTelegram(signal).text.includes('LONG'));
  });

  it('escapes HTML in a Telegram payload', () => {
    const evil = { ...signal, symbol: '<script>x</script>' };
    assert.ok(!toTelegram(evil).text.includes('<script>'));
  });

  it('filters destinations by confidence and bias', () => {
    const d = new WebhookDispatcher({ fetchImpl: async () => ({ ok: true, status: 200 }) });
    d.destinations = [];
    d.add({ id: 'a', type: 'generic', url: 'https://example.invalid/a', minScs: 90 });
    d.add({ id: 'b', type: 'generic', url: 'https://example.invalid/b', minScs: 70 });
    d.add({ id: 'c', type: 'generic', url: 'https://example.invalid/c', biases: ['STRONG_SHORT'] });
    assert.equal(d.shouldSend(d.destinations[0], signal), false);
    assert.equal(d.shouldSend(d.destinations[1], signal), true);
    assert.equal(d.shouldSend(d.destinations[2], signal), false);
  });

  it('reads a short signal confidence from the bottom of the range', () => {
    const d = new WebhookDispatcher({ fetchImpl: async () => ({ ok: true, status: 200 }) });
    d.destinations = [{ id: 'x', type: 'generic', url: 'u', enabled: true, minScs: 70 }];
    const short = { ...signal, direction: -1, scs: 12, bias: 'STRONG_SHORT' };
    assert.equal(d.shouldSend(d.destinations[0], short), true);
  });

  it('retries a 500 and dead-letters a permanent failure', async () => {
    let calls = 0;
    const d = new WebhookDispatcher({
      fetchImpl: async () => { calls++; return { ok: false, status: 500 }; },
      maxRetries: 2,
      sleep: () => Promise.resolve(),
    });
    d.destinations = [];
    const dest = { id: 'z', type: 'generic', url: 'https://example.invalid/z', enabled: true };
    const res = await d.deliver(dest, signal);
    assert.equal(res.ok, false);
    assert.equal(calls, 3);
    assert.equal(d.deadLetter.length, 1);
  });

  it('does not retry a 400', async () => {
    let calls = 0;
    const d = new WebhookDispatcher({
      fetchImpl: async () => { calls++; return { ok: false, status: 400 }; },
      sleep: () => Promise.resolve(),
    });
    d.destinations = [];
    await d.deliver({ id: 'q', type: 'generic', url: 'u', enabled: true }, signal);
    assert.equal(calls, 1);
  });
});

describe('scanner integration', () => {
  it('drives ingestion through to a scored evaluation', () => {
    const bus = new Bus();
    const tracker = new SignalTracker({ persist: false });
    const scanner = new Scanner({
      bus, symbols: ['BTC/USDT'], timeframe: '1m', tracker,
      evaluateEveryMs: 1e9, // manual ticks only
    });
    scanner.start();

    const feed = new SyntheticFeed({ bus, symbol: 'BTC/USDT', seed: 3, tradesPerSecond: 4 });
    // Roughly three hours of market time: enough to close 180 one-minute bars.
    feed.burst(3 * 3600 * 1000, Date.now() - 3 * 3600 * 1000);

    const eng = scanner.engine('BTC/USDT');
    assert.ok(eng.candles().length > 100, `expected closed bars, got ${eng.candles().length}`);

    const results = scanner.tick();
    assert.equal(results.length, 1);
    const ev = results[0];
    assert.between(ev.scs, 0, 100);
    assert.equal(ev.breakdown.length, 5);
    assert.ok(ev.breakdown.find((b) => b.key === 'ta').ready, 'technicals report once warm');
    assert.ok(ev.breakdown.find((b) => b.key === 'orderFlow').ready, 'order flow reports once warm');
    scanner.stop();
  });

  it('emits at most one live signal per symbol', () => {
    const bus = new Bus();
    const tracker = new SignalTracker({ persist: false });
    const scanner = new Scanner({ bus, symbols: ['BTC/USDT'], timeframe: '1m', tracker, evaluateEveryMs: 1e9, cooldownMs: 0 });
    scanner.start();
    const feed = new SyntheticFeed({ bus, symbol: 'BTC/USDT', seed: 17, tradesPerSecond: 4 });
    feed.burst(3 * 3600 * 1000, Date.now() - 3 * 3600 * 1000);

    for (let i = 0; i < 5; i++) scanner.tick();
    const live = tracker.live().filter((s) => s.symbol === 'BTC/USDT');
    assert.ok(live.length <= 1, `expected at most one live signal, got ${live.length}`);
    scanner.stop();
  });

  it('routes news into the sentiment engine over the bus', async () => {
    const bus = new Bus();
    const scanner = new Scanner({ bus, symbols: ['BTC/USDT'], timeframe: '1m', tracker: new SignalTracker({ persist: false }), evaluateEveryMs: 1e9 });
    scanner.start();
    bus.emit(TOPIC.news, { ts: Date.now(), symbol: 'BTC/USDT', headline: 'SEC approves spot ETF', source: 'test' });
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(scanner.sentiment.items.length === 1);
    scanner.stop();
  });
});
