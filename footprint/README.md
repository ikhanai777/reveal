# Footprint Terminal

A standalone volume-footprint charting app for Binance spot markets, with a
footprint-native signal provider and a backtester. Everything runs in the
browser — no build step, no server, no API key.

Open `index.html` over HTTP (`npx serve .`, `python3 -m http.server`, GitHub
Pages, any static host). Opening it as a `file://` URL will not work, because
the app is made of ES modules.

---

## What a footprint bar is here

A footprint bar is an OHLC candle plus, for every price row inside it, the
volume that traded **into the bid** versus **into the ask**. Every derived
measure comes from that split.

Trade classification uses Binance's `m` flag on aggregated trades ("was the
buyer the maker"):

| `m`     | Aggressor | Volume lands on |
| ------- | --------- | --------------- |
| `true`  | seller    | **bid**         |
| `false` | buyer     | **ask**         |

From that the app computes, per bar:

- **Delta** — ask volume minus bid volume, plus the running delta's high-water
  and low-water marks inside the bar, and cumulative delta across the series.
- **POC** — the heaviest price row.
- **Value area** — the rows around the POC holding 70% of bar volume (grown in
  pairs, always taking the heavier side, the standard construction).
- **Diagonal imbalances** — ask at row *N* against bid at row *N−1*. A ratio at
  or above the threshold (3× by default) marks the row.
- **Stacks** — runs of three or more consecutive imbalanced rows in the same
  direction.

### Row size

One exchange tick per row is unusable on a high-priced instrument: BTCUSDT
moves hundreds of $0.10 ticks in a five-minute bar, which renders as a few
hundred sub-pixel rows. **Ticks per row = 0** (the default) measures the median
bar range in the loaded data and picks a row size giving a typical bar about
fourteen rows. Set a number to override it.

---

## Data

Public, unauthenticated endpoints only:

- `GET /api/v3/exchangeInfo` — tick size and symbol list
- `GET /api/v3/aggTrades` — the trade stream the footprint is built from
- `wss://…/<symbol>@aggTrade` — live mode

Requests go to `data-api.binance.vision` first and fall back through the
`api*.binance.com` hosts on a network error, since some regions block some of
them. Requests are spaced ~110 ms apart, which keeps a sustained backfill at
roughly a third of the 6000 weight/minute IP budget, and `429`/`418` responses
are honoured with their `Retry-After`.

`aggTrades` rejects a `startTime`/`endTime` pair more than an hour apart, so a
range is seeded with a sub-hour window and then paged by trade id — cheaper and
immune to timestamp ties.

**Caching.** Fully-elapsed clock hours are cached in IndexedDB in columnar form
(~25 bytes/trade). Re-running a backtest over the same range costs no requests.
The in-progress hour is never cached. The cache is per-browser and never leaves
the machine; clear it from the **Data** tab.

**Cost.** A busy symbol produces roughly 30k aggregated trades an hour, so a
day of BTCUSDT is several hundred requests and a minute or two on the first
load. Start with a few hours.

---

## Signals

Seven rules, each a pure function of `bars[0..i]`. Nothing reads `bars[i+1..]`,
so what the backtester sees is what a live trader would have seen at that bar's
close. A test asserts this directly: signals generated over a prefix of the
data must match the signals the full run produced over those same bars.

| Rule | Fires on |
| --- | --- |
| **Stacked imbalance** | 3+ consecutive diagonal imbalances at one end of the bar |
| **Delta divergence** | New swing extreme that delta fails to confirm |
| **Absorption** | Outsized one-sided node at the extreme that price refuses to follow |
| **Trapped aggressors** | Heavy one-sided delta closing on the wrong end of the range |
| **Exhaustion tail** | New extreme printed on almost no volume at the tip |
| **Value migration** | POC stepping one way for several bars with cumulative delta agreeing |
| **Delta flip** | Delta reversing sign inside the prior bar's value area |

Each rule returns a side and a strength in `[0,1]`, and carries its own
parameters and a weight. Two combination modes:

- **Composite** — weighted vote across rules; a signal fires when
  `|long − short|` clears the threshold.
- **Any** — every rule that fires emits its own signal.

On top: a per-side cooldown, an optional EMA trend filter (with or against),
and a minimum volume z-score.

---

## Backtesting

The execution model, stated plainly, because every one of these assumptions
either flatters or punishes the result:

- A signal is produced at the **close of bar `i`** and filled at the **open of
  bar `i+1`**. "At signal close" exists but is an optimistic fill.
- Entries and market exits pay `slippageTicks`; limit targets fill at the
  target price exactly.
