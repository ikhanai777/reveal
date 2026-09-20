#!/usr/bin/env node
//
// Live data verification.
//
//   node tools/verify-live.mjs [SYMBOL] [INTERVAL] [HOURS]
//   node tools/verify-live.mjs BTCUSDT 5m 2
//
// Proves that what this app builds is the exchange's own data, by rebuilding
// footprint bars from raw aggregated trades and reconciling them against
// Binance's independently-computed klines for the same window.
//
// The decisive check is `takerBuyBaseAssetVolume`: Binance publishes the
// aggressive-buy volume per kline, and this app derives the same number from
// the per-trade maker flag. If those agree, the bid/ask split the whole
// footprint rests on is correct — not merely plausible.
//
// This script talks to the real exchange. It has no fixtures and no fallback
// data: if the network is unreachable it fails loudly rather than inventing
// numbers. Set BINANCE_REST_HOST to route through a mirror or proxy.

import { BinanceClient } from '../js/binance.js';
import { loadTrades } from '../js/data.js';
import { buildBars, suggestRowTicks } from '../js/footprint.js';
import { intervalMs, decimalsFor } from '../js/util.js';

const [, , SYMBOL = 'BTCUSDT', INTERVAL = '5m', HOURS = '2'] = process.argv;

const hours = Number(HOURS);
if (!Number.isFinite(hours) || hours <= 0) {
  console.error(`Bad HOURS argument: ${HOURS}`);
  process.exit(2);
}

const hostOverride = process.env.BINANCE_REST_HOST;
const client = new BinanceClient(hostOverride ? { hosts: [hostOverride] } : {});

const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** Relative comparison, since volumes are floats summed in a different order. */
function close(a, b, tol = 1e-6) {
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-9);
  return Math.abs(a - b) / scale <= tol;
}

