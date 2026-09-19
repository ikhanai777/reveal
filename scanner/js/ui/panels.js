// Panel renderers. Each takes a container and data and repaints it; none of
// them hold state, so the app can call any of them at any time.

import { el, clear, fmt } from './dom.js';
import { STATE } from '../signal/tracker.js';

const dirWord = (d) => (d > 0 ? 'LONG' : d < 0 ? 'SHORT' : 'FLAT');

/** Scan heatmap. Each tile is a button so the grid is keyboard-navigable. */
export function renderHeatmap(container, rows, { selected, onSelect }) {
  clear(container);
  if (!rows.length) {
    container.append(el('p', { class: 'empty', text: 'No symbols on the watchlist yet.' }));
    return;
  }
  for (const row of rows) {
    const ev = row.evaluation;
    const scs = ev?.scs;
    const dir = ev?.classification?.direction ?? 0;
    const bias = ev?.classification?.bias ?? 'WARMING UP';
    const warm = Number.isFinite(scs);

    const meter = el('div', { class: 'tile-meter' });
    if (warm) {
      // Meter grows from the 50 midpoint toward whichever pole the score sits on.
      const from = Math.min(50, scs), to = Math.max(50, scs);
      meter.append(el('i', {
        style: `left:${from}%;width:${Math.max(1, to - from)}%;background:${dir >= 0 ? 'var(--long)' : 'var(--short)'}`,
      }));
    }

    container.append(el('button', {
      class: 'tile',
      type: 'button',
      'aria-current': row.symbol === selected ? 'true' : 'false',
      onclick: () => onSelect(row.symbol),
    }, [
      el('div', { class: 'tile-top' }, [
        el('span', { class: 'tile-sym', text: row.symbol }),
        el('span', { class: 'tile-price num', text: fmt.price(row.price) }),
      ]),
      el('div', { class: 'tile-scs num', text: warm ? Math.round(scs) : '—' }),
      meter,
      el('div', { class: 'tile-foot' }, [
        el('span', {
          class: `pill ${dir > 0 ? 'long' : dir < 0 ? 'short' : ''}`,
          text: bias.replace(/_/g, ' '),
        }),
        el('span', { text: `${row.bars} bars` }),
      ]),
    ]));
  }
}

/** Factor breakdown: diverging bars around a neutral midpoint. */
export function renderFactors(container, evaluation) {
  clear(container);
  if (!evaluation) {
    container.append(el('p', { class: 'empty', text: 'Warming up — the engines need 60 closed bars before they score.' }));
    return;
  }
  for (const f of evaluation.breakdown) {
    const bar = el('div', { class: 'factor-bar' });
    if (f.ready) {
      const half = Math.abs(f.score) * 50;
      bar.append(el('i', {
        style: f.score >= 0
          ? `left:50%;width:${half}%;background:var(--long)`
          : `left:${50 - half}%;width:${half}%;background:var(--short)`,
      }));
    }
    const components = (f.components || [])
      .filter((c) => c.score != null)
      .map((c) => `${c.label}: ${c.detail ?? fmt.num(c.score)}`)
      .join(' · ');

    container.append(el('div', { class: `factor${f.ready ? '' : ' muted'}` }, [
      el('span', { class: 'factor-name', text: `${f.label} · ${Math.round(f.weight * 100)}%` }),
      el('span', { class: 'factor-val', text: f.ready ? `${f.scaled.toFixed(0)}/100` : (f.detail || 'warming up') }),
      bar,
      components ? el('span', { class: 'factor-detail', text: components }) : null,
    ]));
  }
}