- When a bar's range contains **both** the stop and the target, the order they
  were hit in is unknowable from bar data. **Pessimistic fills** (on by
  default) assume the stop went first. Turning it off flatters every result —
  it is there to measure the size of that ambiguity, not to produce a better
  number.
- A gap through a stop fills at the open, not at the stop price.
- One position at a time; no pyramiding.
- Fees are charged per side (10 bps by default — Binance spot taker, no
  discount) and settled when the trade closes.

Stops: ATR multiple, fixed ticks, percent, or the signal bar's extreme.
Targets: R multiple, ATR, ticks, percent, or none. Trailing: off, ATR, prior
bar extreme, or breakeven at *n*R. Plus a time stop and an exit-on-opposite-
signal option.

### What the results tell you

Reported against buy-and-hold over the same range: net P&L, win rate, profit
factor, expectancy in R and in currency, max drawdown (chosen by percentage,
with the absolute figure from that same episode), Sharpe and Sortino from
per-bar mark-to-market returns, exposure, streaks, and breakdowns by rule, by
direction and by exit reason.

Set an **in-sample split** to see the two halves separately. Parameters tuned
until the in-sample numbers look good usually do not survive the out-of-sample
half; a large gap between the two rows is the warning sign.

The **Performance** tab also surfaces warnings the numbers alone would hide:

- Positions clipped by the max-notional cap. Risk-% sizing with a tight stop
  asks for more notional than an unlevered account has; clipping is correct but
  it quietly shrinks the real risk per trade, so the result no longer reflects
  the risk model you configured.
- Trades paying more than half their risk in fees.
- Samples too small to conclude anything from.

---

## Chart

Canvas, drawn from scratch. Bid volume is always the **left** half of a cell
and ask volume the **right**, and both print their number — that positional and
numeric encoding is what keeps the classic green/red pair legible to
colour-blind readers. **Shift-click the theme button** for a blue/orange
palette that separates on hue alone (validated at ΔE 28+ under protan, deutan
and tritan simulation, against both surfaces).

Cell modes: bid × ask, delta, or profile. Overlays: imbalance rails, stack
brackets, POC, value area, signal markers, and backtest trades drawn entry to
exit. Footer rows carry delta, volume and cumulative delta per bar.

| Input | Action |
| --- | --- |
| drag | pan |
| wheel | scroll through time |
| alt + wheel | column width |
| shift / ctrl + wheel | row height |
| double-click, or `f` | fit |
| `l` | toggle live |
| `r` | run backtest |

---

## Live mode

**Go live** opens the `@aggTrade` websocket and appends to the in-progress bar,
reconnecting with backoff and rotating hosts. Signals are re-scored when a bar
closes, never on the unclosed bar.

---

## Tests

```
npm test          # or: node --test "test/**/*.test.mjs"
```

50 tests over the DOM-free half — footprint construction, indicators, the
signal provider and the backtester's accounting — all against synthetic trades,
so no network is needed. They cover:

- bars reconciling against the trades that built them; row volumes summing to
  bar volume; classification following the maker flag
- POC, value area, imbalance and stack construction
- streaming trade-by-trade matching a bulk rebuild
- **no lookahead** in the signal provider
- **a per-rule trigger proof** — each rule gets a hand-built series that
  provably exhibits its pattern, so a rule cannot quietly stop firing while the
  aggregate tests still pass
- equity reconciling to `initial + Σ P&L`, non-overlapping trades, stops and
  targets landing on the correct side of entry, and monotonicity checks
  (pessimistic fills never beat optimistic ones; higher fees never help)

---

## Files

```
index.html          layout
styles.css          both themes, both bid/ask palettes
js/
  app.js            wiring: load → build → signal → backtest → render
  binance.js        REST client (host fallback, rate limiting, id paging) + websocket
  cache.js          IndexedDB trade cache
  data.js           range loading: cache + backfill
  footprint.js      the bar model — rows, delta, POC, value area, imbalances
  indicators.js     ATR, SMA/EMA, rolling z-scores, pivots
  signals.js        the rule registry and the provider
  backtest.js       execution engine
  stats.js          performance metrics
  chart.js          footprint canvas renderer
  linechart.js      equity curve
  ui.js             schema-driven controls and result renderers
  util.js           formatting and small helpers
```

---

## A caveat worth stating

This is an analysis and research tool. Backtests on a few hours or days of
crypto data with a handful of trades say nothing about an edge, and the
defaults here have not been fitted to any market — they are starting points.
Read the warnings on the Performance tab before drawing conclusions, and treat
the out-of-sample split as the minimum bar, not the finish line.
