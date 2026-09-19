# Scanner — quantitative crypto signal engine

A working implementation of the scanner spec: market-data ingestion, order-flow
and footprint analytics, a multi-factor signal matrix, an event-driven
backtester with walk-forward and Monte Carlo validation, a tamper-evident signal
log, and webhook delivery.

It is a static site with no build step and no dependencies. Open
`scanner/index.html` from any static server, or run the engines headlessly under
Node — they share one implementation, so a backtested rule and a live signal
come from the same code.

```bash
node scanner/test/run.js      # 156 tests, no dependencies
npx http-server -p 8099 .     # then open http://127.0.0.1:8099/scanner/
```

The dashboard starts on a deterministic simulated venue, so every panel is
populated on load without a network connection.

## Layout

```
scanner/
  index.html  styles.css
  js/
    core/        bus, ring buffers, timeframes, hash chain, persistence, math
    ingest/      venue adapters, reconnecting socket, L2 book sync, rate limits
    engines/     candles, indicators, structure, footprint, CVD, VPVR, book,
                 TA / order-flow / derivatives / sentiment / ML factor scorers
    signal/      SCS matrix, risk & trade planning, lifecycle tracker
    backtest/    event-driven engine, slippage & fees, metrics, walk-forward,
                 Monte Carlo
    delivery/    payload formatting, webhook dispatch with retry
    ui/          canvas charts, panels, DOM helpers
  test/          zero-dependency harness + suites
```

Everything talks over one event bus (`core/bus.js`). That is what lets the
backtester swap a replay feed in for live WebSockets without any engine knowing
the difference.

## What each spec section maps to

| Spec | Where | Notes |
|---|---|---|
| Exchange WS/REST ingestion | `ingest/binance.js`, `socket.js`, `bookbuilder.js` | Spot + USD-M futures. Public endpoints only, no keys. |
| L2 book sync | `ingest/bookbuilder.js` | Snapshot + diff with the documented continuity check; a gap forces a resync rather than serving a book with holes. |
| Rate-limit buckets | `ingest/ratelimit.js` | Weighted token bucket, serialized, with jittered reconnect backoff. |
| OHLCV rollups | `engines/candles.js` | 1s–1d from one tick stream. |
| TA module | `engines/indicators.js`, `ta.js` | EMA ribbon 8/21/55/200, MACD, ADX, RSI + divergence, Bollinger squeeze/expansion, ATR. |
| Market structure | `engines/structure.js` | Fractal swings, FVG with fill state, MSB and ChoCh. |
| Footprint | `engines/footprint.js` | Per-price bid×ask ladders, candle delta, diagonal imbalances, stacks. |
| VPVR | `engines/vpvr.js` | POC, VAH/VAL by the standard expansion rule, HVN/LVN, session profile. |
| CVD | `engines/cvd.js` | Cumulative delta and multi-timeframe divergence. |
| Order book imbalance | `engines/orderbook.js` | Depth-weighted OBI, liquidity walls, spoof vs absorption. |
| Derivatives / on-chain | `engines/derivatives.js` | Funding regimes, OI quadrants, both squeeze conditions, unlocks, SSR. |
| News & sentiment | `engines/sentiment.js` | Pluggable classifier with a deterministic lexicon fallback, keyword triggers, social velocity. |
| ML forecast | `engines/forecast.js` | Online multinomial logistic over 13 features, P(up/side/down) per horizon. |
| SCS matrix | `signal/scoring.js` | 25/30/15/15/15 weights, the threshold ladder, confirmation gates, regime filters. |
| Risk & targets | `signal/risk.js` | POC/FVG entry zone, ATR×1.5 or structural stop, TP1 1.5R → breakeven, TP2 at the next volume node, TP3 trailed. |
| Signal tracker | `signal/tracker.js` | Full lifecycle, MFE/MAE, slippage drift, hash-chained log. |
| Backtester | `backtest/engine.js` | Event-driven, quadratic slippage, maker/taker tiers, 8h funding. |
| Metrics | `backtest/metrics.js` | Sharpe, Sortino, Calmar, drawdown depth and duration, monthly returns, trade stats. |
| Walk-forward | `backtest/walkforward.js` | 70/30 rolling windows, weight search, out-of-sample efficiency. |
| Monte Carlo | `backtest/montecarlo.js` | 1,000 reshuffles, drawdown confidence bands, risk of ruin. |
| Delivery | `delivery/` | JSON/Discord/Telegram payloads, retry and dead-lettering. |

