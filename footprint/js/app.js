// Application wiring: data loading, footprint building, signals, backtest,
// chart and panels.

import { BinanceClient, LiveStream } from './binance.js';
import { loadTrades } from './data.js';
import { tradeCache } from './cache.js';
import { FootprintBuilder, DEFAULT_FOOTPRINT_CONFIG, suggestRowTicks } from './footprint.js';
import { generateSignals, DEFAULT_SIGNAL_CONFIG } from './signals.js';
import { runBacktest, buyAndHold, DEFAULT_BACKTEST_CONFIG } from './backtest.js';
import { FootprintChart } from './chart.js';
import { LineChart } from './linechart.js';
import {
  el, clear, buildFields, buildRuleControls, renderStats, renderSegments, renderTrades,
  renderSignalFeed, renderBreakdown, renderKv, renderTooltip, setupTabs,
} from './ui.js';
import {
  intervalMs, decimalsFor, fmtMoney, fmtVol, fmtTime, fmtPct, mergeDeep, debounce,
  downloadText, toCsv, clamp,
} from './util.js';

const SETTINGS_KEY = 'footprint-terminal.settings.v1';
const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ state */

const defaults = {
  symbol: 'BTCUSDT',
  interval: '5m',
  rangeHours: 6,
  theme: 'dark',
  palette: 'classic',
  footprint: { ...DEFAULT_FOOTPRINT_CONFIG, rowTicks: 0 },  // 0 = size rows from the data
  display: {
    mode: 'bidask',
    showImbalance: true,
    showValueArea: true,
    showSignals: true,
    showTrades: true,
    scaleBy: 'visible',
    colWidth: 92,
  },
  signals: structuredClone(DEFAULT_SIGNAL_CONFIG),
  backtest: { ...DEFAULT_BACKTEST_CONFIG },
};

const settings = loadSettings();

const state = {
  client: new BinanceClient(),
  info: null,          // symbol metadata
  trades: [],          // raw agg trades for the loaded range
  bars: [],
  signals: [],
  result: null,
  buyHold: null,
  builder: null,
  stream: null,
  abort: null,
  loading: false,
  decimals: 2,
  loadedAt: null,
  loadStats: null,
  rowTicks: 1,         // resolved row size (auto or explicit)
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return structuredClone(defaults);
    return mergeDeep(structuredClone(defaults), JSON.parse(raw));
  } catch {
    return structuredClone(defaults);
  }
}

const saveSettings = debounce(() => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage may be blocked */ }
}, 300);

/* ----------------------------------------------------------------- chart */

const chart = new FootprintChart($('chart'), {
  onHover: (hover) => renderTooltip($('tooltip'), hover, {
    decimals: state.decimals,
    signals: state.signals,
    symbol: settings.symbol,
    interval: settings.interval,
  }),
  onViewChange: ({ follow }) => {
    if (follow === false) $('live').dataset.follow = 'off';
  },
});

const equityChart = new LineChart($('equity'), {
  formatValue: (v) => fmtMoney(v, 0),
  onHover: (h) => {
    const out = $('equity-readout');
    if (!h) { out.textContent = ''; return; }
    out.textContent = `${fmtTime(h.time, true)}  ·  ` + h.readings.map((r) => `${r.label} ${fmtMoney(r.point.y, 0)}`).join('   ');
  },
});

const ro = new ResizeObserver(() => { chart.resize(); equityChart.resize(); });
ro.observe($('chart').parentElement);
ro.observe($('equity').parentElement);

/* ---------------------------------------------------------- field schemas */

