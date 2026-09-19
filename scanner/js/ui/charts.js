// Canvas chart renderers.
//
// Colour is taken entirely from CSS custom properties, so the light and dark
// palettes are each selected rather than one being an automatic flip of the
// other, and the directional-palette toggle needs no code path of its own.
//
// Encoding rules followed throughout:
//   direction / polarity  -> the diverging pair (--long / --short) + neutral mid
//   magnitude             -> one hue, light to dark (the accent ramp)
//   grid and axes         -> solid hairlines one shade off the surface
// Every chart carries a hover layer; multi-series charts carry a legend.

import { fitCanvas, token, fmt } from './dom.js';
import { niceStep } from '../core/num.js';

const PAD = { l: 8, r: 56, t: 10, b: 22 };

function theme() {
  return {
    long: token('--long', '#3987e5'),
    short: token('--short', '#e66767'),
    text: token('--text', '#e9edff'),
    muted: token('--muted', '#8b93b8'),
    muted2: token('--muted-2', '#626b91'),
    grid: token('--grid', 'rgba(120,150,230,0.1)'),
    accent: token('--accent', '#6ea8ff'),
    warn: token('--warn', '#fab219'),
    panel: token('--panel-2', 'rgba(24,32,56,0.5)'),
  };
}

function withAlpha(color, alpha) {
  // Tokens are hex or rgba(); both need a uniform way to get a wash.
  if (color.startsWith('#')) {
    const h = color.slice(1);
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    const n = parseInt(full, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }
  return color.replace(/rgba?\(([^)]+)\)/, (_, inner) => {
    const parts = inner.split(',').map((s) => s.trim());
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
  });
}

function axisText(ctx, t) {
  ctx.font = '10px Inter, system-ui, sans-serif';
  ctx.fillStyle = t.muted2;
}

/** Horizontal hairline grid plus right-hand price scale. */
function priceGrid(ctx, { width, height, min, max, y, t, lines = 5, format = fmt.price }) {
  ctx.lineWidth = 1;
  ctx.strokeStyle = t.grid;
  axisText(ctx, t);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= lines; i++) {
    const v = min + ((max - min) * i) / lines;
    const py = Math.round(y(v)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, py);
    ctx.lineTo(width - PAD.r, py);
    ctx.stroke();
    ctx.fillText(format(v), width - PAD.r + 6, py);
  }
}

// --- Shared hover layer ------------------------------------------------------

/**
 * Attach a crosshair/tooltip to a canvas.
 * `resolve(x, y, rect)` returns HTML for the tip, or null to hide it.
 */
