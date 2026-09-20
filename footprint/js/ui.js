// DOM helpers, schema-driven controls and the result renderers.

import { RULES } from './signals.js';
import { fmtMoney, fmtPct, fmtVol, fmtSigned, fmtTime, fmtDuration } from './util.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  }
  return node;
}

export function clear(node) {
  // replaceChildren rather than a removeChild loop: a field's own change handler
  // can trigger a re-render while the event is still dispatching on one of these
  // nodes, and removeChild throws once the node has already been detached.
  node.replaceChildren();
  return node;
}

/* ------------------------------------------------------- schema controls */

/**
 * Renders a list of field descriptors against a config object.
 * `onChange(key, value)` is called after the config has been mutated; the whole
 * field list re-renders so `showIf` dependencies resolve.
 */
export function buildFields(container, schema, cfg, onChange) {
  const hasConditionals = schema.some((s) => s.showIf);
  const render = () => {
    clear(container);
    for (const f of schema) {
      if (f.showIf && !f.showIf(cfg)) continue;
      container.append(buildField(f, cfg, (key, value) => {
        cfg[key] = value;
        onChange(key, value);
        // Re-render after the current event finishes dispatching, so the input
        // that fired it is not torn out from under the browser.
        if (hasConditionals) queueMicrotask(render);
      }));
    }
  };
  render();
  return render;
}

function buildField(f, cfg, set) {
  const value = cfg[f.key];

  if (f.type === 'checkbox') {
    const input = el('input', {
      type: 'checkbox',
      id: `f-${f.key}`,
      onchange: (e) => set(f.key, e.target.checked),
    });
    input.checked = !!value;
    return el('label', { class: 'field row-field', title: f.hint }, [el('span', { text: f.label }), input]);
  }

  if (f.type === 'select') {
    const select = el('select', {
      id: `f-${f.key}`,
      onchange: (e) => set(f.key, e.target.value),
    }, f.options.map((o) => el('option', { value: o.value, text: o.label })));
    select.value = String(value);
    return el('label', { class: 'field', title: f.hint }, [el('span', { text: f.label }), select]);
  }

  const input = el('input', {
    type: 'number',
    id: `f-${f.key}`,
    min: f.min,
    max: f.max,
    step: f.step ?? 'any',
    value: String(value),
    onchange: (e) => {
      const n = Number(e.target.value);
      if (Number.isFinite(n)) set(f.key, n);
      else e.target.value = String(cfg[f.key]);
    },
  });
  return el('label', { class: 'field', title: f.hint }, [el('span', { text: f.label }), input]);
}

/** One collapsible card per signal rule, generated from the registry. */
export function buildRuleControls(container, cfg, onChange) {
  clear(container);
  for (const rule of RULES) {
    const rc = cfg.rules[rule.id];
    const card = el('div', { class: `rule${rc.enabled ? '' : ' off'}` });

    const toggle = el('input', {
      type: 'checkbox',
      'aria-label': `Enable ${rule.label}`,
      onchange: (e) => {
        rc.enabled = e.target.checked;
        card.classList.toggle('off', !rc.enabled);
        onChange();
      },
      onclick: (e) => e.stopPropagation(),
    });
    toggle.checked = rc.enabled;

    const head = el('div', {
      class: 'rule-head',
      onclick: () => card.classList.toggle('open'),
    }, [toggle, el('strong', { text: rule.label }), el('span', { class: 'chev', text: '▾' })]);

    const body = el('div', { class: 'rule-body' });
    body.append(el('p', { class: 'rule-desc', text: rule.description }));

    const out = el('output', { text: rc.weight.toFixed(1) });
    const weight = el('input', {
      type: 'range', min: 0, max: 2, step: 0.1, value: String(rc.weight),
      'aria-label': `${rule.label} weight`,
      oninput: (e) => {
        rc.weight = Number(e.target.value);
        out.textContent = rc.weight.toFixed(1);
        onChange();
      },
    });
    body.append(el('div', { class: 'weight-row' }, [el('span', { text: 'Weight' }), weight, out]));

    for (const [key, spec] of Object.entries(rule.params)) {
      const input = el('input', {
        type: 'number', min: spec.min, max: spec.max, step: spec.step,
        value: String(rc.params[key]),
        onchange: (e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) { rc.params[key] = n; onChange(); }
          else e.target.value = String(rc.params[key]);
        },
      });
      body.append(el('label', { class: 'field' }, [el('span', { text: spec.label }), input]));
    }

    card.append(head, body);
    container.append(card);
  }
}

