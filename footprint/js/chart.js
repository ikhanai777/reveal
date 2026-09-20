// Footprint canvas renderer.
//
// Layout, left to right / top to bottom:
//
//   ┌──────────────────────────────── plot ─────────────────────┬ price ┐
//   │  one column per bar; inside a column one row per price     │ axis  │
//   ├───────────────────────────────────────────────────────────┤       │
//   │  Δ / volume / cumulative-Δ footer, one cell per column     │       │
//   ├───────────────────────────────────────────────────────────┴───────┤
//   │  time axis                                                        │
//   └───────────────────────────────────────────────────────────────────┘
//
// Bid volume always sits in the LEFT half of a cell and ask volume in the RIGHT
// half, and both print their number. That positional + numeric encoding is what
// makes the classic green/red pair legible to colour-blind readers; the
// "CVD-safe" palette swaps in a blue/orange pair that separates on hue alone.

import { clamp, fmtVol, fmtSigned, fmtTime } from './util.js';

const PRICE_AXIS_W = 74;
const TIME_AXIS_H = 22;
const FOOTER_ROW_H = 16;
const FOOTER_ROWS = ['delta', 'volume', 'cumDelta'];
const PAD_TOP = 10;

const MIN_COL_W = 4;
const MAX_COL_W = 240;
const MIN_ROW_H = 2;
const MAX_ROW_H = 44;
const TEXT_MIN_ROW_H = 9;
const TEXT_MIN_COL_W = 56;

