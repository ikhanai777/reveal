// Dashboard wiring: feed selection, scanner lifecycle, rendering, and the
// backtest GUI. Everything below the UI layer is the same code the test suite
// exercises headlessly.

import { bus, TOPIC } from './core/bus.js';
import { load, save, KEYS } from './core/store.js';
import { tfMs } from './core/timeframe.js';
import { SyntheticFeed, syntheticCandles } from './ingest/synthetic.js';
import { BinanceAdapter } from './ingest/binance.js';
import { Scanner } from './scanner.js';
import { SignalTracker } from './signal/tracker.js';
import { WebhookDispatcher } from './delivery/webhooks.js';
import { buildTradePlan } from './signal/risk.js';
import { runBacktest } from './backtest/engine.js';
import { walkForward, weightGrid } from './backtest/walkforward.js';
import { monteCarlo } from './backtest/montecarlo.js';
import { $, el, clear, fmt, rafThrottle } from './ui/dom.js';
import { drawPriceChart, drawFootprint, drawDepth, drawEquity, drawDrawdown, drawMonthly, drawMonteCarlo } from './ui/charts.js';
import { renderHeatmap, renderFactors, renderPlan, renderSignalLog, renderMetrics, renderTrades, renderFolds, renderStatus } from './ui/panels.js';

// --- State -------------------------------------------------------------------

const settings = load(KEYS.settings, {
  source: 'sim',
  symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
  timeframe: '5m',
  tickSize: 0.5,
  theme: 'dark',
  dirPalette: 'safe',
});

const tracker = new SignalTracker({ persist: true });
const dispatcher = new WebhookDispatcher({});
const statuses = new Map();

let scanner = null;
let feed = null;
let adapter = null;
let selected = settings.symbols[0];
let running = false;
let lastBacktest = null;

// --- Feed lifecycle ----------------------------------------------------------

function stopFeed() {
  scanner?.stop();
  feed?.stop?.();
  adapter?.stop?.();
  scanner = null; feed = null; adapter = null;
  running = false;
  statuses.clear();
  paintStatus();
}

/**
 * Warm one simulated symbol. History arrives as pre-built candles rather than
 * as replayed ticks — 300 bars of 5m at six prints a second is close to half a
 * million events, which is both slow and a pointlessly long random walk. Only
 * the most recent bars are replayed tick by tick, which is all the footprint
 * and book engines need to have something real to show.
 */
function startSyntheticSymbol({ symbol, seed, startPrice, tickSize, timeframe }) {
  const ms = tfMs(timeframe);
  const bars = 300;
  const liveBars = 6;
  const startTs = Math.floor((Date.now() - bars * ms) / ms) * ms;
  const history = syntheticCandles({
    bars: bars - liveBars, tf: timeframe, tfMsValue: ms, seed, startPrice, startTs,
  });
  scanner?.engine(symbol)?.mtf.seed(timeframe, history);

  const f = new SyntheticFeed({
    bus, symbol, seed: seed + 1, tickSize,
    startPrice: history[history.length - 1].c,
    // Live prints arrive far more finely than the seeded history; telling the
    // generator its own sampling rate keeps both halves of the chart on the
    // same volatility, with no cliff where one hands over to the other.
    printsPerBar: 6 * (ms / 1000),
  });
  f.burst(liveBars * ms, startTs + (bars - liveBars) * ms);
  f.start({ intervalMs: 250 });
  return f;
}

function startFeed() {
  stopFeed();
  const { symbols, timeframe, tickSize, source } = settings;
  scanner = new Scanner({
    bus, symbols, timeframe,
    tickSizes: Object.fromEntries(symbols.map((s) => [s, tickSize])),
    tracker, dispatcher,
    evaluateEveryMs: 2500,
  });
  scanner.start();

  if (source === 'sim') {
    const feeds = symbols.map((sym, i) => startSyntheticSymbol({
      symbol: sym, seed: 7 + i * 19, startPrice: [64_000, 3_200, 145][i] ?? 100, tickSize, timeframe,
    }));
    feed = { stop: () => feeds.forEach((f) => f.stop()) };
  } else {
    const market = source === 'binance-spot' ? 'spot' : 'futures';
    adapter = new BinanceAdapter({ bus, symbols, market });
    adapter.start();
    // Backfill closed candles so scoring does not wait on the live stream.
    for (const sym of symbols) {
      adapter.klines(sym, timeframe, { limit: 500 })
        .then((rows) => scanner?.engine(sym)?.mtf.seed(timeframe, rows))
        .catch((err) => bus.emit(TOPIC.error, { topic: 'backfill', symbol: sym, error: err }));
    }
  }
  running = true;
  $('#feed-toggle').textContent = source === 'sim' ? 'Stop simulated feed' : 'Disconnect';
  paintStatus();
}

