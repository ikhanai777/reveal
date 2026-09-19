import { describe, it, assert } from './harness.js';
import { computeSCS, classify, evaluate, BIAS, DEFAULT_WEIGHTS, regimeFilters } from '../js/signal/scoring.js';
import { buildTradePlan, positionSize, trailStop } from '../js/signal/risk.js';
import { SignalTracker, STATE } from '../js/signal/tracker.js';
import { verifyChain } from '../js/core/hash.js';

const factor = (score, ready = true, context = {}) => ({ score, components: [], context: { ready, ...context } });

describe('SCS matrix', () => {
  it('maps a fully bullish read to 100 and bearish to 0', () => {
    const all = (v) => ({ ta: factor(v), orderFlow: factor(v), derivatives: factor(v), news: factor(v), ml: factor(v) });
    assert.close(computeSCS(all(1)).scs, 100);
    assert.close(computeSCS(all(-1)).scs, 0);
    assert.close(computeSCS(all(0)).scs, 50);
  });

  it('weights order flow heaviest', () => {
    const base = { ta: factor(0), orderFlow: factor(0), derivatives: factor(0), news: factor(0), ml: factor(0) };
    const ofHot = computeSCS({ ...base, orderFlow: factor(1) }).scs;
    const taHot = computeSCS({ ...base, ta: factor(1) }).scs;
    assert.ok(ofHot > taHot, 'a 30% factor must move the score more than a 25% one');
  });

  it('redistributes weight away from a factor that is not ready', () => {
    const f = {
      ta: factor(1), orderFlow: factor(1), derivatives: factor(1),
      news: factor(0, false), ml: factor(0, false),
    };
    const r = computeSCS(f);
    assert.close(r.scs, 100, 1e-9);
    assert.close(r.coverage, DEFAULT_WEIGHTS.ta + DEFAULT_WEIGHTS.orderFlow + DEFAULT_WEIGHTS.derivatives, 1e-9);
  });

  it('records a per-factor breakdown for the radar', () => {
    const r = computeSCS({ ta: factor(0.5), orderFlow: factor(-0.5), derivatives: factor(0), news: factor(0), ml: factor(0) });
    assert.equal(r.breakdown.length, 5);
    assert.close(r.breakdown.find((b) => b.key === 'ta').scaled, 75);
    assert.close(r.breakdown.find((b) => b.key === 'orderFlow').scaled, 25);
  });
});

describe('threshold ladder', () => {
  it('emits STRONG_LONG only when both gates confirm', () => {
    assert.equal(classify(85, { orderFlowDelta: 5, newsSentiment: 0.2 }).bias, BIAS.STRONG_LONG);
  });

  it('downgrades a strong long when order flow disagrees', () => {
    const c = classify(85, { orderFlowDelta: -5, newsSentiment: 0.2 });
    assert.equal(c.bias, BIAS.WEAK_LONG);
    assert.equal(c.downgraded, true);
    assert.equal(c.gatesFailed.length, 1);
  });

  it('downgrades a strong long on bad news', () => {
    assert.equal(classify(85, { orderFlowDelta: 5, newsSentiment: -0.5 }).downgraded, true);
  });

  it('covers every band from the spec', () => {
    assert.equal(classify(70, {}).bias, BIAS.WEAK_LONG);
    assert.equal(classify(50, {}).bias, BIAS.NEUTRAL);
    assert.equal(classify(36, {}).bias, BIAS.NEUTRAL);
    assert.equal(classify(30, {}).bias, BIAS.WEAK_SHORT);
    assert.equal(classify(15, { orderFlowDelta: -5, newsSentiment: -0.2 }).bias, BIAS.STRONG_SHORT);
    assert.equal(classify(15, { orderFlowDelta: 5, newsSentiment: -0.2 }).bias, BIAS.WEAK_SHORT);
  });

  it('gives neutral no direction', () => {
    assert.equal(classify(50, {}).direction, 0);
  });
});

