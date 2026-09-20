// Small multi-series line chart used for the equity curve and drawdown.
// Canvas, crosshair + tooltip, one shared y-axis (never a second scale).

import { fmtTime } from './util.js';

export class LineChart {
  constructor(canvas, { onHover, formatValue } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = [];         // [{ key, label, color, points: [{x(time), y}], dashed }]
    this.markers = [];        // [{ x(time), label, color }]
    this.onHover = onHover || (() => {});
    this.format = formatValue || ((v) => v.toFixed(2));
    this.hover = null;
    this.pad = { top: 12, right: 68, bottom: 22, left: 12 };

    canvas.addEventListener('pointermove', (e) => this._hover(e.offsetX, e.offsetY));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.onHover(null); this.render(); });
    this.resize();
  }

  setSeries(series, markers = []) {
    this.series = series.filter((s) => s.points.length);
    this.markers = markers;
    this.render();
  }

  resize() {
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    const rect = this.canvas.getBoundingClientRect();
    this.width = Math.max(200, Math.floor(rect.width));
    this.height = Math.max(120, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.width * dpr);
    this.canvas.height = Math.floor(this.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  _bounds() {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const s of this.series) {
      for (const p of s.points) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (minY === maxY) { minY -= 1; maxY += 1; }
    const padY = (maxY - minY) * 0.08;
    return { minX, maxX, minY: minY - padY, maxY: maxY + padY };
  }

  _scales() {
    const b = this._bounds();
    const w = this.width - this.pad.left - this.pad.right;
    const h = this.height - this.pad.top - this.pad.bottom;
    return {
      ...b,
      x: (v) => this.pad.left + ((v - b.minX) / Math.max(1, b.maxX - b.minX)) * w,
      y: (v) => this.pad.top + h - ((v - b.minY) / Math.max(1e-9, b.maxY - b.minY)) * h,
      w,
      h,
    };
  }

  _hover(px) {
    if (!this.series.length) return;
    const sc = this._scales();
    const t = sc.minX + ((px - this.pad.left) / Math.max(1, sc.w)) * (sc.maxX - sc.minX);
    const readings = this.series.map((s) => {
      let best = s.points[0];
      let bestD = Infinity;
      for (const p of s.points) {
        const d = Math.abs(p.x - t);
        if (d < bestD) { bestD = d; best = p; }
      }
      return { key: s.key, label: s.label, color: s.color, point: best };
    });
    this.hover = { time: readings[0]?.point.x ?? t, readings, px };
    this.onHover(this.hover);
    this.render();
  }

  render() {
    const { ctx } = this;
    const style = getComputedStyle(this.canvas);
    const ink = (style.getPropertyValue('--chart-ink-dim') || '#8b93b8').trim();
    const grid = (style.getPropertyValue('--chart-grid') || 'rgba(255,255,255,0.06)').trim();
    const surface = (style.getPropertyValue('--chart-surface') || '#0a0e18').trim();

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, this.width, this.height);

    if (!this.series.length) {
      ctx.fillStyle = ink;
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Run a backtest to see the equity curve.', this.width / 2, this.height / 2);
      return;
    }

    const sc = this._scales();

    // Horizontal gridlines + right-hand value labels.
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'middle';
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = sc.minY + ((sc.maxY - sc.minY) * i) / ticks;
      const y = Math.round(sc.y(v)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.pad.left, y);
      ctx.lineTo(this.width - this.pad.right, y);
      ctx.stroke();
      ctx.fillStyle = ink;
      ctx.textAlign = 'left';
      ctx.fillText(this.format(v), this.width - this.pad.right + 6, y);
    }

    // Time labels.
    ctx.textAlign = 'center';
    ctx.fillStyle = ink;
    for (let i = 0; i <= 4; i++) {
      const t = sc.minX + ((sc.maxX - sc.minX) * i) / 4;
      const x = sc.x(t);
      ctx.fillText(fmtTime(t, true).slice(5), Math.min(this.width - this.pad.right - 24, Math.max(30, x)), this.height - 10);
    }

    for (const m of this.markers) {
      const x = sc.x(m.x);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = m.color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, this.pad.top);
      ctx.lineTo(x, this.height - this.pad.bottom);
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = m.color;
      ctx.textAlign = 'left';
      ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(m.label, x + 4, this.pad.top + 6);
    }

    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      if (s.dashed) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = sc.x(p.x);
        const y = sc.y(p.y);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Direct end labels — identity is never colour-alone. Series that finish at
    // nearly the same value would otherwise stack their labels on top of each
    // other, so they are pushed apart after the fact.
    const labels = this.series
      .map((s) => ({ label: s.label, color: s.color, y: sc.y(s.points[s.points.length - 1].y) - 8 }))
      .sort((a, b) => a.y - b.y);
    const gap = 13;
    for (let i = 1; i < labels.length; i++) {
      if (labels[i].y - labels[i - 1].y < gap) labels[i].y = labels[i - 1].y + gap;
    }
    const overflow = labels.length ? labels[labels.length - 1].y - (this.height - this.pad.bottom - 2) : 0;
    if (overflow > 0) for (const l of labels) l.y -= overflow;

    ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'right';
    for (const l of labels) {
      ctx.fillStyle = l.color;
      ctx.fillText(l.label, this.width - this.pad.right - 6, Math.max(this.pad.top + 8, l.y));
    }

    if (this.hover) {
      const x = sc.x(this.hover.time);
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, this.pad.top);
      ctx.lineTo(x, this.height - this.pad.bottom);
      ctx.stroke();
      ctx.restore();
      for (const r of this.hover.readings) {
        ctx.beginPath();
        ctx.arc(sc.x(r.point.x), sc.y(r.point.y), 4, 0, Math.PI * 2);
        ctx.fillStyle = r.color;
        ctx.fill();
        ctx.strokeStyle = surface;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
  }
}