function hexToRgb(hex) {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const rgba = (rgb, a) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

export const CHART_MODES = [
  { id: 'bidask', label: 'Bid × Ask' },
  { id: 'delta', label: 'Delta' },
  { id: 'profile', label: 'Profile' },
];

export class FootprintChart {
  constructor(canvas, { onHover, onViewChange } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onHover = onHover || (() => {});
    this.onViewChange = onViewChange || (() => {});

    this.bars = [];
    this.signals = [];
    this.trades = [];
    this.tickSize = 0.01;
    this.decimals = 2;
    this.rowSize = 0.01;

    this.colWidth = 92;
    this.rowHeight = 15;
    this.scrollX = 0;            // pixels from the first bar
    this.centerPrice = NaN;
    this.follow = true;

    this.mode = 'bidask';
    this.showImbalance = true;
    this.showValueArea = true;
    this.showSignals = true;
    this.showTrades = true;
    this.scaleBy = 'visible';    // 'visible' | 'bar'

    this.hover = null;
    this.dragging = null;
    this._raf = 0;

    this._bindEvents();
    this.resize();
  }

  // ---------------------------------------------------------------- data

  setData({ bars, signals, trades, tickSize, decimals, rowTicks }) {
    const firstLoad = !this.bars.length;
    if (bars) this.bars = bars;
    if (signals) this.signals = signals;
    if (trades !== undefined) this.trades = trades || [];
    if (tickSize) this.tickSize = tickSize;
    if (decimals !== undefined) this.decimals = decimals;
    if (rowTicks) this.rowSize = this.tickSize * rowTicks;
    if (firstLoad || !Number.isFinite(this.centerPrice)) this.fit();
    if (this.follow) this.scrollToEnd();
    this.requestRender();
  }

  setOptions(opts = {}) {
    Object.assign(this, opts);
    this.requestRender();
  }

  // -------------------------------------------------------------- layout

  resize() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(320, Math.floor(rect.width));
    this.height = Math.max(240, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.requestRender();
  }

  get plotWidth() { return this.width - PRICE_AXIS_W; }
  get footerHeight() { return FOOTER_ROWS.length * FOOTER_ROW_H; }
  get plotTop() { return PAD_TOP; }
  get plotHeight() { return this.height - PAD_TOP - this.footerHeight - TIME_AXIS_H; }
  get plotBottom() { return this.plotTop + this.plotHeight; }

  priceToY(p) {
    return this.plotTop + this.plotHeight / 2 - ((p - this.centerPrice) / this.rowSize) * this.rowHeight;
  }

  yToPrice(y) {
    return this.centerPrice - ((y - this.plotTop - this.plotHeight / 2) / this.rowHeight) * this.rowSize;
  }

  barXLeft(i) { return i * this.colWidth - this.scrollX; }

  barAtX(x) {
    const i = Math.floor((x + this.scrollX) / this.colWidth);
    return i >= 0 && i < this.bars.length ? i : -1;
  }

  visibleRange() {
    const first = Math.max(0, Math.floor(this.scrollX / this.colWidth));
    const last = Math.min(this.bars.length - 1, Math.ceil((this.scrollX + this.plotWidth) / this.colWidth));
    return [first, last];
  }

  scrollToEnd() {
    const total = this.bars.length * this.colWidth;
    this.scrollX = Math.max(0, total - this.plotWidth + this.colWidth * 0.5);
  }

  /** Fit the visible bars' price span into the plot. */
  fit() {
    const [first, last] = this.bars.length ? this.visibleRange() : [0, -1];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = Math.max(0, first); i <= last; i++) {
      const b = this.bars[i];
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      const b = this.bars[this.bars.length - 1];
      if (!b) return;
      lo = b.low; hi = b.high;
    }
    this.centerPrice = (lo + hi) / 2;
    const rows = Math.max(4, Math.ceil((hi - lo) / this.rowSize) + 4);
    this.rowHeight = clamp(this.plotHeight / rows, MIN_ROW_H, MAX_ROW_H);
    this.requestRender();
  }

  // ---------------------------------------------------------- interaction

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      this.dragging = { x: e.offsetX, y: e.offsetY, scrollX: this.scrollX, centerPrice: this.centerPrice, moved: false };
    });

    c.addEventListener('pointermove', (e) => {
      if (this.dragging) {
        const dx = e.offsetX - this.dragging.x;
        const dy = e.offsetY - this.dragging.y;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) this.dragging.moved = true;
        this.scrollX = clamp(this.dragging.scrollX - dx, -this.plotWidth * 0.5, Math.max(0, this.bars.length * this.colWidth - this.plotWidth * 0.5));
        this.centerPrice = this.dragging.centerPrice + (dy / this.rowHeight) * this.rowSize;
        this.follow = false;
        this.onViewChange({ follow: false });
        this.requestRender();
        return;
      }
      this._updateHover(e.offsetX, e.offsetY);
    });

    const endDrag = (e) => {
      if (this.dragging) {
        try { c.releasePointerCapture(e.pointerId); } catch { /* pointer already released */ }
        this.dragging = null;
      }
    };
    c.addEventListener('pointerup', endDrag);
    c.addEventListener('pointercancel', endDrag);

    c.addEventListener('pointerleave', () => {
      this.hover = null;
      this.onHover(null);
      this.requestRender();
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const zoomY = e.ctrlKey || e.metaKey || e.shiftKey;
      if (zoomY) {
        const anchorPrice = this.yToPrice(e.offsetY);
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.rowHeight = clamp(this.rowHeight * factor, MIN_ROW_H, MAX_ROW_H);
        // Keep the price under the cursor pinned.
        const afterY = this.priceToY(anchorPrice);
        this.centerPrice += ((afterY - e.offsetY) / this.rowHeight) * this.rowSize;
      } else if (e.altKey) {
        const anchorIndex = (e.offsetX + this.scrollX) / this.colWidth;
        const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        this.colWidth = clamp(this.colWidth * factor, MIN_COL_W, MAX_COL_W);
        this.scrollX = anchorIndex * this.colWidth - e.offsetX;
      } else {
        this.scrollX = clamp(
          this.scrollX + (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY),
          -this.plotWidth * 0.5,
          Math.max(0, this.bars.length * this.colWidth - this.plotWidth * 0.5),
        );
        this.follow = false;
        this.onViewChange({ follow: false });
      }
      this._updateHover(e.offsetX, e.offsetY);
      this.requestRender();
    }, { passive: false });

    c.addEventListener('dblclick', () => this.fit());
  }

  _updateHover(x, y) {
    const i = this.barAtX(x);
    if (i < 0 || x > this.plotWidth) {
      if (this.hover) { this.hover = null; this.onHover(null); this.requestRender(); }
      return;
    }
    const bar = this.bars[i];
    const price = this.yToPrice(y);
    const rowIndex = Math.floor(Math.round(price / this.tickSize) / (this.rowSize / this.tickSize));
    const row = bar.rows?.get(rowIndex) || null;
    this.hover = { barIndex: i, bar, rowIndex, row, price, x, y };
    this.onHover(this.hover);
    this.requestRender();
  }

  // -------------------------------------------------------------- palette

  readPalette() {
    const s = getComputedStyle(this.canvas);
    const get = (name, fallback) => (s.getPropertyValue(name) || fallback).trim();
    const p = {
      ask: get('--ask', '#12a67c'),
      bid: get('--bid', '#e04b62'),
      ink: get('--chart-ink', '#e8ecf8'),
      inkDim: get('--chart-ink-dim', '#8b93b8'),
      grid: get('--chart-grid', 'rgba(255,255,255,0.06)'),
      surface: get('--chart-surface', '#0a0e18'),
      surfaceAlt: get('--chart-surface-alt', '#0d121e'),
      accent: get('--chart-accent', '#6ea8ff'),
      warn: get('--chart-warn', '#e0a33a'),
      poc: get('--chart-poc', '#c2a6ff'),
    };
    p.askRgb = hexToRgb(p.ask);
    p.bidRgb = hexToRgb(p.bid);
    p.accentRgb = hexToRgb(p.accent);
    p.pocRgb = hexToRgb(p.poc);
    p.warnRgb = hexToRgb(p.warn);
    return p;
  }

  // --------------------------------------------------------------- render

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      this.render();
    });
  }

  render() {
    const { ctx } = this;
    const pal = this.readPalette();
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = pal.surface;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.bars.length || !Number.isFinite(this.centerPrice)) {
      ctx.fillStyle = pal.inkDim;
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No bars loaded yet — pick a symbol and press Load.', this.width / 2, this.height / 2);
      return;
    }

    const [first, last] = this.visibleRange();

    // Scale cell intensity against the heaviest row on screen so columns are
    // comparable to one another, not each normalised to itself.
    let scaleMax = 0;
    if (this.scaleBy === 'visible') {
      for (let i = first; i <= last; i++) scaleMax = Math.max(scaleMax, this.bars[i].maxRowVolume || 0);
    }

    this._drawGrid(pal);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, this.plotTop - PAD_TOP, this.plotWidth, this.plotHeight + PAD_TOP);
    ctx.clip();
    for (let i = first; i <= last; i++) {
      this._drawColumn(this.bars[i], i, pal, scaleMax || this.bars[i].maxRowVolume || 1);
    }
    if (this.showTrades) this._drawTrades(pal, first, last);
    if (this.showSignals) this._drawSignals(pal, first, last);
    ctx.restore();

    this._drawFooter(pal, first, last);
    this._drawPriceAxis(pal);
    this._drawTimeAxis(pal, first, last);
    this._drawCrosshair(pal);
  }

  _drawGrid(pal) {
    const { ctx } = this;
    ctx.strokeStyle = pal.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, this.plotBottom + 0.5);
    ctx.lineTo(this.width, this.plotBottom + 0.5);
    for (let r = 0; r < FOOTER_ROWS.length; r++) {
      const y = this.plotBottom + (r + 1) * FOOTER_ROW_H + 0.5;
      ctx.moveTo(0, y);
      ctx.lineTo(this.width, y);
    }
    ctx.moveTo(this.plotWidth + 0.5, 0);
    ctx.lineTo(this.plotWidth + 0.5, this.height);
    ctx.stroke();
  }

  _drawColumn(bar, index, pal, scaleMax) {
    const { ctx } = this;
    const x = this.barXLeft(index);
    const w = this.colWidth;
    if (x + w < 0 || x > this.plotWidth) return;

    const inner = Math.max(2, w - 2);          // 2px surface gap between columns
    const showText = this.rowHeight >= TEXT_MIN_ROW_H && w >= TEXT_MIN_COL_W && this.mode !== 'profile';
    const rowH = this.rowHeight;

    // Value area band behind the cells.
    if (this.showValueArea && bar.vahPrice !== undefined) {
      const yTop = this.priceToY(bar.vahPrice);
      const yBot = this.priceToY(bar.valPrice);
      ctx.fillStyle = rgba(pal.accentRgb, 0.06);
      ctx.fillRect(x, yTop, inner, Math.max(1, yBot - yTop));
    }

    const centerX = x + inner / 2;

    for (const [rowIndex, row] of bar.rows) {
      const price = (rowIndex + 0.5) * bar.rowSize;
      const yMid = this.priceToY(price);
      const y = yMid - rowH / 2;
      if (y > this.plotBottom || y + rowH < this.plotTop) continue;

      const total = row.bid + row.ask;
      const cellH = Math.max(1, rowH - (rowH > 6 ? 1 : 0));

      if (this.mode === 'profile') {
        const frac = clamp(total / scaleMax, 0, 1);
        const barW = frac * inner;
        const delta = row.ask - row.bid;
        ctx.fillStyle = rgba(delta >= 0 ? pal.askRgb : pal.bidRgb, 0.55);
        ctx.fillRect(x, y, barW, cellH);
      } else if (this.mode === 'delta') {
        const delta = row.ask - row.bid;
        const frac = clamp(Math.abs(delta) / scaleMax, 0, 1);
        ctx.fillStyle = rgba(delta >= 0 ? pal.askRgb : pal.bidRgb, 0.12 + 0.6 * frac);
        ctx.fillRect(x, y, inner, cellH);
        if (showText) {
          ctx.fillStyle = pal.ink;
          ctx.font = `${Math.min(12, rowH - 2)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(fmtSigned(delta), centerX, yMid);
        }
      } else {
        const half = inner / 2;
        const bidFrac = clamp(row.bid / scaleMax, 0, 1);
        const askFrac = clamp(row.ask / scaleMax, 0, 1);
        ctx.fillStyle = rgba(pal.bidRgb, 0.10 + 0.62 * bidFrac);
        ctx.fillRect(x, y, half - 1, cellH);
        ctx.fillStyle = rgba(pal.askRgb, 0.10 + 0.62 * askFrac);
        ctx.fillRect(x + half + 1, y, half - 1, cellH);

        if (showText) {
          ctx.font = `${Math.min(12, rowH - 2)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
          ctx.textBaseline = 'middle';
          ctx.fillStyle = pal.ink;
          ctx.textAlign = 'right';
          ctx.fillText(fmtVol(row.bid), x + half - 5, yMid);
          ctx.textAlign = 'left';
          ctx.fillText(fmtVol(row.ask), x + half + 6, yMid);
        }
      }

      // Imbalance rails: a 3px bar on the side that is imbalanced.
      if (this.showImbalance && bar.imbalances) {
        const im = bar.imbalances.get(rowIndex);
        if (im?.buy) {
          ctx.fillStyle = rgba(pal.askRgb, 0.95);
          ctx.fillRect(x + inner - 3, y, 3, cellH);
        }
        if (im?.sell) {
          ctx.fillStyle = rgba(pal.bidRgb, 0.95);
          ctx.fillRect(x, y, 3, cellH);
        }
      }

      // POC marker.
      if (rowIndex === bar.pocRow) {
        ctx.strokeStyle = rgba(pal.pocRgb, 0.85);
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, inner - 1, cellH - 1);
      }
    }

    // Stacked-imbalance brackets outside the column.
    if (this.showImbalance && bar.stacks?.length) {
      for (const s of bar.stacks) {
        const yTop = this.priceToY(s.toPrice);
        const yBot = this.priceToY(s.fromPrice);
        ctx.strokeStyle = s.side === 'buy' ? pal.ask : pal.bid;
        ctx.lineWidth = 2;
        const sx = s.side === 'buy' ? x + inner - 1 : x + 1;
        ctx.beginPath();
        ctx.moveTo(sx, yTop);
        ctx.lineTo(sx, yBot);
        ctx.stroke();
      }
    }

    // Slim candle so the OHLC shape stays readable at any column width.
    const yHigh = this.priceToY(bar.high);
    const yLow = this.priceToY(bar.low);
    const yOpen = this.priceToY(bar.open);
    const yClose = this.priceToY(bar.close);
    const up = bar.close >= bar.open;
    ctx.strokeStyle = rgba(up ? pal.askRgb : pal.bidRgb, 0.9);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + inner + 1.5, yHigh);
    ctx.lineTo(x + inner + 1.5, yLow);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x + inner + 1.5, yOpen);
    ctx.lineTo(x + inner + 1.5, yClose);
    ctx.stroke();

    // Hovered column gets a surface ring rather than a colour change.
    if (this.hover?.barIndex === index) {
      ctx.strokeStyle = rgba(pal.accentRgb, 0.5);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, this.plotTop + 0.5, inner - 1, this.plotHeight - 1);
    }
  }

  _drawFooter(pal, first, last) {
    const { ctx } = this;
    const top = this.plotBottom;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, this.plotWidth, this.footerHeight);
    ctx.clip();

    let maxAbsDelta = 1;
    let maxVol = 1;
    for (let i = first; i <= last; i++) {
      maxAbsDelta = Math.max(maxAbsDelta, Math.abs(this.bars[i].delta));
      maxVol = Math.max(maxVol, this.bars[i].volume);
    }

    for (let i = first; i <= last; i++) {
      const bar = this.bars[i];
      const x = this.barXLeft(i);
      const inner = Math.max(2, this.colWidth - 2);
      if (x + inner < 0 || x > this.plotWidth) continue;

      // Row 1 — delta, tinted by magnitude.
      const dRgb = bar.delta >= 0 ? pal.askRgb : pal.bidRgb;
      ctx.fillStyle = rgba(dRgb, 0.10 + 0.5 * clamp(Math.abs(bar.delta) / maxAbsDelta, 0, 1));
      ctx.fillRect(x, top + 1, inner, FOOTER_ROW_H - 2);
      // Row 2 — volume, single-hue magnitude ramp.
      ctx.fillStyle = rgba(pal.accentRgb, 0.08 + 0.35 * clamp(bar.volume / maxVol, 0, 1));
      ctx.fillRect(x, top + FOOTER_ROW_H + 1, inner, FOOTER_ROW_H - 2);

      if (this.colWidth >= 44) {
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = pal.ink;
        ctx.fillText(fmtSigned(bar.delta), x + inner / 2, top + FOOTER_ROW_H / 2);
        ctx.fillText(fmtVol(bar.volume), x + inner / 2, top + FOOTER_ROW_H * 1.5);
        ctx.fillStyle = bar.cumDelta >= 0 ? pal.ask : pal.bid;
        ctx.fillText(fmtSigned(bar.cumDelta), x + inner / 2, top + FOOTER_ROW_H * 2.5);
      }
    }
    ctx.restore();

    ctx.fillStyle = pal.inkDim;
    ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Δ', this.plotWidth + 6, top + FOOTER_ROW_H / 2);
    ctx.fillText('VOL', this.plotWidth + 6, top + FOOTER_ROW_H * 1.5);
    ctx.fillText('ΣΔ', this.plotWidth + 6, top + FOOTER_ROW_H * 2.5);
  }

  _drawPriceAxis(pal) {
    const { ctx } = this;
    ctx.fillStyle = pal.surfaceAlt;
    ctx.fillRect(this.plotWidth + 1, 0, PRICE_AXIS_W, this.height);

    // Choose a label step that keeps ~44px between labels.
    const pxPerPrice = this.rowHeight / this.rowSize;
    const rawStep = 44 / pxPerPrice;
    const mag = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || mag * 10;

    const topPrice = this.yToPrice(this.plotTop);
    const botPrice = this.yToPrice(this.plotBottom);
    const start = Math.ceil(botPrice / step) * step;

    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    for (let p = start; p <= topPrice; p += step) {
      const y = this.priceToY(p);
      if (y < this.plotTop || y > this.plotBottom) continue;
      ctx.strokeStyle = pal.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(this.plotWidth, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = pal.inkDim;
      ctx.fillText(p.toFixed(this.decimals), this.plotWidth + 6, y);
    }

    // Last price tag.
    const lastBar = this.bars[this.bars.length - 1];
    if (lastBar) {
      const y = this.priceToY(lastBar.close);
      if (y >= this.plotTop && y <= this.plotBottom) {
        const up = lastBar.close >= lastBar.open;
        ctx.fillStyle = up ? pal.ask : pal.bid;
        ctx.fillRect(this.plotWidth + 1, y - 8, PRICE_AXIS_W, 16);
        ctx.fillStyle = '#04070e';
        ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
        ctx.fillText(lastBar.close.toFixed(this.decimals), this.plotWidth + 6, y);
      }
    }
  }

  _drawTimeAxis(pal, first, last) {
    const { ctx } = this;
    const y = this.plotBottom + this.footerHeight;
    ctx.fillStyle = pal.surfaceAlt;
    ctx.fillRect(0, y, this.plotWidth, TIME_AXIS_H);
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = pal.inkDim;

    const every = Math.max(1, Math.ceil(70 / this.colWidth));
    for (let i = first; i <= last; i++) {
      if (i % every !== 0) continue;
      const x = this.barXLeft(i) + this.colWidth / 2;
      if (x < 20 || x > this.plotWidth - 4) continue;
      ctx.fillText(fmtTime(this.bars[i].openTime), x, y + TIME_AXIS_H / 2);
    }
  }

  _drawSignals(pal, first, last) {
    const { ctx } = this;
    for (const s of this.signals) {
      if (s.barIndex < first - 1 || s.barIndex > last + 1) continue;
      const bar = this.bars[s.barIndex];
      if (!bar) continue;
      const x = this.barXLeft(s.barIndex) + (this.colWidth - 2) / 2;
      const long = s.side === 'long';
      const y = long ? this.priceToY(bar.low) + 12 : this.priceToY(bar.high) - 12;
      const rgb = long ? pal.askRgb : pal.bidRgb;
      const size = 6;
      ctx.beginPath();
      if (long) {
        ctx.moveTo(x, y - size);
        ctx.lineTo(x - size, y + size);
        ctx.lineTo(x + size, y + size);
      } else {
        ctx.moveTo(x, y + size);
        ctx.lineTo(x - size, y - size);
        ctx.lineTo(x + size, y - size);
      }
      ctx.closePath();
      ctx.fillStyle = rgba(rgb, 0.9);
      ctx.fill();
      // 2px surface ring so overlapping markers stay separable.
      ctx.strokeStyle = pal.surface;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  _drawTrades(pal, first, last) {
    const { ctx } = this;
    for (const t of this.trades) {
      if (t.exitBar < first - 2 || t.entryBar > last + 2) continue;
      const x1 = this.barXLeft(t.entryBar) + (this.colWidth - 2) / 2;
      const x2 = this.barXLeft(t.exitBar) + (this.colWidth - 2) / 2;
      const y1 = this.priceToY(t.entryPrice);
      const y2 = this.priceToY(t.exitPrice);
      const winner = t.pnl >= 0;

      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = rgba(winner ? pal.askRgb : pal.bidRgb, 0.75);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.setLineDash([]);

      for (const [x, y, filled] of [[x1, y1, true], [x2, y2, false]]) {
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = filled ? rgba(winner ? pal.askRgb : pal.bidRgb, 0.95) : pal.surface;
        ctx.fill();
        ctx.strokeStyle = rgba(winner ? pal.askRgb : pal.bidRgb, 0.95);
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }

  _drawCrosshair(pal) {
    if (!this.hover) return;
    const { ctx } = this;
    const { x, y } = this.hover;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = rgba(pal.accentRgb, 0.55);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(this.plotWidth, Math.round(y) + 0.5);
    ctx.moveTo(Math.round(x) + 0.5, this.plotTop);
    ctx.lineTo(Math.round(x) + 0.5, this.plotBottom + this.footerHeight);
    ctx.stroke();
    ctx.restore();

    const price = this.yToPrice(y);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(this.plotWidth + 1, y - 8, PRICE_AXIS_W, 16);
    ctx.fillStyle = '#04070e';
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(price.toFixed(this.decimals), this.plotWidth + 6, y);
  }
}