const footprintSchema = [
  { key: 'rowTicks', label: 'Ticks per row (0 = auto)', type: 'number', min: 0, max: 100000, step: 1, hint: 'Group N exchange ticks into one footprint row. 0 sizes rows from the data so a typical bar has about ten of them.' },
  { key: 'imbalanceRatio', label: 'Imbalance ratio', type: 'number', min: 1.2, max: 20, step: 0.1, hint: 'Diagonal ask/bid ratio that marks a row as imbalanced.' },
  { key: 'imbalanceMinVol', label: 'Imbalance min volume', type: 'number', min: 0, step: 0.001, hint: 'Ignore imbalances below this absolute volume.' },
  { key: 'stackLength', label: 'Stack length', type: 'number', min: 2, max: 10, step: 1 },
  { key: 'valueAreaPct', label: 'Value area', type: 'number', min: 0.3, max: 0.95, step: 0.05, hint: 'Share of bar volume inside the value area (0.7 = 70%).' },
];

const displaySchema = [
  { key: 'mode', label: 'Cell mode', type: 'select', options: [
    { value: 'bidask', label: 'Bid × Ask' },
    { value: 'delta', label: 'Delta' },
    { value: 'profile', label: 'Profile' },
  ] },
  { key: 'scaleBy', label: 'Colour scale', type: 'select', options: [
    { value: 'visible', label: 'Across visible bars' },
    { value: 'bar', label: 'Within each bar' },
  ] },
  { key: 'colWidth', label: 'Column width (px)', type: 'number', min: 4, max: 240, step: 2 },
  { key: 'showImbalance', label: 'Imbalances & stacks', type: 'checkbox' },
  { key: 'showValueArea', label: 'Value area', type: 'checkbox' },
  { key: 'showSignals', label: 'Signal markers', type: 'checkbox' },
  { key: 'showTrades', label: 'Backtest trades', type: 'checkbox' },
];

const signalSchema = [
  { key: 'mode', label: 'Combination', type: 'select', options: [
    { value: 'composite', label: 'Composite (weighted vote)' },
    { value: 'any', label: 'Any rule fires' },
  ] },
  { key: 'threshold', label: 'Score threshold', type: 'number', min: 0.1, max: 6, step: 0.1, showIf: (c) => c.mode === 'composite' },
  { key: 'cooldownBars', label: 'Cooldown (bars)', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'trendFilter', label: 'Trend filter', type: 'select', options: [
    { value: 'off', label: 'Off' },
    { value: 'with', label: 'Only with EMA trend' },
    { value: 'against', label: 'Only against EMA trend' },
  ] },
  { key: 'trendPeriod', label: 'EMA period', type: 'number', min: 3, max: 200, step: 1, showIf: (c) => c.trendFilter !== 'off' },
  { key: 'minVolumeZ', label: 'Min volume z-score', type: 'number', min: -5, max: 4, step: 0.25 },
];