/* ------------------------------------------------------------- renderers */

const cls = (v) => (v > 0 ? 'good' : v < 0 ? 'bad' : '');

function stat(label, value, sub, tone = '') {
  return el('div', { class: 'stat' }, [
    el('div', { class: 'label', text: label }),
    el('div', { class: `value ${tone}`, text: value }),
    sub ? el('div', { class: 'sub', text: sub }) : null,
  ]);
}

export function renderStats(container, result, buyHold) {
  clear(container);
  if (!result || !result.stats.trades) {
    container.append(el('p', {
      class: 'empty',
      text: result
        ? 'The strategy took no trades over this range. Loosen the threshold, enable more rules, or load a longer range.'
        : 'Load data and run a backtest to see performance.',
    }));
    return;
  }
  const s = result.stats;
  const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');

  container.append(
    stat('Net P&L', fmtMoney(s.netProfit), fmtPct(s.netProfitPct), cls(s.netProfit)),
    stat('Buy & hold', fmtPct(buyHold?.returnPct ?? NaN), 'same range', cls(buyHold?.returnPct ?? 0)),
    stat('Trades', String(s.trades), `${s.wins}W / ${s.losses}L`),
    stat('Win rate', `${n(s.winRate, 1)}%`, `payoff ${n(s.payoff)}`),
    stat('Profit factor', s.profitFactor === Infinity ? '∞' : n(s.profitFactor), 'gross win / gross loss', cls(s.profitFactor - 1)),
    stat('Expectancy', `${n(s.expectancyR)}R`, fmtMoney(s.expectancy) + ' / trade', cls(s.expectancyR)),
    stat('Max drawdown', fmtMoney(-s.maxDrawdown), `${n(s.maxDrawdownPct, 1)}% · ${fmtDuration(s.longestDrawdownMs)}`, s.maxDrawdown > 0 ? 'bad' : ''),
    stat('Sharpe', n(s.sharpe), `Sortino ${n(s.sortino)}`, cls(s.sharpe)),
    stat('Avg hold', `${n(s.avgHoldBars, 1)} bars`, fmtDuration(s.avgHoldMs)),
    stat('Exposure', `${n(s.exposurePct, 1)}%`, 'bars in market'),
    stat('Fees paid', fmtMoney(-s.fees), `${result.config.feeBps} bps/side`),
    stat('Streaks', `${s.maxConsecWins}W / ${s.maxConsecLosses}L`, 'longest run'),
  );

  if (result.warnings?.length) {
    container.append(el('div', { class: 'warnings' }, [
      el('strong', { text: 'Read this before trusting the numbers' }),
      el('ul', {}, result.warnings.map((w) => el('li', { text: w }))),
    ]));
  }
}

export function renderSegments(container, result) {
  clear(container);
  if (!result?.segments) return;
  const { inSample, outOfSample } = result.segments;
  const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const row = (name, s) => el('tr', {}, [
    el('td', { text: name }),
    el('td', { text: String(s.trades) }),
    el('td', { text: `${n(s.winRate, 1)}%` }),
    el('td', { class: cls(s.netProfit), text: fmtMoney(s.netProfit) }),
    el('td', { text: s.profitFactor === Infinity ? '∞' : n(s.profitFactor) }),
    el('td', { class: cls(s.expectancyR), text: `${n(s.expectancyR)}R` }),
    el('td', { text: `${n(s.maxDrawdownPct, 1)}%` }),
  ]);

  container.append(
    el('h3', { class: 'table-title', text: 'In-sample vs out-of-sample' }),
    el('table', { class: 'segment-table' }, [
      el('thead', {}, el('tr', {}, ['Segment', 'Trades', 'Win rate', 'Net P&L', 'PF', 'Expectancy', 'Max DD']
        .map((h) => el('th', { text: h })))),
      el('tbody', {}, [row('In-sample', inSample), row('Out-of-sample', outOfSample)]),
    ]),
    el('p', {
      class: 'note',
      text: 'Parameters tuned until the in-sample numbers look good will usually not survive the out-of-sample half. '
        + 'A large gap between the two rows is the warning sign.',
    }),
  );
}