export function attachTooltip(canvas, resolve) {
  const host = canvas.parentElement;
  if (!host) return () => {};
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  let tip = host.querySelector(':scope > .viz-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'viz-tip';
    tip.setAttribute('role', 'status');
    host.append(tip);
  }
  const move = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const html = resolve(x, y, rect);
    if (!html) { tip.dataset.show = 'false'; return; }
    tip.innerHTML = html;
    tip.dataset.show = 'true';
    // Flip the tip before it runs off the right edge.
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(rect.width - w - 4, x + 14))}px`;
    tip.style.top = `${Math.max(4, y - tip.offsetHeight - 10)}px`;
  };
  const leave = () => { tip.dataset.show = 'false'; };
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerleave', leave);
  return () => {
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerleave', leave);
  };
}

// --- Price + volume profile --------------------------------------------------

/**
 * Candlesticks with the VPVR histogram along the right edge.
 * The profile shares the price axis with the candles — it is the same scale,
 * drawn sideways, not a second y-axis.
 */
export function drawPriceChart(canvas, { candles, profile, signals = [], height = 300 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!candles?.length) return emptyState(ctx, width, h, t, 'waiting for candles');

  const view = candles.slice(-140);
  const profileWidth = profile?.rows?.length ? Math.min(110, width * 0.22) : 0;
  const plotRight = width - PAD.r - profileWidth;
  const plotW = plotRight - PAD.l;

  let min = Math.min(...view.map((c) => c.l));
  let max = Math.max(...view.map((c) => c.h));
  // The profile is built over a longer window than the candles on screen, so
  // its value area can sit far outside them. Let it stretch the axis only
  // modestly — otherwise one wide profile squashes the candles to a flat line.
  if (profile && Number.isFinite(profile.vah)) {
    const slack = (max - min) * 0.35;
    min = Math.max(min - slack, Math.min(min, profile.val));
    max = Math.min(max + slack, Math.max(max, profile.vah));
  }
  const pad = (max - min) * 0.06 || 1;
  min -= pad; max += pad;
  const y = (v) => PAD.t + ((max - v) / (max - min)) * (h - PAD.t - PAD.b);
  const step = plotW / view.length;

  priceGrid(ctx, { width, height: h, min, max, y, t });

  // Volume profile: one hue, opacity carrying magnitude.
  if (profileWidth) {
    const maxVol = Math.max(...profile.rows.map((r) => r.volume)) || 1;
    for (const row of profile.rows) {
      const py = y(row.price);
      const rowH = Math.max(1.5, ((h - PAD.t - PAD.b) / profile.rows.length) - 1);
      const w = (row.volume / maxVol) * (profileWidth - 8);
      ctx.fillStyle = withAlpha(t.accent, row.inValueArea ? 0.42 : 0.16);
      ctx.fillRect(plotRight + 4, py - rowH / 2, w, rowH);
    }
    for (const [value, color, label] of [
      [profile.poc, t.warn, 'POC'],
      [profile.vah, t.muted, 'VAH'],
      [profile.val, t.muted, 'VAL'],
    ]) {
      if (!Number.isFinite(value)) continue;
      const py = Math.round(y(value)) + 0.5;
      ctx.strokeStyle = color;
      ctx.lineWidth = label === 'POC' ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(PAD.l, py);
      ctx.lineTo(width - PAD.r, py);
      ctx.stroke();
      axisText(ctx, t);
      ctx.fillStyle = color;
      ctx.textAlign = 'left';
      ctx.fillText(label, PAD.l + 3, py - 5);
    }
  }

  // Candles: 2px wicks, thin bodies, 1px gap between neighbours.
  const bodyW = Math.max(1.5, step * 0.62);
  for (let i = 0; i < view.length; i++) {
    const c = view[i];
    const cx = PAD.l + i * step + step / 2;
    const up = c.c >= c.o;
    ctx.strokeStyle = up ? t.long : t.short;
    ctx.fillStyle = up ? t.long : t.short;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(cx) + 0.5, y(c.h));
    ctx.lineTo(Math.round(cx) + 0.5, y(c.l));
    ctx.stroke();
    const top = y(Math.max(c.o, c.c));
    const bot = y(Math.min(c.o, c.c));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bot - top));
  }

  // Signal markers: a triangle at the entry, labelled with its direction so the
  // marker never relies on colour alone.
  for (const s of signals) {
    const idx = view.findIndex((c) => c.t >= s.ts);
    if (idx < 0) continue;
    const cx = PAD.l + idx * step + step / 2;
    const py = y(s.entry?.mid ?? s.price ?? view[idx].c);
    const dir = s.direction > 0 ? 1 : -1;
    ctx.fillStyle = dir > 0 ? t.long : t.short;
    ctx.beginPath();
    ctx.moveTo(cx, py + dir * -9);
    ctx.lineTo(cx - 5, py + dir * -17);
    ctx.lineTo(cx + 5, py + dir * -17);
    ctx.closePath();
    ctx.fill();
  }

  attachTooltip(canvas, (mx) => {
    const i = Math.floor((mx - PAD.l) / step);
    if (i < 0 || i >= view.length) return null;
    const c = view[i];
    const delta = (c.buyVol ?? 0) - (c.sellVol ?? 0);
    return `<b>${fmt.time(c.t)}</b><br>
      <span class="k">O</span> ${fmt.price(c.o)} <span class="k">H</span> ${fmt.price(c.h)}<br>
      <span class="k">L</span> ${fmt.price(c.l)} <span class="k">C</span> ${fmt.price(c.c)}<br>
      <span class="k">vol</span> ${fmt.compact(c.v)} · <span class="k">delta</span> ${delta >= 0 ? '+' : ''}${fmt.compact(delta)}`;
  });
}

// --- Footprint ladder --------------------------------------------------------

/**
 * Footprint columns: one column per candle, one row per price level, showing
 * bid x ask. Cell fill is the sequential accent ramp (magnitude); an imbalanced
 * cell is outlined in the direction colour and marked with an arrow glyph, so
 * imbalance is never carried by colour alone.
 */
export function drawFootprint(canvas, { footprints, height = 320, columns = 8 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  const view = (footprints || []).slice(-columns).filter((fp) => fp.levels?.size);
  if (!view.length) return emptyState(ctx, width, h, t, 'waiting for trades');

  let min = Infinity, max = -Infinity;
  for (const fp of view) {
    for (const price of fp.levels.keys()) { min = Math.min(min, price); max = Math.max(max, price); }
  }
  // The visible columns can span far more price than the aggregator's ladder
  // step, which would give hundreds of one-pixel rows. Re-bucket for display so
  // the ladder always lands near MAX_ROWS readable rows.
  const MAX_ROWS = 24;
  const rawTick = view[0].tickSize || 1;
  const tick = Math.max(rawTick, niceStep((max - min) / MAX_ROWS) || rawTick);
  min = Math.floor(min / tick) * tick;
  max = Math.ceil(max / tick) * tick;

  const rows = Math.max(1, Math.round((max - min) / tick) + 1);
  const rowH = Math.min(22, (h - PAD.t - PAD.b) / rows);
  const usableH = rowH * rows;
  const colW = (width - PAD.l - PAD.r) / view.length;
  const y = (price) => PAD.t + ((max - price) / tick) * rowH;
  const bucketOf = (price) => Math.round(price / tick) * tick;

  // Collapse each column's levels onto the display ladder once, up front.
  const cols = view.map((fp) => {
    const merged = new Map();
    for (const [price, lvl] of fp.levels) {
      const key = bucketOf(price);
      const cell = merged.get(key) || { bid: 0, ask: 0 };
      cell.bid += lvl.bid;
      cell.ask += lvl.ask;
      merged.set(key, cell);
    }
    const imbalances = new Map();
    for (const im of fp.imbalances({ ratio: 3 })) {
      const key = bucketOf(im.price);
      // Keep the strongest imbalance that landed in this display row.
      const prev = imbalances.get(key);
      if (!prev || im.ratio > prev.ratio) imbalances.set(key, im);
    }
    return { fp, merged, imbalances };
  });

  let maxCell = 0;
  for (const col of cols) for (const c of col.merged.values()) maxCell = Math.max(maxCell, c.bid + c.ask);
  maxCell = maxCell || 1;

  ctx.font = `${Math.min(10, rowH - 4)}px ui-monospace, Menlo, monospace`;
  ctx.textBaseline = 'middle';

  for (let ci = 0; ci < cols.length; ci++) {
    const { fp, merged, imbalances } = cols[ci];
    const x0 = PAD.l + ci * colW;

    for (const [price, lvl] of merged) {
      const py = y(price);
      if (py < PAD.t - rowH || py > PAD.t + usableH) continue;
      const total = lvl.bid + lvl.ask;
      // Magnitude: one hue, deepening with traded volume at the level.
      ctx.fillStyle = withAlpha(t.accent, 0.06 + 0.5 * (total / maxCell));
      ctx.fillRect(x0 + 1, py, colW - 3, rowH - 2);

      const im = imbalances.get(price);
      if (im) {
        ctx.strokeStyle = im.dir > 0 ? t.long : t.short;
        ctx.lineWidth = 1.5;
        ctx.strokeRect(x0 + 1.5, py + 0.5, colW - 4, rowH - 3);
      }
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'center';
      if (rowH >= 11) {
        // Only draw the label when it fits inside the cell with padding;
        // a clipped "131.78 × 275." is worse than the tooltip alone.
        const label = `${fmt.compact(lvl.bid)} × ${fmt.compact(lvl.ask)}${im ? (im.dir > 0 ? ' ▲' : ' ▼') : ''}`;
        if (ctx.measureText(label).width <= colW - 10) {
          ctx.fillText(label, x0 + colW / 2, py + rowH / 2);
        }
      }
    }

    // Per-column delta footer, signed and labelled.
    const delta = fp.delta;
    ctx.fillStyle = delta >= 0 ? t.long : t.short;
    ctx.textAlign = 'center';
    ctx.font = '10px Inter, system-ui, sans-serif';
    ctx.fillText(`${delta >= 0 ? '+' : ''}${fmt.compact(delta)}`, x0 + colW / 2, h - 9);
    ctx.font = `${Math.min(10, rowH - 4)}px ui-monospace, Menlo, monospace`;
  }

  // Price scale on the right.
  axisText(ctx, t);
  ctx.textAlign = 'left';
  const labelEvery = Math.max(1, Math.round(rows / 8));
  for (let r = 0; r < rows; r += labelEvery) {
    const price = max - r * tick;
    ctx.fillText(fmt.price(price), width - PAD.r + 6, y(price) + rowH / 2);
  }

  attachTooltip(canvas, (mx, my) => {
    const ci = Math.floor((mx - PAD.l) / colW);
    if (ci < 0 || ci >= cols.length) return null;
    const { fp, merged } = cols[ci];
    const price = max - Math.round((my - PAD.t) / rowH) * tick;
    const lvl = merged.get(price);
    const head = `<b>${fmt.time(fp.t)}</b> · delta ${fp.delta >= 0 ? '+' : ''}${fmt.compact(fp.delta)}`;
    if (!lvl) return head;
    return `${head}<br><span class="k">@</span> ${fmt.price(price)}<br>
      <span class="k">bid</span> ${fmt.compact(lvl.bid)} · <span class="k">ask</span> ${fmt.compact(lvl.ask)}`;
  });
}

// --- Depth -------------------------------------------------------------------

/** Cumulative book depth, bids left of mid and asks right. */
export function drawDepth(canvas, { book, walls = [], height = 190 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!book?.bids?.length || !book?.asks?.length) return emptyState(ctx, width, h, t, 'waiting for order book');

  const bids = book.bids.slice(0, 40);
  const asks = book.asks.slice(0, 40);
  const mid = (bids[0][0] + asks[0][0]) / 2;
  const loP = bids[bids.length - 1][0];
  const hiP = asks[asks.length - 1][0];
  const cum = (levels) => {
    let acc = 0;
    return levels.map(([p, s]) => { acc += s; return [p, acc]; });
  };
  const cb = cum(bids), ca = cum(asks);
  const maxCum = Math.max(cb[cb.length - 1][1], ca[ca.length - 1][1]) || 1;

  const x = (p) => PAD.l + ((p - loP) / (hiP - loP)) * (width - PAD.l - PAD.r);
  const y = (v) => h - PAD.b - (v / maxCum) * (h - PAD.t - PAD.b);

  ctx.strokeStyle = t.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.l, h - PAD.b + 0.5);
  ctx.lineTo(width - PAD.r, h - PAD.b + 0.5);
  ctx.stroke();

  const side = (data, color) => {
    ctx.beginPath();
    ctx.moveTo(x(data[0][0]), h - PAD.b);
    for (const [p, v] of data) ctx.lineTo(x(p), y(v));
    ctx.lineTo(x(data[data.length - 1][0]), h - PAD.b);
    ctx.closePath();
    ctx.fillStyle = withAlpha(color, 0.2);
    ctx.fill();
    ctx.beginPath();
    data.forEach(([p, v], i) => (i ? ctx.lineTo(x(p), y(v)) : ctx.moveTo(x(p), y(v))));
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
  };
  side(cb, t.long);
  side(ca, t.short);

  // Mid marker.
  ctx.strokeStyle = t.muted2;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(Math.round(x(mid)) + 0.5, PAD.t);
  ctx.lineTo(Math.round(x(mid)) + 0.5, h - PAD.b);
  ctx.stroke();

  // Walls get a tick each; only the largest is labelled, because four labels a
  // few pixels apart overprint into an unreadable smear.
  const shown = walls.slice(0, 4);
  for (const w of shown) {
    const wx = x(w.price);
    if (!Number.isFinite(wx)) continue;
    ctx.fillStyle = t.warn;
    ctx.fillRect(wx - 1, PAD.t, 2, h - PAD.t - PAD.b);
  }
  const biggest = shown[0];
  if (biggest && Number.isFinite(x(biggest.price))) {
    axisText(ctx, t);
    ctx.fillStyle = t.warn;
    ctx.textAlign = 'center';
    const label = shown.length > 1 ? `${shown.length} walls` : 'wall';
    ctx.fillText(label, Math.min(width - PAD.r - 18, Math.max(PAD.l + 18, x(biggest.price))), PAD.t + 8);
  }

  axisText(ctx, t);
  ctx.textAlign = 'center';
  ctx.fillStyle = t.muted2;
  ctx.fillText(fmt.price(loP), PAD.l + 18, h - 6);
  ctx.fillText(fmt.price(mid), x(mid), h - 6);
  ctx.fillText(fmt.price(hiP), width - PAD.r - 18, h - 6);

  attachTooltip(canvas, (mx) => {
    const price = loP + ((mx - PAD.l) / (width - PAD.l - PAD.r)) * (hiP - loP);
    if (!(price >= loP && price <= hiP)) return null;
    const src = price <= mid ? cb : ca;
    let best = src[0];
    for (const row of src) if (Math.abs(row[0] - price) < Math.abs(best[0] - price)) best = row;
    return `<b>${price <= mid ? 'Bids' : 'Asks'}</b><br>
      <span class="k">price</span> ${fmt.price(best[0])}<br>
      <span class="k">cumulative</span> ${fmt.compact(best[1])}`;
  });
}

// --- Equity and drawdown -----------------------------------------------------

/** Equity curve. Single series, so the title carries identity and no legend is needed. */
export function drawEquity(canvas, { curve, height = 220 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!curve?.length) return emptyState(ctx, width, h, t, 'run a backtest to see the curve');

  const values = curve.map((p) => p.value);
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const y = (v) => PAD.t + ((max - v) / span) * (h - PAD.t - PAD.b);
  const x = (i) => PAD.l + (i / Math.max(1, curve.length - 1)) * (width - PAD.l - PAD.r);

  priceGrid(ctx, { width, height: h, min, max, y, t, lines: 4, format: (v) => fmt.compact(v) });

  const start = curve[0].value;
  const end = curve[curve.length - 1].value;
  const color = end >= start ? t.long : t.short;

  ctx.beginPath();
  ctx.moveTo(x(0), h - PAD.b);
  curve.forEach((p, i) => ctx.lineTo(x(i), y(p.value)));
  ctx.lineTo(x(curve.length - 1), h - PAD.b);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.14);
  ctx.fill();

  ctx.beginPath();
  curve.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p.value)) : ctx.moveTo(x(i), y(p.value))));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Direct-label the endpoint only.
  ctx.fillStyle = color;
  ctx.font = '11px Inter, system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(fmt.compact(end), width - PAD.r - 4, y(end) - 6);

  attachTooltip(canvas, (mx) => {
    const i = Math.round(((mx - PAD.l) / (width - PAD.l - PAD.r)) * (curve.length - 1));
    if (i < 0 || i >= curve.length) return null;
    const p = curve[i];
    return `<b>${fmt.date(p.ts)} ${fmt.time(p.ts)}</b><br>
      <span class="k">equity</span> ${fmt.compact(p.value)}<br>
      <span class="k">return</span> ${fmt.signedPct(p.value / start - 1)}`;
  });
}

/** Underwater plot. Always negative, so it reads as one-sided by construction. */
export function drawDrawdown(canvas, { series, height = 110 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!series?.length) return emptyState(ctx, width, h, t, '');

  const worst = Math.min(...series.map((s) => s.dd), -0.0001);
  const x = (i) => PAD.l + (i / Math.max(1, series.length - 1)) * (width - PAD.l - PAD.r);
  const y = (v) => PAD.t + (v / worst) * (h - PAD.t - PAD.b);

  ctx.strokeStyle = t.grid;
  ctx.beginPath();
  ctx.moveTo(PAD.l, PAD.t + 0.5);
  ctx.lineTo(width - PAD.r, PAD.t + 0.5);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(x(0), PAD.t);
  series.forEach((s, i) => ctx.lineTo(x(i), y(s.dd)));
  ctx.lineTo(x(series.length - 1), PAD.t);
  ctx.closePath();
  ctx.fillStyle = withAlpha(t.short, 0.22);
  ctx.fill();

  ctx.beginPath();
  series.forEach((s, i) => (i ? ctx.lineTo(x(i), y(s.dd)) : ctx.moveTo(x(i), y(s.dd))));
  ctx.strokeStyle = t.short;
  ctx.lineWidth = 2;
  ctx.stroke();

  axisText(ctx, t);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(fmt.pct(worst, 1), width - PAD.r + 6, y(worst));
  ctx.fillText('0%', width - PAD.r + 6, PAD.t);

  attachTooltip(canvas, (mx) => {
    const i = Math.round(((mx - PAD.l) / (width - PAD.l - PAD.r)) * (series.length - 1));
    if (i < 0 || i >= series.length) return null;
    return `<b>${fmt.date(series[i].ts)}</b><br><span class="k">drawdown</span> ${fmt.pct(series[i].dd, 2)}`;
  });
}

/** Monthly returns as a diverging heatmap: two poles, neutral at zero. */
export function drawMonthly(canvas, { monthly, height = 92 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!monthly?.length) return emptyState(ctx, width, h, t, '');

  const peak = Math.max(...monthly.map((m) => Math.abs(m.ret)), 0.001);
  // Cap the cell width so a one-month backtest renders as a single tile rather
  // than a banner stretched across the card.
  const cellW = Math.min(96, Math.max(14, (width - PAD.l - 8) / monthly.length));
  const cellH = h - 34;

  monthly.forEach((m, i) => {
    const x = PAD.l + i * cellW;
    const mag = Math.abs(m.ret) / peak;
    // 2px gap between cells rather than a border.
    ctx.fillStyle = m.ret === 0 ? t.grid : withAlpha(m.ret > 0 ? t.long : t.short, 0.15 + 0.75 * mag);
    ctx.fillRect(x + 1, PAD.t, cellW - 2, cellH);
    if (cellW > 40) {
      ctx.fillStyle = t.text;
      ctx.font = '10px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${(m.ret * 100).toFixed(1)}%`, x + cellW / 2, PAD.t + cellH / 2);
    }
    if (cellW > 26) {
      axisText(ctx, t);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(m.month.slice(2), x + cellW / 2, PAD.t + cellH + 6);
    }
  });

  attachTooltip(canvas, (mx) => {
    const i = Math.floor((mx - PAD.l) / cellW);
    if (i < 0 || i >= monthly.length) return null;
    return `<b>${monthly[i].month}</b><br><span class="k">return</span> ${fmt.signedPct(monthly[i].ret)}`;
  });
}

