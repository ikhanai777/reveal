// Alert payload formatting for each delivery channel.

const fmtPrice = (v) => (Number.isFinite(v) ? v.toLocaleString('en-US', { maximumFractionDigits: 6 }) : '—');
const pct = (v) => `${(v * 100).toFixed(2)}%`;

/** Canonical JSON contract for the REST/WebSocket alerting API. */
export function toJsonPayload(signal, { schema = 'scanner.signal.v1' } = {}) {
  return {
    schema,
    id: signal.id,
    ts: signal.ts,
    symbol: signal.symbol,
    venue: signal.venue,
    timeframe: signal.timeframe,
    bias: signal.bias,
    direction: signal.direction > 0 ? 'LONG' : 'SHORT',
    confidence: Math.round(signal.scs),
    entry: { low: signal.entry.low, high: signal.entry.high, mid: signal.entry.mid, anchor: signal.entry.anchor },
    stopLoss: signal.stop,
    takeProfits: signal.targets.map((t) => ({ name: t.name, price: t.price, sizePct: t.size, rr: +t.rr.toFixed(2) })),
    riskPct: signal.risk / signal.entry.mid,
    scoreBreakdown: Object.fromEntries(signal.scoreBreakdown.map((b) => [b.key, b.scaled == null ? null : +b.scaled.toFixed(1)])),
    strategy: signal.strategy,
  };
}

/** Telegram accepts a subset of HTML; keep the tag set to what it documents. */
export function toTelegram(signal) {
  const dirTag = signal.direction > 0 ? '🟢 LONG' : '🔴 SHORT';
  const lines = [
    `<b>${dirTag} ${escapeHtml(signal.symbol)}</b> · ${escapeHtml(signal.timeframe)}`,
    `Confidence <b>${Math.round(signal.scs)}/100</b> (${escapeHtml(signal.bias.replace('_', ' '))})`,
    '',
    `Entry <code>${fmtPrice(signal.entry.low)} – ${fmtPrice(signal.entry.high)}</code> (${escapeHtml(signal.entry.anchor)})`,
    `Stop  <code>${fmtPrice(signal.stop)}</code> · risk ${pct(signal.risk / signal.entry.mid)}`,
    ...signal.targets.map((t) => `${t.name}   <code>${fmtPrice(t.price)}</code> · ${Math.round(t.size * 100)}% · ${t.rr.toFixed(1)}R`),
    '',
    '<b>Score breakdown</b>',
    ...signal.scoreBreakdown.map((b) => `${escapeHtml(b.label)}: ${b.scaled == null ? 'n/a' : b.scaled.toFixed(0)}`),
  ];
  return { parse_mode: 'HTML', text: lines.join('\n'), disable_web_page_preview: true };
}

/** Discord embed card. */
export function toDiscord(signal) {
  const bull = signal.direction > 0;
  return {
    embeds: [{
      title: `${bull ? '🟢' : '🔴'} ${signal.bias.replace('_', ' ')} — ${signal.symbol}`,
      description: `Signal confidence **${Math.round(signal.scs)}/100** · ${signal.timeframe} · ${signal.venue}`,
      color: bull ? 0x3fbf7f : 0xe0576e,
      timestamp: new Date(signal.ts).toISOString(),
      fields: [
        { name: 'Entry', value: `\`${fmtPrice(signal.entry.low)} – ${fmtPrice(signal.entry.high)}\`\n${signal.entry.anchor}`, inline: true },
        { name: 'Stop', value: `\`${fmtPrice(signal.stop)}\`\nrisk ${pct(signal.risk / signal.entry.mid)}`, inline: true },
        { name: 'Targets', value: signal.targets.map((t) => `${t.name} \`${fmtPrice(t.price)}\` · ${Math.round(t.size * 100)}% · ${t.rr.toFixed(1)}R`).join('\n'), inline: false },
        { name: 'Breakdown', value: signal.scoreBreakdown.map((b) => `${b.label}: **${b.scaled == null ? 'n/a' : b.scaled.toFixed(0)}**`).join('\n'), inline: false },
      ],
      footer: { text: `${signal.id} · ${signal.strategy}` },
    }],
  };
}

/** Plain text for terminals, SMS and log lines. */
export function toText(signal) {
  return [
    `${signal.direction > 0 ? 'LONG' : 'SHORT'} ${signal.symbol} ${signal.timeframe} | SCS ${Math.round(signal.scs)}`,
    `entry ${fmtPrice(signal.entry.low)}-${fmtPrice(signal.entry.high)} stop ${fmtPrice(signal.stop)}`,
    signal.targets.map((t) => `${t.name} ${fmtPrice(t.price)}`).join(' '),
    signal.id,
  ].join(' | ');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

export const FORMATTERS = { json: toJsonPayload, telegram: toTelegram, discord: toDiscord, text: toText };