export function renderTrades(container, trades, decimals, onSelect) {
  clear(container);
  if (!trades?.length) {
    container.append(el('p', { class: 'empty', text: 'No trades yet.' }));
    return;
  }
  const head = ['#', 'Side', 'Signal', 'Entry', 'Exit', 'Price in', 'Price out', 'Qty', 'P&L', 'R', 'Bars', 'Exit reason', 'Equity'];
  const body = el('tbody');
  for (const t of trades) {
    body.append(el('tr', {
      onclick: () => onSelect?.(t),
      style: 'cursor:pointer',
    }, [
      el('td', { text: String(t.id) }),
      el('td', {}, el('span', { class: `pill ${t.side}`, text: t.side })),
      el('td', { text: t.label || t.type, title: (t.reasons || []).join(' · ') }),
      el('td', { text: fmtTime(t.entryTime, true) }),
      el('td', { text: fmtTime(t.exitTime, true) }),
      el('td', { text: t.entryPrice.toFixed(decimals) }),
      el('td', { text: t.exitPrice.toFixed(decimals) }),
      el('td', { text: fmtVol(t.qty, 3) }),
      el('td', { class: cls(t.pnl), text: fmtMoney(t.pnl) }),
      el('td', { class: cls(t.r), text: Number.isFinite(t.r) ? t.r.toFixed(2) : '—' }),
      el('td', { text: String(t.bars) }),
      el('td', { text: t.exitReason }),
      el('td', { text: fmtMoney(t.equityAfter, 0) }),
    ]));
  }
  container.append(el('table', {}, [
    el('thead', {}, el('tr', {}, head.map((h) => el('th', { text: h })))),
    body,
  ]));
}

export function renderSignalFeed(container, signals, decimals, onSelect) {
  clear(container);
  if (!signals?.length) {
    container.append(el('p', { class: 'empty', text: 'No signals fired with the current rules. Lower the threshold or enable more rules.' }));
    return;
  }
  for (const s of [...signals].reverse()) {
    container.append(el('div', {
      class: 'feed-item',
      onclick: () => onSelect?.(s),
      style: 'cursor:pointer',
    }, [
      el('time', { datetime: new Date(s.time).toISOString(), text: fmtTime(s.time, true).slice(5) }),
      el('span', {}, el('span', { class: `pill ${s.side}`, text: s.side })),
      el('span', { class: 'why', text: `${s.label} — ${s.reasons.join('; ')}` }),
      el('span', { class: 'score', text: `${s.price.toFixed(decimals)} · ${s.score}` }),
    ]));
  }
}

export function renderBreakdown(container, result) {
  clear(container);
  if (!result?.trades.length) {
    container.append(el('p', { class: 'empty', text: 'Run a backtest to see the per-rule breakdown.' }));
    return;
  }
  const n = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
  const table = (title, rows, keyLabel) => {
    const body = el('tbody');
    for (const r of rows) {
      body.append(el('tr', {}, [
        el('td', { text: String(r.key) }),
        el('td', { text: String(r.trades) }),
        el('td', { text: `${n(r.winRate, 1)}%` }),
        el('td', { class: cls(r.netProfit), text: fmtMoney(r.netProfit) }),
        el('td', { text: r.profitFactor === Infinity ? '∞' : n(r.profitFactor) }),
        el('td', { class: cls(r.expectancyR), text: `${n(r.expectancyR)}R` }),
      ]));
    }
    return el('div', {}, [
      el('h3', { class: 'table-title', text: title }),
      el('table', {}, [
        el('thead', {}, el('tr', {}, [keyLabel, 'Trades', 'Win rate', 'Net P&L', 'PF', 'Expectancy'].map((h) => el('th', { text: h })))),
        body,
      ]),
    ]);
  };

  container.append(
    table('By signal', result.byType, 'Rule combination'),
    table('By direction', result.bySide, 'Side'),
    table('By exit reason', result.byExit, 'Exit'),
  );
}