/** The live trade plan for the selected symbol, or why there isn't one. */
export function renderPlan(container, { evaluation, plan, symbol }) {
  clear(container);
  if (!evaluation) {
    container.append(el('p', { class: 'empty', text: 'No evaluation yet.' }));
    return;
  }
  const c = evaluation.classification;

  const notes = [];
  if (c.gatesFailed?.length) notes.push(`Downgraded — ${c.gatesFailed.join('; ')}`);
  for (const v of evaluation.filters.vetoes) notes.push(`Vetoed — ${v}`);
  for (const w of evaluation.filters.warnings) notes.push(`Warning — ${w}`);

  container.append(el('div', { class: 'row', style: 'align-items:center;gap:10px' }, [
    el('span', { class: `pill ${c.direction > 0 ? 'long' : c.direction < 0 ? 'short' : ''}`, text: c.bias.replace(/_/g, ' ') }),
    el('span', { class: 'num', style: 'font-size:22px;font-weight:600', text: Math.round(evaluation.scs) }),
    el('span', { style: 'color:var(--muted);font-size:12px', text: `SCS · ${symbol} · ${evaluation.timeframe}` }),
  ]));

  if (plan && !plan.rejected) {
    const table = el('table');
    table.append(el('tbody', {}, [
      row('Entry zone', `${fmt.price(plan.entry.low)} – ${fmt.price(plan.entry.high)}`, `anchor ${plan.entry.anchor}`),
      row('Stop loss', fmt.price(plan.stop), `risk ${fmt.pct(plan.riskPct)}`),
      ...plan.targets.map((t) => row(t.name, fmt.price(t.price), `${Math.round(t.size * 100)}% · ${t.rr.toFixed(1)}R · ${t.action}`)),
    ]));
    container.append(table);
  } else if (plan?.rejected) {
    container.append(el('p', { class: 'notice', text: `No plan: ${plan.reason}` }));
  } else {
    container.append(el('p', { class: 'notice', text: 'No actionable setup at this score.' }));
  }

  for (const n of notes) container.append(el('p', { class: 'notice', text: n }));

  function row(label, value, detail) {
    return el('tr', {}, [
      el('td', { text: label }),
      el('td', { class: 'num mono', text: value }),
      el('td', { style: 'color:var(--muted)', text: detail }),
    ]);
  }
}

const STATE_CLASS = {
  [STATE.CLOSED_WIN]: 'pos',
  [STATE.CLOSED_LOSS]: 'neg',
};

/** Historical signal tracker log. */
export function renderSignalLog(container, signals) {
  clear(container);
  if (!signals.length) {
    container.append(el('p', { class: 'empty', text: 'No signals logged yet. They appear here the moment one is emitted.' }));
    return;
  }
  const head = ['Time', 'Asset', 'Bias', 'Entry', 'Target', 'Stop', 'Status', 'PnL', 'MFE', 'MAE'];
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { class: i >= 3 ? 'num' : '', text: h })))]),
  ]);
  const body = el('tbody');
  for (const s of signals.slice(0, 120)) {
    body.append(el('tr', {}, [
      el('td', { class: 'mono', text: fmt.time(s.ts) }),
      el('td', { text: s.symbol }),
      el('td', {}, [el('span', { class: `pill ${s.direction > 0 ? 'long' : 'short'}`, text: dirWord(s.direction) })]),
      el('td', { class: 'num mono', text: fmt.price(s.entry.mid) }),
      el('td', { class: 'num mono', text: fmt.price(s.targets[0]?.price) }),
      el('td', { class: 'num mono', text: fmt.price(s.stop) }),
      el('td', { class: STATE_CLASS[s.state] || '', text: s.state.replace(/_/g, ' ') }),
      el('td', { class: `num mono ${s.realizedPct > 0 ? 'pos' : s.realizedPct < 0 ? 'neg' : ''}`, text: s.realizedPct ? fmt.signedPct(s.realizedPct) : '—' }),
      el('td', { class: 'num mono', text: fmt.signedPct(s.mfe) }),
      el('td', { class: 'num mono', text: fmt.signedPct(s.mae) }),
    ]));
  }
  table.append(body);
  container.append(table);
}

/** Stat tiles. Each value is one number, which is the chart. */
export function renderMetrics(container, items) {
  clear(container);
  for (const [label, value, tone] of items) {
    container.append(el('div', { class: 'metric' }, [
      el('dt', { text: label }),
      el('dd', { class: tone || '', text: value }),
    ]));
  }
}