const backtestSchema = [
  { key: 'initialCapital', label: 'Initial capital', type: 'number', min: 100, step: 100 },
  { key: 'direction', label: 'Direction', type: 'select', options: [
    { value: 'both', label: 'Long & short' },
    { value: 'long', label: 'Long only' },
    { value: 'short', label: 'Short only' },
  ] },
  { key: 'entry', label: 'Entry fill', type: 'select', options: [
    { value: 'nextOpen', label: 'Next bar open (realistic)' },
    { value: 'signalClose', label: 'Signal bar close (optimistic)' },
  ] },

  { key: 'sizing', label: 'Position sizing', type: 'select', options: [
    { value: 'risk', label: '% of equity at risk' },
    { value: 'fixedNotional', label: 'Fixed notional' },
    { value: 'fixedQty', label: 'Fixed quantity' },
  ] },
  { key: 'riskPct', label: 'Risk per trade (%)', type: 'number', min: 0.05, max: 100, step: 0.05, showIf: (c) => c.sizing === 'risk' },
  { key: 'fixedNotional', label: 'Notional', type: 'number', min: 1, step: 50, showIf: (c) => c.sizing === 'fixedNotional' },
  { key: 'fixedQty', label: 'Quantity', type: 'number', min: 0, step: 0.001, showIf: (c) => c.sizing === 'fixedQty' },
  { key: 'maxNotionalPct', label: 'Max notional (% equity)', type: 'number', min: 1, max: 1000, step: 5 },

  { key: 'stopMode', label: 'Stop', type: 'select', options: [
    { value: 'atr', label: 'ATR multiple' },
    { value: 'ticks', label: 'Fixed ticks' },
    { value: 'percent', label: 'Percent' },
    { value: 'barExtreme', label: 'Signal bar extreme' },
  ] },
  { key: 'stopAtr', label: 'Stop × ATR', type: 'number', min: 0.1, max: 10, step: 0.1, showIf: (c) => c.stopMode === 'atr' },
  { key: 'stopTicks', label: 'Stop ticks', type: 'number', min: 1, step: 1, showIf: (c) => c.stopMode === 'ticks' },
  { key: 'stopPct', label: 'Stop %', type: 'number', min: 0.01, max: 20, step: 0.01, showIf: (c) => c.stopMode === 'percent' },
  { key: 'stopBufferTicks', label: 'Stop buffer (ticks)', type: 'number', min: 0, step: 1, showIf: (c) => c.stopMode === 'barExtreme' || c.trailMode === 'priorBar' },

  { key: 'targetMode', label: 'Target', type: 'select', options: [
    { value: 'rr', label: 'R multiple' },
    { value: 'atr', label: 'ATR multiple' },
    { value: 'ticks', label: 'Fixed ticks' },
    { value: 'percent', label: 'Percent' },
    { value: 'none', label: 'None (stop / time only)' },
  ] },
  { key: 'targetR', label: 'Target R', type: 'number', min: 0.2, max: 20, step: 0.1, showIf: (c) => c.targetMode === 'rr' },
  { key: 'targetAtr', label: 'Target × ATR', type: 'number', min: 0.2, max: 20, step: 0.1, showIf: (c) => c.targetMode === 'atr' },
  { key: 'targetTicks', label: 'Target ticks', type: 'number', min: 1, step: 1, showIf: (c) => c.targetMode === 'ticks' },
  { key: 'targetPct', label: 'Target %', type: 'number', min: 0.01, max: 50, step: 0.01, showIf: (c) => c.targetMode === 'percent' },

  { key: 'trailMode', label: 'Trailing stop', type: 'select', options: [
    { value: 'off', label: 'Off' },
    { value: 'atr', label: 'ATR trail' },
    { value: 'priorBar', label: 'Prior bar extreme' },
    { value: 'breakeven', label: 'Breakeven at R' },
  ] },
  { key: 'trailAtr', label: 'Trail × ATR', type: 'number', min: 0.2, max: 10, step: 0.1, showIf: (c) => c.trailMode === 'atr' },
  { key: 'breakevenAtR', label: 'Breakeven at R', type: 'number', min: 0.1, max: 5, step: 0.1, showIf: (c) => c.trailMode === 'breakeven' },

  { key: 'maxBars', label: 'Time stop (bars, 0 = off)', type: 'number', min: 0, max: 500, step: 1 },
  { key: 'exitOnOpposite', label: 'Exit on opposite signal', type: 'checkbox' },

  { key: 'feeBps', label: 'Fee per side (bps)', type: 'number', min: 0, max: 100, step: 0.5 },
  { key: 'slippageTicks', label: 'Slippage (ticks)', type: 'number', min: 0, max: 100, step: 1 },
  { key: 'pessimisticFills', label: 'Pessimistic ambiguous bars', type: 'checkbox', hint: 'When a bar hits both stop and target, assume the stop filled first.' },
  { key: 'atrPeriod', label: 'ATR period', type: 'number', min: 2, max: 100, step: 1 },
  { key: 'oosSplitPct', label: 'In-sample split (%, 0 = off)', type: 'number', min: 0, max: 95, step: 5 },
];

/* ------------------------------------------------------------- rendering */

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.dataset.palette = settings.palette;
  chart.requestRender();
  equityChart.render();
}

function applyDisplay() {
  chart.setOptions({
    mode: settings.display.mode,
    showImbalance: settings.display.showImbalance,
    showValueArea: settings.display.showValueArea,
    showSignals: settings.display.showSignals,
    showTrades: settings.display.showTrades,
    scaleBy: settings.display.scaleBy,
    colWidth: clamp(settings.display.colWidth, 4, 240),
  });
}

