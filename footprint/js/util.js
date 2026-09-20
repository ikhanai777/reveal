// Small shared helpers. No dependencies.

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Decimal places implied by a tick size such as 0.01 or 1e-8. */
export function decimalsFor(tickSize) {
  if (!(tickSize > 0)) return 2;
  const s = tickSize.toExponential();
  const exp = Number(s.slice(s.indexOf('e') + 1));
  const mantissaDigits = s.slice(0, s.indexOf('e')).replace(/^-?\d\.?/, '').replace(/0+$/, '').length;
  return Math.max(0, mantissaDigits - exp);
}

export function fmtPrice(p, decimals) {
  return p.toFixed(decimals);
}

/** Compact volume: 12345 -> "12.3K". Footprint cells need short strings. */
export function fmtVol(v, digits = 1) {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(digits) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(digits) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(digits) + 'K';
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(digits);
  if (a === 0) return '0';
  return v.toFixed(Math.min(3, digits + 2));
}

export function fmtSigned(v, digits = 1) {
  const s = fmtVol(Math.abs(v), digits);
  return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
}

export function fmtPct(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(digits) + '%';
}

export function fmtMoney(v, digits = 2) {
  if (!Number.isFinite(v)) return '—';
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtTime(ms, withDate = false) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  const t = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (!withDate) return t;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${t}`;
}

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
}

/** Interval string ("1m", "4h", "1d") -> milliseconds. */
export const INTERVAL_MS = {
  '1s': 1000,
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
};

export function intervalMs(interval) {
  const ms = INTERVAL_MS[interval];
  if (!ms) throw new Error(`Unsupported interval: ${interval}`);
  return ms;
}

/** Bucket a timestamp down to the start of its interval (UTC-aligned, like Binance). */
export function bucketStart(ts, ms) {
  return Math.floor(ts / ms) * ms;
}

export function quantile(sortedArr, q) {
  if (!sortedArr.length) return NaN;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sortedArr[base + 1];
  return next === undefined ? sortedArr[base] : sortedArr[base] + rest * (next - sortedArr[base]);
}

export function mean(arr) {
  if (!arr.length) return NaN;
  let s = 0;
  for (const v of arr) s += v;
  return s / arr.length;
}

export function stdev(arr, sample = true) {
  const n = arr.length;
  if (n < 2) return NaN;
  const m = mean(arr);
  let acc = 0;
  for (const v of arr) acc += (v - m) * (v - m);
  return Math.sqrt(acc / (sample ? n - 1 : n));
}

/** Deep-ish merge of plain objects, used to hydrate saved settings over defaults. */
export function mergeDeep(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = mergeDeep(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function debounce(fn, ms) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label ?? c.key)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(c.get ? c.get(r) : r[c.key])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}