describe('regime filters', () => {
  it('vetoes a dead-volatility tape', () => {
    const r = regimeFilters({ ta: { context: { atrPct: 0.00001, adx: 30 } } });
    assert.equal(r.pass, false);
    assert.ok(r.vetoes[0].includes('volatility too low'));
  });

  it('vetoes a blown-out spread', () => {
    const r = regimeFilters({
      ta: { context: { atrPct: 0.002, adx: 30 } },
      orderFlow: { context: { obi: { spreadBps: 50 } } },
    });
    assert.equal(r.pass, false);
  });

  it('warns but does not veto on a weak ADX', () => {
    const r = regimeFilters({ ta: { context: { atrPct: 0.002, adx: 8 } } });
    assert.equal(r.pass, true);
    assert.equal(r.warnings.length, 1);
  });

  it('stops an emission when a filter vetoes', () => {
    const f = {
      ta: factor(1, true, { atrPct: 0.00001, adx: 30 }),
      orderFlow: factor(1, true, { orderFlowDelta: 10 }),
      derivatives: factor(1), news: factor(1, true, { newsSentiment: 0.5 }), ml: factor(1),
    };
    const e = evaluate(f);
    assert.close(e.scs, 100);
    assert.equal(e.actionable, false);
  });
});

describe('trade plan', () => {
  const profile = { poc: 99.5, vah: 102, val: 97, hvns: [{ price: 104, volume: 10 }, { price: 95, volume: 9 }] };

  it('places a long stop below entry and targets above', () => {
    const p = buildTradePlan({
      direction: 1, price: 100, atr: 1, profile,
      structure: { swingLow: 97.5, swingHigh: 103 }, fvgs: [],
    });
    assert.ok(p.stop < p.entry.mid);
    for (const t of p.targets) assert.ok(t.price > p.entry.mid, `${t.name} must sit above entry`);
  });

  it('mirrors the geometry for a short', () => {
    const p = buildTradePlan({
      direction: -1, price: 100, atr: 1, profile,
      structure: { swingLow: 97, swingHigh: 102.5 }, fvgs: [],
    });
    assert.ok(p.stop > p.entry.mid);
    for (const t of p.targets) assert.ok(t.price < p.entry.mid);
  });

  it('sets TP1 at 1.5R and splits 40/40/20', () => {
    const p = buildTradePlan({ direction: 1, price: 100, atr: 1, profile, structure: {}, fvgs: [] });
    assert.close(p.targets[0].rr, 1.5, 1e-9);
    assert.deep(p.targets.map((t) => t.size), [0.4, 0.4, 0.2]);
    assert.equal(p.targets[0].action, 'move stop to breakeven');
  });

  it('widens the stop to a nearby swing beyond the ATR stop', () => {
    const tight = buildTradePlan({ direction: 1, price: 100, atr: 1, profile, structure: {}, fvgs: [] });
    const wide = buildTradePlan({ direction: 1, price: 100, atr: 1, profile, structure: { swingLow: 97.6 }, fvgs: [] });
    assert.ok(wide.stop < tight.stop, 'structural stop must sit further out');
  });

  it('ignores a swing further away than the ATR cap', () => {
    // A swing 4 ATR away is stale structure, not a stop: fall back to the ATR stop.
    const capped = buildTradePlan({ direction: 1, price: 100, atr: 1, profile, structure: { swingLow: 96 }, fvgs: [] });
    const plain = buildTradePlan({ direction: 1, price: 100, atr: 1, profile, structure: {}, fvgs: [] });
    assert.close(capped.stop, plain.stop, 1e-9);
  });

  it('rejects a setup whose stop is beyond the risk cap', () => {
    const p = buildTradePlan({ direction: 1, price: 100, atr: 20, profile, structure: {}, fvgs: [] });
    assert.equal(p.rejected, true);
  });

  it('anchors entry to an unfilled FVG when one is in the way', () => {
    const p = buildTradePlan({
      direction: 1, price: 100, atr: 1, profile: { poc: 80, hvns: [] },
      structure: {}, fvgs: [{ dir: 1, from: 99, to: 99.6, filled: false }],
    });
    assert.equal(p.entry.anchor, 'FVG');
  });

  it('sizes to the risk budget', () => {
    const s = positionSize({ equity: 10_000, riskFraction: 0.01, entryPrice: 100, stopPrice: 99 });
    assert.close(s.qty, 100);
    assert.close(s.riskAmount, 100);
  });

  it('caps notional at max leverage', () => {
    const s = positionSize({ equity: 1000, riskFraction: 0.5, entryPrice: 100, stopPrice: 99.99, maxLeverage: 5 });
    assert.close(s.notional, 5000, 1e-6);
  });

  it('never loosens a trailing stop', () => {
    const a = trailStop({ direction: 1, currentStop: 98, price: 100, atr: 1, mult: 2 });
    assert.close(a, 98, 1e-9);
    const b = trailStop({ direction: 1, currentStop: 98, price: 105, atr: 1, mult: 2 });
    assert.close(b, 103, 1e-9);
  });
});