// --- Rendering ---------------------------------------------------------------

const paintStatus = rafThrottle(() => renderStatus($('#status'), statuses));

const paintScan = rafThrottle(() => {
  const rows = scanner?.snapshot() ?? settings.symbols.map((s) => ({ symbol: s, price: null, evaluation: null, bars: 0 }));
  renderHeatmap($('#heatmap'), rows, { selected, onSelect: (s) => { selected = s; paintScan(); paintDetail(); } });
  const warm = rows.filter((r) => r.evaluation).length;
  $('#scan-meta').textContent = running
    ? `${warm}/${rows.length} symbols scored · ${tracker.live().length} live signals`
    : 'Feed stopped';
});

const paintDetail = rafThrottle(() => {
  const eng = scanner?.engine(selected);
  const candles = eng?.candles() ?? [];
  drawPriceChart($('#price-chart'), {
    candles,
    profile: eng?.profile,
    signals: tracker.all().filter((s) => s.symbol === selected).slice(0, 12),
  });
  $('#price-meta').textContent = eng
    ? `${selected} · ${candles.length} closed bars · last ${fmt.price(eng.lastPrice)}`
    : 'no data';

  drawFootprint($('#fp-chart'), { footprints: eng?.footprints.recent(8) ?? [] });
  const fpLast = eng?.footprints.last;
  $('#fp-meta').textContent = fpLast
    ? `delta ${fpLast.delta >= 0 ? '+' : ''}${fmt.compact(fpLast.delta)} · ${fpLast.trades} prints`
    : '';

  const walls = eng?.walls.active().slice(0, 4) ?? [];
  drawDepth($('#depth-chart'), { book: eng?.book, walls });
  const obi = eng?.evaluation ? eng.factors.orderFlow.context.obi : null;
  $('#obi-meta').textContent = obi
    ? `OBI ${(obi.obi * 100).toFixed(0)}% · weighted ${(obi.weightedObi * 100).toFixed(0)}% · spread ${fmt.num(obi.spreadBps, 1)} bps · ${walls.length} walls`
    : 'no book snapshot yet';

  renderFactors($('#factors'), eng?.evaluation);

  let plan = null;
  if (eng?.evaluation?.classification?.direction) {
    plan = buildTradePlan({
      direction: eng.evaluation.classification.direction,
      price: eng.evaluation.price,
      atr: eng.factors.ta.context.atr,
      profile: eng.profile,
      structure: { swingHigh: eng.factors.ta.context.swingHigh, swingLow: eng.factors.ta.context.swingLow },
      fvgs: eng.factors.ta.context.fvgs || [],
    });
  }
  renderPlan($('#plan'), { evaluation: eng?.evaluation, plan, symbol: selected });
});

const paintLog = rafThrottle(() => {
  const signals = tracker.all();
  renderSignalLog($('#signal-log'), signals);
  const s = tracker.stats();
  renderMetrics($('#tracker-metrics'), [
    ['Signals', String(s.total)],
    ['Resolved', String(s.resolved)],
    ['Win rate', fmt.pct(s.winRate, 1), s.winRate >= 0.5 ? 'pos' : 'neg'],
    ['Net', fmt.signedPct(s.netPct), s.netPct >= 0 ? 'pos' : 'neg'],
    ['Profit factor', Number.isFinite(s.profitFactor) ? fmt.num(s.profitFactor) : '∞'],
    ['Avg MFE', fmt.signedPct(s.avgMfe)],
    ['Avg MAE', fmt.signedPct(s.avgMae)],
    ['Avg hold', fmt.duration(s.avgHoldMs)],
  ]);
  const broken = tracker.verify();
  $('#chain-state').textContent = broken === -1
    ? `chain intact · ${tracker.log.length} entries`
    : `chain broken at entry ${broken}`;
});

