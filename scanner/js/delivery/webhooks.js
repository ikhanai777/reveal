// Webhook dispatch with retry, dead-lettering and per-destination stats.
//
// Note on credentials: a browser-hosted dashboard cannot hold a Telegram bot
// token safely — anything in the page is readable by whoever opens it, and a
// browser cannot set custom headers on a cross-origin request without the
// destination's CORS cooperation. The `relay` destination type posts to your
// own backend, which holds the tokens and fans out. Direct Telegram/Discord
// destinations are supported for local and single-operator use, where the
// token never leaves the operator's own machine.

import { FORMATTERS } from './format.js';
import { load, save, KEYS } from '../core/store.js';
import { backoff } from '../ingest/ratelimit.js';

export class WebhookDispatcher {
  constructor({ fetchImpl, maxRetries = 3, sleep } = {}) {
    this.fetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    this.maxRetries = maxRetries;
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.destinations = load(KEYS.webhooks, []);
    this.deadLetter = [];
    this.stats = new Map();
  }

  /**
   * @param {object} dest
   * @param {string} dest.id
   * @param {'relay'|'discord'|'telegram'|'generic'} dest.type
   * @param {string} dest.url
   * @param {string} [dest.chatId]  telegram only
   * @param {number} [dest.minScs]  suppress below this confidence
   * @param {string[]} [dest.biases] restrict to specific biases
   */
  add(dest) {
    this.destinations = this.destinations.filter((d) => d.id !== dest.id);
    this.destinations.push({ enabled: true, minScs: 0, ...dest });
    save(KEYS.webhooks, this.destinations);
    return dest;
  }

  remove(id) {
    this.destinations = this.destinations.filter((d) => d.id !== id);
    save(KEYS.webhooks, this.destinations);
  }

  shouldSend(dest, signal) {
    if (!dest.enabled) return false;
    const conf = signal.scs ?? 0;
    // A short's confidence lives at the bottom of the 0-100 range.
    const strength = signal.direction < 0 ? 100 - conf : conf;
    if (strength < (dest.minScs ?? 0)) return false;
    if (dest.biases?.length && !dest.biases.includes(signal.bias)) return false;
    if (dest.symbols?.length && !dest.symbols.includes(signal.symbol)) return false;
    return true;
  }

  buildRequest(dest, signal) {
    switch (dest.type) {
      case 'discord':
        return { url: dest.url, init: jsonInit(FORMATTERS.discord(signal)) };
      case 'telegram': {
        const p = FORMATTERS.telegram(signal);
        return { url: dest.url, init: jsonInit({ chat_id: dest.chatId, ...p }) };
      }
      case 'relay':
      case 'generic':
      default:
        return {
          url: dest.url,
          init: jsonInit(FORMATTERS.json(signal), dest.headers),
        };
    }
  }

  async deliver(dest, signal) {
    if (!this.fetch) return { ok: false, error: 'no fetch implementation' };
    const { url, init } = this.buildRequest(dest, signal);
    let lastError = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.fetch(url, init);
        if (res.ok) { this.record(dest.id, true); return { ok: true, status: res.status }; }
        // 4xx other than 429 will not succeed on retry.
        if (res.status !== 429 && res.status < 500) {
          lastError = `HTTP ${res.status}`;
          break;
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = err?.message || String(err);
      }
      if (attempt < this.maxRetries) await this.sleep(backoff(attempt, { base: 500, cap: 8000 }));
    }
    this.record(dest.id, false);
    this.deadLetter.push({ destId: dest.id, signalId: signal.id, error: lastError, ts: Date.now() });
    if (this.deadLetter.length > 200) this.deadLetter.shift();
    return { ok: false, error: lastError };
  }

  /** Fan out one signal to every matching destination. */
  async send(signal) {
    const targets = this.destinations.filter((d) => this.shouldSend(d, signal));
    const results = await Promise.all(targets.map(async (d) => ({
      id: d.id, ...(await this.deliver(d, signal)),
    })));
    return results;
  }

  record(id, ok) {
    const s = this.stats.get(id) || { sent: 0, failed: 0 };
    if (ok) s.sent++; else s.failed++;
    this.stats.set(id, s);
  }

  /** Retry everything in the dead-letter queue. */
  async replayDeadLetters(signalsById) {
    const queue = this.deadLetter.splice(0, this.deadLetter.length);
    for (const item of queue) {
      const dest = this.destinations.find((d) => d.id === item.destId);
      const signal = signalsById.get(item.signalId);
      if (dest && signal) await this.deliver(dest, signal);
    }
  }
}

function jsonInit(body, extraHeaders = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/**
 * Local WebSocket broadcast for execution bots on the same machine.
 * Browsers cannot listen on a port, so this is a client that publishes into a
 * relay you run; the server-side counterpart is a dozen lines of ws.
 */
export class AlertSocket {
  constructor({ url, WebSocketImpl }) {
    this.url = url;
    this.WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.ws = null;
    this.queue = [];
  }

  connect() {
    if (!this.WS) return;
    this.ws = new this.WS(this.url);
    this.ws.onopen = () => { for (const m of this.queue.splice(0)) this.publish(m); };
  }

  publish(payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(payload));
    else {
      this.queue.push(payload);
      if (this.queue.length > 100) this.queue.shift();
    }
  }
}