describe('signal tracker lifecycle', () => {
  const plan = {
    direction: 1,
    entry: { low: 99.8, high: 100.2, mid: 100, anchor: 'POC' },
    stop: 99,
    risk: 1,
    targets: [
      { name: 'TP1', price: 101.5, size: 0.4, rr: 1.5, action: 'move stop to breakeven' },
      { name: 'TP2', price: 103, size: 0.4, rr: 3, action: 'node' },
      { name: 'TP3', price: 105, size: 0.2, rr: 5, action: 'trail' },
    ],
    trail: { atrMult: 2, atr: 1 },
    expiryBars: 3,
  };
  const evaluation = { scs: 82, classification: { bias: 'STRONG_LONG' }, breakdown: [] };
  const open = () => {
    const t = new SignalTracker({ persist: false });
    return { t, s: t.open({ symbol: 'BTC/USDT', timeframe: '5m', plan, evaluation }) };
  };

  it('starts PENDING and fills inside the entry zone', () => {
    const { t, s } = open();
    assert.equal(s.state, STATE.PENDING);
    t.update(s.id, { price: 100.1, high: 100.3, low: 99.9, ts: 2 });
    assert.equal(s.state, STATE.ACTIVE);
    assert.ok(s.fillPrice >= s.entry.low && s.fillPrice <= s.entry.high);
  });

  it('expires when price never reaches the zone', () => {
    const { t, s } = open();
    for (let i = 0; i < 4; i++) t.update(s.id, { price: 120, high: 121, low: 119.5, ts: i, barClosed: true });
    assert.equal(s.state, STATE.EXPIRED);
  });

  it('moves the stop to breakeven at TP1', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(s.id, { price: 101.6, high: 101.6, low: 100.5, ts: 2 });
    assert.equal(s.state, STATE.TP1_REACHED);
    assert.close(s.stop, s.fillPrice, 1e-9);
    assert.close(s.remaining, 0.6, 1e-9);
  });

  it('closes a win once every target is taken', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(s.id, { price: 106, high: 106, low: 100.5, ts: 2 });
    assert.equal(s.state, STATE.CLOSED_WIN);
    assert.ok(s.realizedPct > 0);
    assert.close(s.remaining, 0, 1e-9);
  });

  it('closes a loss on the stop', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(s.id, { price: 98.5, high: 100, low: 98.5, ts: 2 });
    assert.equal(s.state, STATE.CLOSED_LOSS);
    assert.ok(s.realizedPct < 0);
  });

  it('tracks MFE and MAE independently of the outcome', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(s.id, { price: 100.5, high: 101.4, low: 99.4, ts: 2 });
    assert.ok(s.mfe > 0, 'favourable excursion recorded');
    assert.ok(s.mae < 0, 'adverse excursion recorded');
    t.update(s.id, { price: 98.5, high: 99, low: 98.5, ts: 3 });
    assert.equal(s.state, STATE.CLOSED_LOSS);
    assert.ok(s.mfe > 0, 'MFE survives the loss for drift analysis');
  });

  it('records entry slippage drift', () => {
    const { t, s } = open();
    t.update(s.id, { price: 99.8, high: 100.0, low: 99.7, ts: 1 });
    assert.ok(Number.isFinite(s.slippageBps));
  });

  it('keeps an intact hash chain across the lifecycle', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(s.id, { price: 106, high: 106, low: 100.5, ts: 2 });
    assert.equal(t.verify(), -1);
    assert.ok(t.log.length >= 3);
  });

  it('detects a tampered log entry', () => {
    const { t, s } = open();
    t.update(s.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.log[0].symbol = 'ETH/USDT';
    assert.equal(verifyChain(t.log), 0);
  });

  it('aggregates win rate and profit factor', () => {
    const t = new SignalTracker({ persist: false });
    const a = t.open({ symbol: 'A', timeframe: '5m', plan, evaluation });
    t.update(a.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(a.id, { price: 106, high: 106, low: 100.5, ts: 2 });
    const b = t.open({ symbol: 'B', timeframe: '5m', plan, evaluation });
    t.update(b.id, { price: 100, high: 100.2, low: 99.9, ts: 1 });
    t.update(b.id, { price: 98.5, high: 100, low: 98.5, ts: 2 });
    const st = t.stats();
    assert.equal(st.resolved, 2);
    assert.close(st.winRate, 0.5);
    assert.ok(st.profitFactor > 0);
  });
});