## Design decisions worth knowing

**A factor with no data abstains; it does not vote neutral.** If the
derivatives feed is absent or the ML model is untrained, that factor is excluded
and its weight is redistributed across the factors that did report. Scoring it
as a neutral 50 would spend 15% of the matrix on an opinion nobody holds and
mute every factor that has one — in testing this alone took a run from 74 trades
to 3.

**Position size is computed against the price actually filled.** Sizing on the
intended entry and only then applying market impact understates risk badly when
the stop is tight: a 2% slip against a 0.1% stop produced losses 27× the
intended risk budget. The engine now sizes, slips, re-sizes, and rejects any
setup whose expected slippage exceeds a quarter of the stop distance.

**A structural stop more than 3 ATR away is not structural.** The last confirmed
swing can be hundreds of bars back; a stop out there is just an enormous stop,
so past the cap the plan falls back to the ATR stop.

**Direction is blue/red, not green/red.** The conventional trading pair
separates by ΔE 3.7 under deuteranopia — indistinguishable. Blue/red clears
every colour gate in both themes. Direction is also always written out in words
beside the colour. A "Classic R/G" toggle restores the convention for anyone who
wants it.

**CAGR is suppressed below a 30-day span.** Annualizing four days of return
gives numbers like +722,000%, which is arithmetic rather than information.

**The log is tamper-evident, not tamper-proof.** Entries are hash-chained so an
edit to history fails verification, which catches accidental and casual
modification. The digest is a fast non-cryptographic hash chosen so it runs
synchronously everywhere; `chainEntry` takes the digest as an argument, so
swapping in a server-signed HMAC is a one-line change if you need to resist a
motivated attacker.

## What needs infrastructure beyond the browser

These are implemented as documented interfaces with working fallbacks, because a
browser cannot do the real thing:

- **LLM sentiment.** `SentimentEngine.setClassifier(fn)` accepts any async
  scorer. The built-in lexicon is the deterministic fallback so the factor still
  contributes offline and under test.
- **TFT / XGBoost forecasting.** The shipped model is an online logistic
  classifier that learns from realized outcomes and is useful from a cold start.
  `RemoteForecaster` is the adapter for a served model — same interface.
- **On-chain metrics.** `SymbolEngine.onchain` accepts exchange net flows,
  active addresses, SSR and unlock schedules; wire a Glassnode/CryptoQuant
  poller to the `md:chain` topic.
- **Telegram and Discord bots.** A page served to a browser cannot keep a bot
  token secret, and cannot set custom headers cross-origin without the
  destination's cooperation. The `relay` destination type posts the signal JSON
  to your own backend, which holds the credentials and fans out. Direct
  destinations work for a single operator on their own machine.
- **Multi-venue aggregation.** The normalizer and bus are venue-neutral and the
  adapter interface is small; only Binance is implemented.

## Verification

`node scanner/test/run.js` runs 156 tests covering indicator arithmetic against
known values, footprint imbalance rules, VPVR value-area construction, book
continuity and resync, the threshold ladder and its confirmation gates, the full
signal lifecycle including hash-chain tampering, execution realism, metrics,
walk-forward splitting and Monte Carlo, plus an end-to-end pass from synthetic
ticks through to a scored evaluation.

The dashboard was driven in a real browser (load, backtest, Monte Carlo, theme
switch, 390px viewport) with no console errors.

**The live exchange path is unverified.** Binance is blocked from the network
this was built on, so `BinanceAdapter`'s socket handshake and REST calls have
never run against the real venue. Its protocol-level pieces — symbol
normalization, book snapshot/diff continuity for both the spot and futures
rules, rate limiting, reconnect backoff — are unit-tested against the documented
message shapes, but treat the first live connection as untested code.

Backtest numbers produced on the simulated venue describe the machinery, not an
edge. The generator is a regime-switching random walk; any profit it shows is a
property of that random walk.