// --- Bus subscriptions -------------------------------------------------------

bus.on(TOPIC.status, (s) => { statuses.set(s.name, s); paintStatus(); });
bus.on(TOPIC.error, (e) => {
  statuses.set(e.topic || 'error', { state: 'error', detail: e.error?.message || String(e.error) });
  paintStatus();
});
bus.on(TOPIC.score, () => { paintScan(); paintDetail(); });
bus.on(TOPIC.signal, () => { paintLog(); paintScan(); });
tracker.onChange(() => paintLog());

// --- Controls ----------------------------------------------------------------

function persist() { save(KEYS.settings, settings); }

$('#feed-toggle').addEventListener('click', () => {
  if (running) { stopFeed(); $('#feed-toggle').textContent = settings.source === 'sim' ? 'Start simulated feed' : 'Connect'; }
  else startFeed();
});

$('#apply').addEventListener('click', () => {
  settings.source = $('#source').value;
  settings.symbols = $('#symbols').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  settings.timeframe = $('#timeframe').value;
  settings.tickSize = Number($('#ticksize').value) || 0.5;
  if (!settings.symbols.length) settings.symbols = ['BTC/USDT'];
  selected = settings.symbols[0];
  persist();
  syncLiveNote();
  if (running) startFeed(); else paintScan();
});

$('#source').addEventListener('change', syncLiveNote);
function syncLiveNote() {
  $('#live-note').hidden = $('#source').value === 'sim';
}

$('#theme-toggle').addEventListener('click', () => {
  settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = settings.theme;
  $('#theme-toggle').textContent = settings.theme === 'dark' ? 'Light' : 'Dark';
  persist();
  repaintCharts();
});

$('#palette-toggle').addEventListener('click', (ev) => {
  settings.dirPalette = settings.dirPalette === 'safe' ? 'classic' : 'safe';
  applyPalette();
  ev.currentTarget.setAttribute('aria-pressed', settings.dirPalette === 'classic' ? 'true' : 'false');
  persist();
  repaintCharts();
});

function applyPalette() {
  if (settings.dirPalette === 'classic') document.documentElement.dataset.dirpalette = 'classic';
  else delete document.documentElement.dataset.dirpalette;
}

function repaintCharts() {
  paintDetail();
  if (lastBacktest) paintBacktest(lastBacktest);
}

$('#clear-log').addEventListener('click', () => {
  if (confirm('Clear the signal log? The hash chain restarts from empty.')) {
    tracker.clear();
    paintLog();
  }
});

$('#export-log').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ signals: tracker.all(), log: tracker.log }, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `signals-${Date.now()}.json` });
  document.body.append(a);
  a.click();
  a.remove();
});

// --- Webhooks ----------------------------------------------------------------

$('#hook-add').addEventListener('click', () => {
  const url = $('#hook-url').value.trim();
  if (!url) return;
  dispatcher.add({
    id: `hook-${Date.now().toString(36)}`,
    type: $('#hook-type').value,
    url,
    minScs: Number($('#hook-min').value) || 0,
  });
  $('#hook-url').value = '';
  paintHooks();
});

