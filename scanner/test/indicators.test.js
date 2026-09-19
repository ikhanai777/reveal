import { describe, it, assert } from './harness.js';
import { sma, ema, wilder, rsi, atr, adx, bollinger, macd, emaRibbon, bbSqueeze } from '../js/engines/indicators.js';
import { quantile, stdev, downsideDeviation, correlation, slope, roundToStep } from '../js/core/num.js';

const seq = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

describe('core/num', () => {
  it('quantile interpolates', () => {
    assert.close(quantile([1, 2, 3, 4], 0.5), 2.5);
    assert.close(quantile([1, 2, 3, 4, 5], 0), 1);
    assert.close(quantile([1, 2, 3, 4, 5], 1), 5);
  });

  it('stdev matches the sample formula', () => {
    // sample stdev of [2,4,4,4,5,5,7,9] is 2.13809...
    assert.close(stdev([2, 4, 4, 4, 5, 5, 7, 9]), 2.13808993529939, 1e-9);
    assert.close(stdev([2, 4, 4, 4, 5, 5, 7, 9], false), 2, 1e-12);
  });

  it('downside deviation ignores upside', () => {
    assert.close(downsideDeviation([0.1, 0.2, 0.3]), 0);
    assert.close(downsideDeviation([-0.1, 0.2, -0.1]), Math.sqrt((0.01 + 0.01) / 3), 1e-12);
  });

  it('correlation is +/-1 on collinear inputs', () => {
    assert.close(correlation([1, 2, 3], [2, 4, 6]), 1, 1e-12);
    assert.close(correlation([1, 2, 3], [6, 4, 2]), -1, 1e-12);
  });

  it('slope recovers a linear trend', () => {
    assert.close(slope([1, 3, 5, 7]), 2, 1e-12);
  });

  it('roundToStep kills float dust', () => {
    assert.equal(roundToStep(0.1 + 0.2, 0.05), 0.3);
    assert.equal(roundToStep(42_102.4, 0.5), 42_102.5);
  });
});

describe('indicators', () => {
  it('SMA is null through warm-up then exact', () => {
    const v = [1, 2, 3, 4, 5];
    const out = sma(v, 3);
    assert.equal(out[0], null);
    assert.equal(out[1], null);
    assert.close(out[2], 2);
    assert.close(out[4], 4);
  });

  it('EMA seeds on the SMA and converges', () => {
    const v = seq(50, () => 10);
    const out = ema(v, 10);
    assert.equal(out[8], null);
    assert.close(out[9], 10);
    assert.close(out[49], 10);
  });

  it('EMA of a ramp trails the last value', () => {
    const v = seq(60, (i) => i);
    const out = ema(v, 10);
    assert.ok(out[59] < 59 && out[59] > 50, 'EMA lags a rising ramp');
  });

  it('Wilder smoothing matches its recurrence', () => {
    const v = [1, 2, 3, 4, 5, 6];
    const out = wilder(v, 3);
    assert.close(out[2], 2);                        // seed = mean(1,2,3)
    assert.close(out[3], 2 + (4 - 2) / 3, 1e-12);
    assert.close(out[4], out[3] + (5 - out[3]) / 3, 1e-12);
  });

  it('RSI pins at 100 on a monotonic rise and 0 on a fall', () => {
    const up = rsi(seq(40, (i) => 100 + i), 14);
    assert.close(up[39], 100, 1e-9);
    const down = rsi(seq(40, (i) => 100 - i), 14);
    assert.close(down[39], 0, 1e-9);
  });

  it('RSI sits at 50 on a symmetric zigzag', () => {
    const v = seq(200, (i) => 100 + (i % 2 ? 1 : 0));
    const out = rsi(v, 14);
    assert.between(out[199], 45, 55);
  });

  it('ATR equals the range on constant-range candles', () => {
    const candles = seq(40, () => ({ o: 100, h: 102, l: 98, c: 100 }));
    const out = atr(candles, 14);
    assert.close(out[39], 4, 1e-9);
  });

  it('ADX is high in a clean trend and low in chop', () => {
    const trend = seq(120, (i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
    const trendAdx = adx(trend, 14).adx.filter((v) => v != null).pop();
    assert.ok(trendAdx > 40, `expected strong trend ADX, got ${trendAdx}`);

    const chop = seq(160, (i) => {
      const base = 100 + (i % 2 ? 1 : -1);
      return { o: base, h: base + 1, l: base - 1, c: base };
    });
    const chopAdx = adx(chop, 14).adx.filter((v) => v != null).pop();
    assert.ok(chopAdx < 30, `expected weak chop ADX, got ${chopAdx}`);
  });

  it('ADX reports +DI above -DI when rising', () => {
    const trend = seq(120, (i) => ({ o: 100 + i, h: 101 + i, l: 99 + i, c: 100.5 + i }));
    const a = adx(trend, 14);
    assert.ok(a.plusDI[119] > a.minusDI[119]);
  });

  it('Bollinger bands are symmetric around the SMA', () => {
    const v = seq(60, (i) => 100 + Math.sin(i));
    const bb = bollinger(v, 20, 2);
    const i = 59;
    assert.close(bb.upper[i] - bb.mid[i], bb.mid[i] - bb.lower[i], 1e-9);
    assert.ok(bb.bandwidth[i] > 0);
  });

  it('Bollinger collapses to zero width on a flat series', () => {
    const bb = bollinger(seq(40, () => 100), 20, 2);
    assert.close(bb.bandwidth[39], 0, 1e-12);
  });

  it('MACD histogram is line minus signal', () => {
    const v = seq(120, (i) => 100 + Math.sin(i / 5) * 3 + i * 0.1);
    const m = macd(v);
    const i = 119;
    assert.close(m.hist[i], m.line[i] - m.signal[i], 1e-9);
  });

  it('EMA ribbon reports a bullish stack in an uptrend', () => {
    const v = seq(320, (i) => 100 + i * 0.5);
    const r = emaRibbon(v);
    assert.equal(r.ready, true);
    assert.equal(r.stack, 1);
  });

  it('BB squeeze fires when bandwidth compresses', () => {
    // Wide noise, then a flat tail: the tail must read as coiled.
    const noisy = seq(200, (i) => 100 + Math.sin(i) * 8);
    const calm = seq(60, () => 100);
    const sq = bbSqueeze([...noisy, ...calm]);
    assert.equal(sq.squeeze, true);
  });
});
