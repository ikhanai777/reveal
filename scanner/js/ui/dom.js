// DOM and formatting helpers.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

export const fmt = {
  price(v, digits) {
    if (!Number.isFinite(v)) return '—';
    const d = digits ?? (Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 1 ? 3 : 6);
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  pct(v, digits = 2) { return Number.isFinite(v) ? `${(v * 100).toFixed(digits)}%` : '—'; },
  signedPct(v, digits = 2) { return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%` : '—'; },
  num(v, digits = 2) { return Number.isFinite(v) ? v.toFixed(digits) : '—'; },
  compact(v) {
    if (!Number.isFinite(v)) return '—';
    const a = Math.abs(v);
    if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
    return v.toFixed(2);
  },
  time(ts) {
    if (!Number.isFinite(ts)) return '—';
    return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  },
  date(ts) {
    if (!Number.isFinite(ts)) return '—';
    return new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  },
  duration(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const m = Math.round(ms / 60_000);
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
  },
};

/** Read a CSS custom property so canvas drawing follows the active theme. */
export function token(name, fallback = '#888') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Size a canvas to its CSS box at device pixel ratio; returns a scaled ctx. */
export function fitCanvas(canvas, cssHeight) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const width = canvas.clientWidth || canvas.parentElement?.clientWidth || 600;
  const height = cssHeight ?? canvas.clientHeight ?? 220;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return { ctx, width, height };
}

/** Coalesce repeated redraw requests into one per animation frame. */
export function rafThrottle(fn) {
  let queued = false;
  let lastArgs;
  return (...args) => {
    lastArgs = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; fn(...lastArgs); });
  };
}
