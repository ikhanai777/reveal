// Signal tracker: lifecycle state machine, drift metrics, and the append-only
// audit log.
//
// Every signal is followed from issuance to resolution. Each transition is
// appended to a hash-chained log, so a log whose history has been edited after
// the fact fails verification.

import { chainEntry, verifyChain } from '../core/hash.js';
import { trailStop } from './risk.js';
import { load, save, KEYS } from '../core/store.js';

export const STATE = {
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  TP1_REACHED: 'TP1_REACHED',
  TP2_REACHED: 'TP2_REACHED',
  CLOSED_WIN: 'CLOSED_WIN',
  CLOSED_LOSS: 'CLOSED_LOSS',
  EXPIRED: 'EXPIRED',
};

const TERMINAL = new Set([STATE.CLOSED_WIN, STATE.CLOSED_LOSS, STATE.EXPIRED]);

let seq = 0;
export function signalId(ts = Date.now()) {
  seq = (seq + 1) % 100000;
  return `SIG-${ts.toString(36).toUpperCase()}-${seq.toString(36).toUpperCase().padStart(3, '0')}`;
}

export class SignalTracker {
  constructor({ persist = true, maxLog = 5000 } = {}) {
    this.persist = persist;
    this.maxLog = maxLog;
    this.signals = new Map();
    this.log = [];
    this.listeners = new Set();
    if (persist) this.restore();
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(evt) { for (const fn of this.listeners) { try { fn(evt); } catch { /* UI errors never break tracking */ } } }

  /**
   * @param {object} args
   * @param {string} args.symbol
   * @param {object} args.plan        from buildTradePlan
   * @param {object} args.evaluation  from evaluate()
   */
  open({ symbol, timeframe, plan, evaluation, strategy = 'scs-matrix', ts = Date.now(), venue = 'binance-futures' }) {
    const id = signalId(ts);
    const sig = {
      id,
      ts,
      symbol,
      venue,
      timeframe,
      strategy,
      direction: plan.direction,
      bias: evaluation.classification.bias,
      scs: evaluation.scs,
      scoreBreakdown: evaluation.breakdown.map((b) => ({
        key: b.key, label: b.label, weight: b.weight, score: b.score, scaled: b.scaled, contribution: b.contribution,
      })),
      entry: plan.entry,
      stop: plan.stop,
      initialStop: plan.stop,
      targets: plan.targets.map((t) => ({ ...t, hit: false, hitTs: null })),
      risk: plan.risk,
      trail: plan.trail,
      expiryBars: plan.expiryBars,
      state: STATE.PENDING,
      // Drift metrics
      fillPrice: null,
      signalPrice: plan.entry.mid,
      slippage: null,
      mfe: 0,
      mae: 0,
      mfePrice: null,
      maePrice: null,
      realizedPct: 0,
      remaining: 1,
      closedTs: null,
      barsElapsed: 0,
      notes: [],
    };
    this.signals.set(id, sig);
    this.append('OPEN', sig, { scs: evaluation.scs, bias: sig.bias });
    this.emit({ type: 'open', signal: sig });
    return sig;
  }

  /**
   * Advance one signal against a new price observation.
   * `high`/`low` let a backtest feed a whole bar; live ticks pass price alone.
   */
  update(id, { price, high = price, low = price, ts = Date.now(), barClosed = false }) {
    const s = this.signals.get(id);
    if (!s || TERMINAL.has(s.state)) return s;
    if (barClosed) s.barsElapsed++;
    const dir = s.direction;

    if (s.state === STATE.PENDING) {
      const inZone = low <= s.entry.high && high >= s.entry.low;
      if (inZone) {
        // Fill at the zone edge price would realistically have crossed.
        s.fillPrice = clampToZone(dir > 0 ? Math.max(low, s.entry.low) : Math.min(high, s.entry.high), s.entry);
        s.slippage = s.fillPrice - s.signalPrice;
        s.slippageBps = (s.slippage / s.signalPrice) * 10_000 * dir;
        s.state = STATE.ACTIVE;
        s.filledTs = ts;
        this.append('FILL', s, { fillPrice: s.fillPrice, slippageBps: s.slippageBps });
        this.emit({ type: 'fill', signal: s });
      } else if (s.barsElapsed >= s.expiryBars) {
        s.state = STATE.EXPIRED;
        s.closedTs = ts;
        this.append('EXPIRE', s, { barsElapsed: s.barsElapsed });
        this.emit({ type: 'expire', signal: s });
        return s;
      } else {
        return s;
      }
    }

    // --- Excursions (measured from the actual fill) -------------------------
    const base = s.fillPrice ?? s.signalPrice;
    const favor = dir > 0 ? (high - base) / base : (base - low) / base;
    const adverse = dir > 0 ? (low - base) / base : (base - high) / base;
    if (favor > s.mfe) { s.mfe = favor; s.mfePrice = dir > 0 ? high : low; }
    if (adverse < s.mae) { s.mae = adverse; s.maePrice = dir > 0 ? low : high; }

    // --- Stop first: within one bar a stop-out is the conservative read -----
    const stopHit = dir > 0 ? low <= s.stop : high >= s.stop;
    if (stopHit) return this.closeAt(s, s.stop, ts, 'STOP');

    // --- Targets ------------------------------------------------------------
    for (let i = 0; i < s.targets.length; i++) {
      const t = s.targets[i];
      if (t.hit) continue;
      const reached = dir > 0 ? high >= t.price : low <= t.price;
      if (!reached) break; // targets are ordered; stop at the first unreached
      t.hit = true;
      t.hitTs = ts;
      s.realizedPct += ((t.price - base) / base) * dir * t.size;
      s.remaining = Math.max(0, +(s.remaining - t.size).toFixed(6));
      if (i === 0) {
        s.state = STATE.TP1_REACHED;
        s.stop = base;  // breakeven, exactly as the spec's lifecycle requires
        s.notes.push('TP1 hit — stop to breakeven');
      } else if (i === 1) {
        s.state = STATE.TP2_REACHED;
      }
      this.append(`TP${i + 1}`, s, { price: t.price, realizedPct: s.realizedPct });
      this.emit({ type: 'target', signal: s, target: t });
      if (s.remaining <= 1e-6) return this.closeAt(s, t.price, ts, 'TARGETS');
    }

    // --- Runner trail --------------------------------------------------------
    if (s.state === STATE.TP2_REACHED && s.trail?.atr) {
      s.stop = trailStop({ direction: dir, currentStop: s.stop, price, atr: s.trail.atr, mult: s.trail.atrMult });
    }
    return s;
  }

  closeAt(s, price, ts, reason) {
    const base = s.fillPrice ?? s.signalPrice;
    const dir = s.direction;
    s.realizedPct += ((price - base) / base) * dir * s.remaining;
    s.remaining = 0;
    s.exitPrice = price;
    s.closedTs = ts;
    s.closeReason = reason;
    s.state = s.realizedPct >= 0 ? STATE.CLOSED_WIN : STATE.CLOSED_LOSS;
    s.holdingMs = s.filledTs ? ts - s.filledTs : 0;
    this.append('CLOSE', s, { price, reason, realizedPct: s.realizedPct, state: s.state });
    this.emit({ type: 'close', signal: s });
    this.save();
    return s;
  }

  /** Feed one bar to every live signal on a symbol. */
  updateSymbol(symbol, bar) {
    for (const s of this.signals.values()) {
      if (s.symbol === symbol && !TERMINAL.has(s.state)) {
        this.update(s.id, { price: bar.c, high: bar.h, low: bar.l, ts: bar.t, barClosed: true });
      }
    }
  }

  // --- Audit log ------------------------------------------------------------

  append(event, s, extra = {}) {
    const record = {
      event,
      id: s.id,
      ts: Date.now(),
      symbol: s.symbol,
      state: s.state,
      ...extra,
    };
    const prevHash = this.log.length ? this.log[this.log.length - 1].hash : '0'.repeat(16);
    this.log.push({ ...record, prevHash, hash: chainEntry(record, prevHash) });
    if (this.log.length > this.maxLog) this.log.shift();
  }

  /** -1 when intact, otherwise the index of the first broken link. */
  verify() { return verifyChain(this.log); }

  // --- Queries --------------------------------------------------------------

  all() { return [...this.signals.values()].sort((a, b) => b.ts - a.ts); }
  live() { return this.all().filter((s) => !TERMINAL.has(s.state)); }
  closed() { return this.all().filter((s) => TERMINAL.has(s.state)); }

  stats() {
    const done = this.closed().filter((s) => s.state !== STATE.EXPIRED);
    const wins = done.filter((s) => s.realizedPct > 0);
    const losses = done.filter((s) => s.realizedPct <= 0);
    const grossWin = wins.reduce((a, s) => a + s.realizedPct, 0);
    const grossLoss = Math.abs(losses.reduce((a, s) => a + s.realizedPct, 0));
    return {
      total: this.signals.size,
      resolved: done.length,
      open: this.live().length,
      expired: this.closed().filter((s) => s.state === STATE.EXPIRED).length,
      winRate: done.length ? wins.length / done.length : 0,
      avgWin: wins.length ? grossWin / wins.length : 0,
      avgLoss: losses.length ? -grossLoss / losses.length : 0,
      profitFactor: grossLoss ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      netPct: done.reduce((a, s) => a + s.realizedPct, 0),
      avgMfe: done.length ? done.reduce((a, s) => a + s.mfe, 0) / done.length : 0,
      avgMae: done.length ? done.reduce((a, s) => a + s.mae, 0) / done.length : 0,
      avgSlippageBps: done.length ? done.reduce((a, s) => a + (s.slippageBps || 0), 0) / done.length : 0,
      avgHoldMs: done.length ? done.reduce((a, s) => a + (s.holdingMs || 0), 0) / done.length : 0,
    };
  }

  // --- Persistence ----------------------------------------------------------

  save() {
    if (!this.persist) return;
    save(KEYS.signals, { signals: this.all().slice(0, 500), log: this.log.slice(-1000) });
  }

  restore() {
    const data = load(KEYS.signals, null);
    if (!data) return;
    for (const s of data.signals || []) this.signals.set(s.id, s);
    this.log = data.log || [];
  }

  clear() {
    this.signals.clear();
    this.log = [];
    this.save();
    this.emit({ type: 'clear' });
  }
}

function clampToZone(price, zone) {
  return Math.min(zone.high, Math.max(zone.low, price));
}