function paintHooks() {
  const host = $('#hook-list');
  clear(host);
  if (!dispatcher.destinations.length) {
    host.append(el('p', { style: 'font-size:12px;color:var(--muted-2)', text: 'No destinations configured.' }));
    return;
  }
  for (const d of dispatcher.destinations) {
    const stat = dispatcher.stats.get(d.id) || { sent: 0, failed: 0 };
    host.append(el('div', { class: 'row', style: 'align-items:center;font-size:12px;gap:8px;padding:5px 0' }, [
      el('span', { class: 'pill', text: d.type }),
      el('span', { style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap', text: d.url }),
      el('span', { style: 'color:var(--muted)', text: `≥${d.minScs} · ${stat.sent} sent, ${stat.failed} failed` }),
      el('button', { class: 'btn ghost', type: 'button', onclick: () => { dispatcher.remove(d.id); paintHooks(); } }, ['Remove']),
    ]));
  }
}

// --- Backtest GUI ------------------------------------------------------------

const tabs = [
  ['#tab-perf', '#panel-perf'],
  ['#tab-trades', '#panel-trades'],
  ['#tab-wf', '#panel-wf'],
  ['#tab-mc', '#panel-mc'],
];
for (const [tab, panel] of tabs) {
  $(tab).addEventListener('click', () => {
    for (const [t, p] of tabs) {
      const on = t === tab;
      $(t).setAttribute('aria-selected', on ? 'true' : 'false');
      $(p).hidden = !on;
    }
    if (panel === '#panel-perf' && lastBacktest) paintBacktest(lastBacktest);
    if (panel === '#panel-mc' && lastMonteCarlo) paintMonteCarlo(lastMonteCarlo);
  });
}

function btStatus(message, busy = false) {
  const node = $('#bt-status');
  node.hidden = !message;
  node.textContent = message || '';
  $('#bt-progress').hidden = !busy;
  for (const id of ['#bt-run', '#bt-wf', '#bt-mc']) $(id).disabled = busy;
}

async function loadHistory() {
  const bars = Math.max(400, Number($('#bt-bars').value) || 3000);
  const tf = settings.timeframe;
  if ($('#bt-source').value === 'sim') {
    return { candles: syntheticCandles({ bars, tf, tfMsValue: tfMs(tf), seed: 42 }), label: 'synthetic' };
  }
  const src = adapter || new BinanceAdapter({ bus, symbols: [selected], market: settings.source === 'binance-spot' ? 'spot' : 'futures' });
  // Binance caps a klines page at 1000, so page backwards from now.
  const out = [];
  let endTime = Date.now();
  while (out.length < bars) {
    const page = await src.klines(selected, tf, { limit: Math.min(1000, bars - out.length), endTime });
    if (!page.length) break;
    out.unshift(...page);
    endTime = page[0].t - 1;
    if (page.length < 2) break;
  }
  return { candles: out, label: `${selected} ${tf} from exchange` };
}

let lastMonteCarlo = null;

$('#bt-run').addEventListener('click', async () => {
  btStatus('Loading history…', true);
  try {
    const { candles, label } = await loadHistory();
    btStatus(`Running ${candles.length} bars (${label})…`, true);
    // Yield once so the status paints before the synchronous engine runs.
    await new Promise((r) => setTimeout(r, 16));
    const dir = $('#bt-dir').value;
    const res = runBacktest({
      candles,
      timeframe: settings.timeframe,
      symbol: selected,
      config: {
        riskFraction: (Number($('#bt-risk').value) || 1) / 100,
        feeTier: $('#bt-fee').value,
        allowLong: dir !== 'short',
        allowShort: dir !== 'long',
      },
      onProgress: ({ i, total }) => { $('#bt-progress').value = i / total; },
    });
    lastBacktest = res;
    lastMonteCarlo = null;
    paintBacktest(res);
    btStatus(`${res.trades.length} trades over ${candles.length} bars · ${res.rejections.length} setups filtered out.`);
  } catch (err) {
    btStatus(`Backtest failed: ${err.message}`);
  } finally {
    $('#bt-progress').hidden = true;
    for (const id of ['#bt-run', '#bt-wf', '#bt-mc']) $(id).disabled = false;
  }
});

function paintBacktest(res) {
  const m = res.metrics;
  // CAGR and Calmar are NaN on a span too short to annualize; say so rather
  // than printing a six-figure percentage.
  const shortSpan = `n/a · ${Math.round(m.spanDays)}d`;
  renderMetrics($('#bt-metrics'), [
    ['Cumulative', fmt.signedPct(m.cumulativeReturn), m.cumulativeReturn >= 0 ? 'pos' : 'neg'],
    ['CAGR', Number.isFinite(m.cagr) ? fmt.signedPct(m.cagr) : shortSpan, Number.isFinite(m.cagr) ? (m.cagr >= 0 ? 'pos' : 'neg') : ''],
    ['Max drawdown', fmt.pct(m.maxDrawdown, 1), 'neg'],
    ['Sharpe', fmt.num(m.sharpe)],
    ['Sortino', fmt.num(m.sortino)],
    ['Calmar', Number.isFinite(m.calmar) ? fmt.num(m.calmar) : shortSpan],
    ['Profit factor', Number.isFinite(m.profitFactor) ? fmt.num(m.profitFactor) : '∞'],
    ['Win rate', fmt.pct(m.winRate, 1)],
    ['Trades', String(m.trades)],
    ['Max losses in a row', String(m.maxConsecutiveLosses)],
    ['Avg hold', fmt.duration(m.avgHoldingMs)],
    ['Costs', fmt.compact(m.totalFees + m.totalSlippage + m.totalFunding)],
  ]);
  drawEquity($('#equity-chart'), { curve: res.equityCurve });
  drawDrawdown($('#dd-chart'), { series: m.drawdownSeries });
  drawMonthly($('#monthly-chart'), { monthly: m.monthly });
  renderTrades($('#bt-trades'), res.trades);
}

$('#bt-wf').addEventListener('click', async () => {
  btStatus('Loading history for walk-forward…', true);
  try {
    const { candles } = await loadHistory();
    btStatus('Optimizing in-sample and validating out-of-sample…', true);
    await new Promise((r) => setTimeout(r, 16));
    const res = walkForward({
      candles,
      timeframe: settings.timeframe,
      candidates: weightGrid({ steps: [-0.08, 0, 0.08], keys: ['orderFlow', 'ta'] }),
      config: { useForecaster: false },
      onProgress: ({ at, total }) => { $('#bt-progress').value = at / total; },
    });
    renderFolds($('#wf-result'), res);
    const s = res.summary;
    btStatus(`${s.foldCount} folds · in-sample Sharpe ${fmt.num(s.avgInSampleSharpe)} vs out-of-sample ${fmt.num(s.avgOutSampleSharpe)} (efficiency ${fmt.num(s.avgEfficiency)}).`);
    $('#tab-wf').click();
  } catch (err) {
    btStatus(`Walk-forward failed: ${err.message}`);
  } finally {
    $('#bt-progress').hidden = true;
    for (const id of ['#bt-run', '#bt-wf', '#bt-mc']) $(id).disabled = false;
  }
});

$('#bt-mc').addEventListener('click', () => {
  if (!lastBacktest?.trades.length) { btStatus('Run a backtest first — Monte Carlo reshuffles its trades.'); return; }
  lastMonteCarlo = monteCarlo(lastBacktest.trades, { runs: 1000, startEquity: lastBacktest.config.equity });
  paintMonteCarlo(lastMonteCarlo);
  $('#tab-mc').click();
  btStatus(`1,000 reshuffles · 95% of paths stay above ${fmt.pct(lastMonteCarlo.drawdown95, 1)} drawdown.`);
});

function paintMonteCarlo(mc) {
  renderMetrics($('#mc-metrics'), [
    ['Median drawdown', fmt.pct(mc.maxDrawdown.median, 1), 'neg'],
    ['5th percentile', fmt.pct(mc.maxDrawdown.p05, 1), 'neg'],
    ['Worst path', fmt.pct(mc.maxDrawdown.min, 1), 'neg'],
    ['Risk of ruin', fmt.pct(mc.riskOfRuin, 1)],
    ['Median equity', fmt.compact(mc.finalEquity.median)],
    ['Runs', String(mc.runs)],
  ]);
  drawMonteCarlo($('#mc-chart'), { curves: mc.curves });
}

// --- Boot --------------------------------------------------------------------

document.documentElement.dataset.theme = settings.theme;
applyPalette();
$('#theme-toggle').textContent = settings.theme === 'dark' ? 'Light' : 'Dark';
$('#palette-toggle').setAttribute('aria-pressed', settings.dirPalette === 'classic' ? 'true' : 'false');
$('#source').value = settings.source;
$('#symbols').value = settings.symbols.join(', ');
$('#timeframe').value = settings.timeframe;
$('#ticksize').value = settings.tickSize;
syncLiveNote();
paintScan();
paintLog();
paintHooks();
paintDetail();

window.addEventListener('resize', rafThrottle(() => repaintCharts()));

// The dashboard is useful the moment it opens, so the offline venue starts on load.
if (settings.source === 'sim') startFeed();