async function main() {
  console.log(`\nVerifying ${SYMBOL} ${INTERVAL} over the last ${hours}h against live Binance data.\n`);

  // --- 1. Reachability and symbol metadata.
  let info;
  try {
    info = await client.symbolInfo(SYMBOL);
  } catch (err) {
    console.error(bad('FAILED: could not reach Binance.'));
    console.error(`  ${err.message}`);
    console.error(dim([
      '',
      '  This script does not fall back to sample data. Fix the connection, then re-run.',
      '  Common causes:',
      '    · Binance blocks some regions (HTTP 451). data-api.binance.vision is the',
      '      public market-data mirror and is usually the most permissive host.',
      '    · A proxy or firewall is intercepting TLS.',
      '    · Set BINANCE_REST_HOST=https://your-mirror to route elsewhere.',
    ].join('\n')));
    process.exit(1);
  }

  const decimals = decimalsFor(info.tickSize);
  console.log(`${ok('✓')} reachable via ${client.host}`);
  console.log(`  ${info.symbol}  status=${info.status}  tick=${info.tickSize}  step=${info.stepSize}`);
  if (info.status !== 'TRADING') {
    console.log(bad(`  warning: symbol status is ${info.status}, not TRADING`));
  }

  // --- 2. Align the window to interval boundaries and drop the open bar.
  const step = intervalMs(INTERVAL);
  const serverTime = await client.serverTime();
  const end = Math.floor(serverTime / step) * step;          // last CLOSED bar boundary
  const start = end - Math.ceil((hours * 3_600_000) / step) * step;
  console.log(`\n  window ${new Date(start).toISOString()} → ${new Date(end).toISOString()}`);
  console.log(dim(`  server time ${new Date(serverTime).toISOString()} (in-progress bar excluded)`));

  // --- 3. Raw aggregated trades → footprint bars.
  process.stdout.write('\n  fetching aggregated trades… ');
  const t0 = Date.now();
  const { trades, stats } = await loadTrades({
    client,
    symbol: SYMBOL,
    start,
    end,
    useCache: false,                                          // always hit the wire here
    onProgress: (p) => {
      if (p.phase === 'fetching') {
        process.stdout.write(`\r  fetching aggregated trades… ${p.trades.toLocaleString()} (hour ${p.hour}/${p.hours})   `);
      }
    },
  });
  console.log(`\r  fetched ${trades.length.toLocaleString()} aggregated trades in ${((Date.now() - t0) / 1000).toFixed(1)}s over ${stats.requests} requests.        `);

  if (!trades.length) {
    console.error(bad('\nFAILED: the exchange returned no trades for that window.'));
    process.exit(1);
  }

  const first = trades[0];
  const last = trades[trades.length - 1];
  console.log(dim(`  first trade  id=${first.a}  ${new Date(first.T).toISOString()}  ${first.p} × ${first.q}`));
  console.log(dim(`  last  trade  id=${last.a}  ${new Date(last.T).toISOString()}  ${last.p} × ${last.q}`));

  const rowTicks = suggestRowTicks(trades, { tickSize: info.tickSize, intervalMs: step });
  const bars = buildBars(trades, {
    tickSize: info.tickSize,
    intervalMs: step,
    config: { rowTicks },
  });
  console.log(`  built ${bars.length} footprint bars (auto row size: ${rowTicks} ticks = ${(rowTicks * info.tickSize).toFixed(decimals)})`);

  // --- 4. Binance's own klines for the same window.
  const klines = await client.klineRange(SYMBOL, INTERVAL, start, end);
  const byOpen = new Map(klines.map((k) => [k.openTime, k]));
  console.log(`  fetched ${klines.length} klines for cross-check`);

  // --- 5. Reconcile. Only bars fully inside the window are comparable.
  const rows = [];
  let checked = 0;
  const failures = { ohlc: 0, volume: 0, takerBuy: 0, missing: 0 };

  for (const bar of bars) {
    if (bar.openTime < start || bar.closeTime > end) continue;
    const k = byOpen.get(bar.openTime);
    if (!k) { failures.missing++; continue; }
    checked++;

    const ohlcOk = bar.open === k.open && bar.high === k.high && bar.low === k.low && bar.close === k.close;
    const volOk = close(bar.volume, k.volume);
    const takerOk = close(bar.askVolume, k.takerBuyVolume, 1e-5);

    if (!ohlcOk) failures.ohlc++;
    if (!volOk) failures.volume++;
    if (!takerOk) failures.takerBuy++;

    rows.push({ bar, k, ohlcOk, volOk, takerOk });
  }

  console.log('\n  bar                    OHLC   volume (ours / kline)            aggressive buy (ours / kline)');
  console.log(dim('  ' + '─'.repeat(100)));
  for (const r of rows.slice(-10)) {
    const time = new Date(r.bar.openTime).toISOString().slice(11, 16);
    console.log(
      `  ${time}  ${r.ohlcOk ? ok('  ok ') : bad('MISMATCH')}  `
      + `${r.volOk ? ok('✓') : bad('✗')} ${r.bar.volume.toFixed(6)} / ${r.k.volume.toFixed(6)}   `
      + `${r.takerOk ? ok('✓') : bad('✗')} ${r.bar.askVolume.toFixed(6)} / ${r.k.takerBuyVolume.toFixed(6)}`,
    );
  }
  if (rows.length > 10) console.log(dim(`  … ${rows.length - 10} earlier bars checked and not shown`));

  // --- 6. Verdict.
  console.log('');
  if (!checked) {
    console.error(bad('FAILED: no bars were comparable. The window may be too short for this interval.'));
    process.exit(1);
  }

  const problems = failures.ohlc + failures.volume + failures.takerBuy + failures.missing;
  console.log(`  bars compared      ${checked}`);
  console.log(`  OHLC mismatches    ${failures.ohlc === 0 ? ok('0') : bad(String(failures.ohlc))}`);
  console.log(`  volume mismatches  ${failures.volume === 0 ? ok('0') : bad(String(failures.volume))}`);
  console.log(`  buy/sell split     ${failures.takerBuy === 0 ? ok('0 mismatches') : bad(`${failures.takerBuy} mismatches`)}`);
  if (failures.missing) console.log(`  bars with no kline ${bad(String(failures.missing))}`);

  if (problems === 0) {
    console.log(`\n${ok('PASS')} — footprint bars rebuilt from raw trades reconcile exactly with Binance's own klines,`);
    console.log('       including the aggressive-buy volume the bid/ask split depends on.');
    console.log('       The data this app charts is the exchange\'s, not a reconstruction of it.\n');
    process.exit(0);
  }

  console.log(`\n${bad('FAIL')} — ${problems} discrepancies. Do not trade off this until it is understood.`);
  console.log(dim('       A handful of volume mismatches at the window edges usually means the trade'));
  console.log(dim('       fetch was truncated; OHLC or buy/sell mismatches mean something is wrong.\n'));
  process.exit(1);
}

main().catch((err) => {
  console.error(bad(`\nFAILED: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