/** Monte Carlo fan: sample paths behind the median, for dispersion at a glance. */
export function drawMonteCarlo(canvas, { curves, height = 200 }) {
  const { ctx, width, height: h } = fitCanvas(canvas, height);
  const t = theme();
  if (!curves?.length) return emptyState(ctx, width, h, t, 'run Monte Carlo to see the confidence band');

  const all = curves.flat();
  const min = Math.min(...all), max = Math.max(...all);
  const span = max - min || 1;
  const n = curves[0].length;
  const x = (i) => PAD.l + (i / Math.max(1, n - 1)) * (width - PAD.l - PAD.r);
  const y = (v) => PAD.t + ((max - v) / span) * (h - PAD.t - PAD.b);

  priceGrid(ctx, { width, height: h, min, max, y, t, lines: 3, format: (v) => fmt.compact(v) });

  ctx.lineWidth = 1;
  ctx.strokeStyle = withAlpha(t.accent, 0.18);
  for (const c of curves) {
    ctx.beginPath();
    c.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
  }

  // Median path across the sample, drawn on top.
  const median = [];
  for (let i = 0; i < n; i++) {
    const col = curves.map((c) => c[i]).sort((a, b) => a - b);
    median.push(col[Math.floor(col.length / 2)]);
  }
  ctx.beginPath();
  median.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  attachTooltip(canvas, (mx) => {
    const i = Math.round(((mx - PAD.l) / (width - PAD.l - PAD.r)) * (n - 1));
    if (i < 0 || i >= n) return null;
    const col = curves.map((c) => c[i]).sort((a, b) => a - b);
    return `<b>trade ${i}</b><br>
      <span class="k">median</span> ${fmt.compact(col[Math.floor(col.length / 2)])}<br>
      <span class="k">5–95%</span> ${fmt.compact(col[Math.floor(col.length * 0.05)])} – ${fmt.compact(col[Math.floor(col.length * 0.95)])}`;
  });
}

function emptyState(ctx, width, height, t, message) {
  if (!message) return;
  ctx.fillStyle = t.muted2;
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(message, width / 2, height / 2);
}