/** Backtest trade blotter. */
export function renderTrades(container, trades) {
  clear(container);
  if (!trades.length) {
    container.append(el('p', { class: 'empty', text: 'No trades were taken in this run.' }));
    return;
  }
  const head = ['Opened', 'Dir', 'SCS', 'Entry', 'Exit', 'PnL', 'R:R', 'Bars', 'Reason'];
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, head.map((h, i) => el('th', { class: i >= 2 && i <= 6 ? 'num' : '', text: h })))]),
  ]);
  const body = el('tbody');
  for (const t of trades.slice(-150).reverse()) {
    body.append(el('tr', {}, [
      el('td', { class: 'mono', text: `${fmt.date(t.openTs)} ${fmt.time(t.openTs)}` }),
      el('td', {}, [el('span', { class: `pill ${t.direction > 0 ? 'long' : 'short'}`, text: dirWord(t.direction) })]),
      el('td', { class: 'num', text: Math.round(t.scs) }),
      el('td', { class: 'num mono', text: fmt.price(t.entryPrice) }),
      el('td', { class: 'num mono', text: fmt.price(t.exitPrice) }),
      el('td', { class: `num mono ${t.pnl >= 0 ? 'pos' : 'neg'}`, text: `${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}` }),
      el('td', { class: 'num', text: fmt.signedPct(t.pnlPct) }),
      el('td', { class: 'num', text: t.barsHeld }),
      el('td', { style: 'color:var(--muted)', text: t.closeReason }),
    ]));
  }
  table.append(body);
  container.append(table);
}

/** Walk-forward fold table: in-sample against out-of-sample, side by side. */
export function renderFolds(container, result) {
  clear(container);
  if (!result?.folds?.length) {
    container.append(el('p', { class: 'empty', text: 'Run walk-forward to validate the weights out of sample.' }));
    return;
  }
  const table = el('table', {}, [
    el('thead', {}, [el('tr', {}, ['Fold', 'Window', 'IS Sharpe', 'OOS Sharpe', 'Efficiency', 'OOS return', 'OOS trades']
      .map((h, i) => el('th', { class: i >= 2 ? 'num' : '', text: h })))]),
  ]);
  const body = el('tbody');
  for (const f of result.folds) {
    const eff = f.efficiency;
    body.append(el('tr', {}, [
      el('td', { text: f.fold }),
      el('td', { class: 'mono', style: 'color:var(--muted)', text: `${fmt.date(f.outSampleRange[0])} →` }),
      el('td', { class: 'num', text: fmt.num(f.inSample.sharpe) }),
      el('td', { class: 'num', text: f.outSample ? fmt.num(f.outSample.sharpe) : '—' }),
      el('td', { class: `num ${eff == null ? '' : eff >= 0.5 ? 'pos' : 'neg'}`, text: eff == null ? '—' : fmt.num(eff) }),
      el('td', { class: `num ${f.outSample?.cumulativeReturn >= 0 ? 'pos' : 'neg'}`, text: f.outSample ? fmt.signedPct(f.outSample.cumulativeReturn) : '—' }),
      el('td', { class: 'num', text: f.outSample?.trades ?? '—' }),
    ]));
  }
  table.append(body);
  container.append(table);

  const w = result.summary.consensusWeights;
  container.append(el('p', { class: 'notice' }, [
    el('strong', { text: 'Consensus weights: ' }),
    Object.entries(w).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(' · '),
  ]));
}

/** Connection and feed health. */
export function renderStatus(container, statuses) {
  clear(container);
  const entries = [...statuses.entries()];
  if (!entries.length) {
    container.append(el('span', { text: 'Idle — no feed connected.' }));
    return;
  }
  for (const [name, s] of entries) {
    const tone = s.state === 'open' || s.state === 'book-synced' ? 'ok'
      : s.state === 'reconnecting' || s.state === 'stale' ? 'warn'
      : s.state === 'error' || s.state === 'unavailable' ? 'bad' : '';
    container.append(el('span', { style: 'display:inline-flex;align-items:center;gap:6px' }, [
      el('i', { class: `dot ${tone}` }),
      `${name}: ${s.state}${s.detail ? ` (${s.detail})` : ''}`,
    ]));
  }
}