export function renderKv(container, entries) {
  clear(container);
  for (const [k, v] of entries) {
    container.append(el('dt', { text: k }), el('dd', { text: v }));
  }
}

/* --------------------------------------------------------------- tooltip */

export function renderTooltip(node, hover, ctx) {
  if (!hover) {
    node.hidden = true;
    return;
  }
  const { bar, row, rowIndex } = hover;
  const { decimals, signals } = ctx;
  const sig = signals.find((s) => s.barIndex === hover.barIndex);

  const dl = el('dl');
  const add = (k, v) => dl.append(el('dt', { text: k }), el('dd', { text: v }));
  add('Time', fmtTime(bar.openTime, true));
  add('OHLC', `${bar.open.toFixed(decimals)} / ${bar.high.toFixed(decimals)} / ${bar.low.toFixed(decimals)} / ${bar.close.toFixed(decimals)}`);
  add('Volume', fmtVol(bar.volume, 2));
  add('Delta', `${fmtSigned(bar.delta, 2)} (${(bar.deltaPct * 100).toFixed(1)}%)`);
  add('Δ range', `${fmtSigned(bar.minDelta, 1)} … ${fmtSigned(bar.maxDelta, 1)}`);
  add('Cum Δ', fmtSigned(bar.cumDelta, 2));
  add('POC', bar.pocPrice?.toFixed(decimals) ?? '—');
  add('Value area', `${bar.valPrice?.toFixed(decimals)} – ${bar.vahPrice?.toFixed(decimals)}`);
  add('Trades', String(bar.trades));

  if (row) {
    const im = bar.imbalances?.get(rowIndex);
    add('— row —', `${(rowIndex * bar.rowSize).toFixed(decimals)}`);
    add('Bid × Ask', `${fmtVol(row.bid, 2)} × ${fmtVol(row.ask, 2)}`);
    add('Row Δ', fmtSigned(row.ask - row.bid, 2));
    if (im?.buy || im?.sell) add('Imbalance', im.buy ? 'buy' : 'sell');
  }

  clear(node);
  node.append(el('h4', { text: `${ctx.symbol} · ${ctx.interval}` }), dl);
  if (sig) {
    node.append(el('div', { style: 'margin-top:6px' }, [
      el('span', { class: `pill ${sig.side}`, text: sig.side }),
      el('span', { text: ` ${sig.label}` }),
      el('ul', { class: 'reasons' }, sig.reasons.map((r) => el('li', { text: r }))),
    ]));
  }
  node.hidden = false;

  // Keep the tooltip inside the canvas box.
  const wrap = node.parentElement.getBoundingClientRect();
  const w = node.offsetWidth;
  const h = node.offsetHeight;
  let x = hover.x + 16;
  let y = hover.y + 16;
  if (x + w > wrap.width - 8) x = hover.x - w - 16;
  if (y + h > wrap.height - 8) y = Math.max(8, hover.y - h - 16);
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
}

export function setupTabs(root) {
  for (const nav of root.querySelectorAll('.tabs')) {
    const scope = nav.parentElement;
    nav.addEventListener('click', (e) => {
      const tab = e.target.closest('.tab');
      if (!tab) return;
      for (const t of nav.querySelectorAll('.tab')) {
        const on = t === tab;
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', String(on));
      }
      for (const p of scope.querySelectorAll(':scope > .tab-panel')) {
        p.classList.toggle('active', p.id === tab.dataset.tab);
      }
      scope.dispatchEvent(new CustomEvent('tabchange', { detail: tab.dataset.tab, bubbles: true }));
    });
  }
}