function refreshChart() {
  chart.setData({
    bars: state.bars,
    signals: settings.display.showSignals ? state.signals : [],
    trades: settings.display.showTrades ? (state.result?.trades ?? []) : [],
    tickSize: state.info?.tickSize ?? 0.01,
    decimals: state.decimals,
    rowTicks: state.rowTicks,
  });
}

function updateChartMeta() {
  $('chart-symbol').textContent = `${settings.symbol} · ${settings.interval}`;
  const b = state.bars.length;
  if (!b) {
    $('chart-meta').textContent = 'no data';
    return;
  }
  const last = state.bars[b - 1];
  const parts = [
    `${b} bars`,
    `${state.trades.length.toLocaleString()} trades`,
    `last ${last.close.toFixed(state.decimals)}`,
    `ΣΔ ${fmtVol(last.cumDelta, 2)}`,
    `row ${(state.rowTicks * (state.info?.tickSize ?? 0)).toFixed(state.decimals)}${settings.footprint.rowTicks > 0 ? '' : ' (auto)'}`,
  ];
  if (state.stream) parts.push('LIVE');
  $('chart-meta').textContent = parts.join(' · ');
}

function recomputeSignals() {
  state.signals = state.bars.length ? generateSignals(state.bars, settings.signals) : [];
  renderSignalFeed($('signal-feed'), state.signals, state.decimals, focusBar);
  refreshChart();
  updateChartMeta();
}

function rebuildBars() {
  if (!state.trades.length || !state.info) return;
  const ms = intervalMs(settings.interval);
  state.rowTicks = settings.footprint.rowTicks > 0
    ? Math.round(settings.footprint.rowTicks)
    : suggestRowTicks(state.trades, { tickSize: state.info.tickSize, intervalMs: ms });

  const builder = new FootprintBuilder({
    tickSize: state.info.tickSize,
    intervalMs: ms,
    config: { ...settings.footprint, rowTicks: state.rowTicks },
  });
  builder.addTrades(state.trades);
  builder.flush();
  state.builder = builder;
  state.bars = builder.bars;
  state.result = null;
  state.buyHold = buyAndHold(state.bars, settings.backtest.initialCapital);
  recomputeSignals();   // pushes the new bars into the chart
  chart.fit();          // row size changed, so the vertical scale must be redone
  renderResults();
}

function renderResults() {
  renderStats($('stat-grid'), state.result, state.buyHold);
  renderSegments($('segment-stats'), state.result);
  renderTrades($('trades-table'), state.result?.trades, state.decimals, (t) => focusBar({ barIndex: t.entryBar }));
  renderBreakdown($('breakdown-tables'), state.result);
  renderEquity();
}

function renderEquity() {
  const legend = $('equity-legend');
  clear(legend);
  if (!state.result?.curve.length) {
    equityChart.setSeries([]);
    return;
  }
  const css = getComputedStyle(document.documentElement);
  const c1 = css.getPropertyValue('--series-1').trim();
  const c2 = css.getPropertyValue('--series-2').trim();
  const c3 = css.getPropertyValue('--series-3').trim();

  const strategy = state.result.curve.map((p) => ({ x: p.time, y: p.equity }));
  const series = [{ key: 'strategy', label: 'Strategy', color: c1, points: strategy }];

  if (state.buyHold?.curve.length) {
    series.push({ key: 'bh', label: 'Buy & hold', color: c2, points: state.buyHold.curve.map((p) => ({ x: p.time, y: p.equity })), dashed: true });
  }

  // Running peak makes the drawdown legible without a second y-scale.
  let peak = -Infinity;
  const peakPoints = strategy.map((p) => {
    peak = Math.max(peak, p.y);
    return { x: p.x, y: peak };
  });
  series.push({ key: 'peak', label: 'Equity peak', color: c3, points: peakPoints, dashed: true });

  const markers = [];
  if (state.result.splitIndex !== null && state.bars[state.result.splitIndex]) {
    markers.push({
      x: state.bars[state.result.splitIndex].closeTime,
      label: 'out-of-sample →',
      color: css.getPropertyValue('--chart-warn').trim(),
    });
  }
  equityChart.setSeries(series, markers);

  for (const s of series) {
    legend.append(el('span', { class: 'legend-item' }, [
      el('i', { class: 'swatch', style: `background:${s.color}` }),
      s.label,
    ]));
  }
}

