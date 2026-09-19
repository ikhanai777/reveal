// Reconnecting WebSocket with heartbeat-driven staleness detection.
// Exchanges silently wedge connections far more often than they close them, so
// "no message for N seconds" is treated as a disconnect.

import { backoff } from './ratelimit.js';

export class ManagedSocket {
  constructor({ url, name = 'ws', staleMs = 45_000, onMessage, onOpen, onStatus, WebSocketImpl }) {
    this.url = url;
    this.name = name;
    this.staleMs = staleMs;
    this.onMessage = onMessage || (() => {});
    this.onOpen = onOpen || (() => {});
    this.onStatus = onStatus || (() => {});
    this.WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    this.ws = null;
    this.attempt = 0;
    this.lastMessageAt = 0;
    this.closedByUser = false;
    this.timer = null;
  }

  connect() {
    if (!this.WS) {
      this.status('unavailable', 'no WebSocket implementation in this runtime');
      return;
    }
    this.closedByUser = false;
    this.status('connecting');
    let ws;
    try {
      ws = new this.WS(this.url);
    } catch (err) {
      this.scheduleReconnect(err?.message || 'construct failed');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      this.lastMessageAt = Date.now();
      this.status('open');
      this.startWatchdog();
      this.onOpen(this);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      let data;
      try { data = JSON.parse(ev.data); } catch { return; }
      this.onMessage(data, this);
    };
    ws.onerror = () => { this.status('error'); };
    ws.onclose = () => {
      this.stopWatchdog();
      if (this.closedByUser) { this.status('closed'); return; }
      this.scheduleReconnect('socket closed');
    };
  }

  startWatchdog() {
    this.stopWatchdog();
    this.timer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.staleMs) {
        this.status('stale');
        try { this.ws?.close(); } catch { /* already gone */ }
      }
    }, Math.max(1000, Math.floor(this.staleMs / 3)));
  }

  stopWatchdog() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  scheduleReconnect(reason) {
    const wait = backoff(this.attempt++);
    this.status('reconnecting', `${reason}; retry in ${Math.round(wait / 1000)}s`);
    setTimeout(() => { if (!this.closedByUser) this.connect(); }, wait);
  }

  send(obj) {
    try { this.ws?.send(JSON.stringify(obj)); } catch { /* reconnect will resubscribe */ }
  }

  close() {
    this.closedByUser = true;
    this.stopWatchdog();
    try { this.ws?.close(); } catch { /* noop */ }
  }

  status(state, detail) {
    this.onStatus({ name: this.name, state, detail, ts: Date.now() });
  }
}
