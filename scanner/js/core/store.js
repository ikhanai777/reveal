// Namespaced persistence with an in-memory fallback.
// localStorage throws in private windows and is absent under Node, so every
// access is guarded and the engines never depend on it succeeding.

const memory = new Map();

function backend() {
  try {
    if (typeof localStorage !== 'undefined') {
      const probe = '__scanner_probe__';
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    }
  } catch { /* fall through to memory */ }
  return null;
}

const ls = backend();

export function load(key, fallback) {
  try {
    const raw = ls ? ls.getItem(key) : memory.get(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  const raw = JSON.stringify(value);
  try {
    if (ls) ls.setItem(key, raw);
    else memory.set(key, raw);
    return true;
  } catch {
    // Quota exceeded or blocked storage: keep the session working in memory.
    memory.set(key, raw);
    return false;
  }
}

export function remove(key) {
  try { ls ? ls.removeItem(key) : memory.delete(key); } catch { memory.delete(key); }
}

export const KEYS = {
  settings: 'scanner:settings:v1',
  weights: 'scanner:weights:v1',
  signals: 'scanner:signals:v1',
  webhooks: 'scanner:webhooks:v1',
  watchlist: 'scanner:watchlist:v1',
};