function focusBar(target) {
  const i = target?.barIndex;
  if (i === undefined || !state.bars[i]) return;
  chart.follow = false;
  chart.scrollX = Math.max(0, i * chart.colWidth - chart.plotWidth / 2);
  chart.centerPrice = state.bars[i].close;
  chart.requestRender();
  document.querySelector('.canvas-wrap').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ------------------------------------------------------------ data loading */

function setProgress(visible, text, frac) {
  $('progress').hidden = !visible;
  if (text !== undefined) $('progress-text').textContent = text;
  if (frac !== undefined) $('progress-fill').style.width = `${clamp(frac * 100, 0, 100)}%`;
}

async function load() {
  if (state.loading) return;
  stopLive();

  const symbol = $('symbol').value.trim().toUpperCase();
  settings.symbol = symbol;
  settings.interval = $('interval').value;
  settings.rangeHours = Number($('range').value);
  saveSettings();

  state.loading = true;
  state.abort = new AbortController();
  $('load').disabled = true;
  $('cancel').hidden = false;
  setProgress(true, 'Resolving symbol…', 0);

  try {
    state.info = await state.client.symbolInfo(symbol);
    state.decimals = decimalsFor(state.info.tickSize);

    const end = Date.now();
    const start = end - settings.rangeHours * 3_600_000;

    const { trades, stats } = await loadTrades({
      client: state.client,
      symbol,
      start,
      end,
      signal: state.abort.signal,
      onProgress: (p) => {
        const frac = p.hours ? p.hour / p.hours : 0;
        setProgress(true,
          `${p.trades.toLocaleString()} trades · hour ${p.hour}/${p.hours} · ${p.cachedHours} cached, ${p.fetchedHours} fetched`,
          frac);
      },
    });

    state.trades = trades;
    state.loadStats = stats;
    state.loadedAt = Date.now();

    if (!trades.length) {
      setProgress(true, 'No trades returned for that range.', 1);
      setTimeout(() => setProgress(false), 2500);
    } else {
      setProgress(true, `Building ${settings.interval} footprint bars…`, 1);
      await new Promise((r) => setTimeout(r, 0));
    }

    rebuildBars();
    chart.follow = true;
    chart.fit();
    chart.scrollToEnd();
    updateChartMeta();
    refreshCacheInfo();
    setProgress(false);
  } catch (err) {
    if (err.name === 'AbortError') {
      setProgress(true, 'Cancelled.', 0);
      setTimeout(() => setProgress(false), 1200);
    } else {
      setProgress(true, `Load failed: ${err.message}`, 0);
      console.error(err);
    }
  } finally {
    state.loading = false;
    state.abort = null;
    $('load').disabled = false;
    $('cancel').hidden = true;
    refreshSessionInfo();
  }
}

/* ------------------------------------------------------------------- live */

function startLive() {
  if (!state.builder || !state.info) return;
  const liveBtn = $('live');
  state.stream = new LiveStream(settings.symbol, {
    onTrade: (t) => {
      const before = state.builder.bars.length;
      state.builder.addTrade(t);
      state.trades.push(t);
      state.builder.refreshCurrent();
      state.bars = state.builder.bars;
      if (state.builder.bars.length !== before) {
        // A bar just closed — re-score the series.
        recomputeSignals();
      }
      if (chart.follow) chart.scrollToEnd();
      chart.requestRender();
      liveMetaUpdate();
    },
    onStatus: (s) => {
      liveBtn.textContent = s.state === 'open' ? 'Live ●' : s.state === 'connecting' ? 'Connecting…' : s.state === 'reconnecting' ? 'Reconnecting…' : 'Go live';
      liveBtn.setAttribute('aria-pressed', String(s.state === 'open'));
    },
  });
  state.stream.start();
  chart.follow = true;
}

const liveMetaUpdate = debounce(updateChartMeta, 400);

function stopLive() {
  if (!state.stream) return;
  state.stream.stop();
  state.stream = null;
  $('live').textContent = 'Go live';
  $('live').setAttribute('aria-pressed', 'false');
  updateChartMeta();
}

/* --------------------------------------------------------------- backtest */

function runBacktestNow() {
  if (!state.bars.length) {
    setProgress(true, 'Load data before running a backtest.', 0);
    setTimeout(() => setProgress(false), 2000);
    return;
  }
  state.buyHold = buyAndHold(state.bars, settings.backtest.initialCapital);
  state.result = runBacktest(state.bars, state.signals, {
    tickSize: state.info?.tickSize ?? 0.01,
    intervalMs: intervalMs(settings.interval),
    config: settings.backtest,
  });
  renderResults();
  refreshChart();

  // Surface the outcome without making the user hunt for the tab.
  const perfTab = document.querySelector('.results .tab[data-tab="perf-tab"]');
  perfTab?.click();
  const s = state.result.stats;
  setProgress(true, `${s.trades} trades · ${fmtMoney(s.netProfit)} (${fmtPct(s.netProfitPct)}) · PF ${Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : '—'}`, 1);
  setTimeout(() => setProgress(false), 3500);
}

/* ------------------------------------------------------------ data panels */

async function refreshCacheInfo() {
  const s = await tradeCache.stats();
  renderKv($('cache-info'), [
    ['Cached hours', String(s.hours)],
    ['Cached trades', s.trades.toLocaleString()],
    ['Approx. size', `${(s.approxBytes / 1e6).toFixed(1)} MB`],
    ['Symbols', s.symbols.map((x) => `${x.symbol}×${x.hours}`).join(', ') || '—'],
  ]);
}

function refreshSessionInfo() {
  renderKv($('session-info'), [
    ['REST host', state.client.host.replace('https://', '')],
    ['Used weight (1m)', String(state.client.usedWeight)],
    ['Symbol', state.info ? `${state.info.symbol} (tick ${state.info.tickSize})` : '—'],
    ['Row size', state.info ? `${state.rowTicks} ticks` : '—'],
    ['Bars', String(state.bars.length)],
    ['Trades loaded', state.trades.length.toLocaleString()],
    ['Requests', state.loadStats ? String(state.loadStats.requests) : '—'],
    ['Cache hits', state.loadStats ? `${state.loadStats.cachedHours} h` : '—'],
    ['Loaded at', state.loadedAt ? fmtTime(state.loadedAt, true) : '—'],
  ]);
}

/* ------------------------------------------------------------------ export */

function exportTrades() {
  const trades = state.result?.trades ?? [];
  if (!trades.length) return;
  downloadText(`${settings.symbol}-${settings.interval}-trades.csv`, toCsv(trades, [
    { key: 'id' }, { key: 'side' }, { key: 'type' },
    { label: 'signalTime', get: (t) => new Date(t.signalTime).toISOString() },
    { label: 'entryTime', get: (t) => new Date(t.entryTime).toISOString() },
    { key: 'entryPrice' },
    { label: 'exitTime', get: (t) => new Date(t.exitTime).toISOString() },
    { key: 'exitPrice' }, { key: 'qty' }, { key: 'stopPrice' }, { key: 'targetPrice' },
    { key: 'gross' }, { key: 'fees' }, { key: 'pnl' }, { key: 'r' }, { key: 'bars' },
    { key: 'exitReason' }, { key: 'equityAfter' }, { key: 'segment' },
  ]), 'text/csv');
}

function exportSignals() {
  if (!state.signals.length) return;
  downloadText(`${settings.symbol}-${settings.interval}-signals.csv`, toCsv(state.signals, [
    { label: 'time', get: (s) => new Date(s.time).toISOString() },
    { key: 'barIndex' }, { key: 'side' }, { key: 'type' }, { key: 'score' }, { key: 'price' },
    { key: 'delta' }, { key: 'volume' },
    { label: 'reasons', get: (s) => s.reasons.join(' | ') },
  ]), 'text/csv');
}

function exportBars() {
  if (!state.bars.length) return;
  downloadText(`${settings.symbol}-${settings.interval}-bars.csv`, toCsv(state.bars, [
    { label: 'openTime', get: (b) => new Date(b.openTime).toISOString() },
    { key: 'open' }, { key: 'high' }, { key: 'low' }, { key: 'close' },
    { key: 'volume' }, { key: 'bidVolume' }, { key: 'askVolume' },
    { label: 'delta', get: (b) => b.delta },
    { key: 'cumDelta' }, { key: 'trades' },
    { label: 'poc', get: (b) => b.pocPrice },
    { label: 'val', get: (b) => b.valPrice },
    { label: 'vah', get: (b) => b.vahPrice },
    { label: 'buyStacks', get: (b) => b.buyStacks.length },
    { label: 'sellStacks', get: (b) => b.sellStacks.length },
  ]), 'text/csv');
}

/* -------------------------------------------------------------------- init */

function init() {
  setupTabs(document);

  $('symbol').value = settings.symbol;
  $('interval').value = settings.interval;
  $('range').value = String(settings.rangeHours);

  buildFields($('chart-fields'), footprintSchema, settings.footprint, () => {
    saveSettings();
    rebuildBars();
  });

  buildFields($('display-fields'), displaySchema, settings.display, () => {
    saveSettings();
    applyDisplay();
    refreshChart();
  });

  buildFields($('signal-fields'), signalSchema, settings.signals, () => {
    saveSettings();
    recomputeSignals();
  });

  buildRuleControls($('rule-list'), settings.signals, () => {
    saveSettings();
    recomputeSignals();
  });

  buildFields($('backtest-fields'), backtestSchema, settings.backtest, saveSettings);

  $('load').addEventListener('click', load);
  $('cancel').addEventListener('click', () => state.abort?.abort());
  $('run-backtest').addEventListener('click', runBacktestNow);
  $('symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
  $('interval').addEventListener('change', () => {
    settings.interval = $('interval').value;
    saveSettings();
    if (state.trades.length) rebuildBars();
  });

  $('live').addEventListener('click', () => {
    if (state.stream) stopLive();
    else if (!state.bars.length) {
      setProgress(true, 'Load a range first, then go live.', 0);
      setTimeout(() => setProgress(false), 2000);
    } else startLive();
  });

  $('theme').addEventListener('click', (e) => {
    if (e.shiftKey) {
      settings.palette = settings.palette === 'classic' ? 'cvd' : 'classic';
    } else {
      settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
    }
    saveSettings();
    applyTheme();
  });
  $('theme').title = 'Click: light / dark · Shift-click: colour-blind-safe bid/ask palette';

  $('clear-cache').addEventListener('click', async () => {
    await tradeCache.clear();
    refreshCacheInfo();
  });

  $('reset-settings').addEventListener('click', () => {
    localStorage.removeItem(SETTINGS_KEY);
    location.reload();
  });

  $('export-trades').addEventListener('click', exportTrades);
  $('export-signals').addEventListener('click', exportSignals);
  $('export-bars').addEventListener('click', exportBars);

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === 'f') chart.fit();
    if (e.key === 'l') $('live').click();
    if (e.key === 'r') runBacktestNow();
  });

  applyTheme();
  applyDisplay();
  renderResults();
  refreshSessionInfo();
  refreshCacheInfo();

  // Populate the symbol picker in the background; a failure here is cosmetic.
  state.client.listSymbols().then((symbols) => {
    const list = $('symbol-list');
    clear(list);
    for (const s of symbols.slice(0, 3000)) list.append(el('option', { value: s }));
  }).catch(() => {});

  load();
}

init();
