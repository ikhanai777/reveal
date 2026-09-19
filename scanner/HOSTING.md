# Running the scanner locally

A runbook precise enough to hand to a local coding agent (Nous Hermes or
similar). Every step has a command, an expected result, and what to do when the
result differs. Follow them in order and stop at the first step whose check
fails.

## The one thing that breaks most attempts

**The page must be served over HTTP. Double-clicking `index.html` will not
work.** The app is built from ES modules, and browsers refuse to load modules
over the `file://` scheme — you get a blank page and a CORS error in the
console. Every step below exists to put a real HTTP server in front of it.

## Step 1 — Get the code

```bash
git clone https://github.com/ikhanai777/reveal.git
cd reveal
git checkout claude/crypto-scanner-signal-engine-04w4bi
```

Already cloned? `git fetch origin` then `git checkout claude/crypto-scanner-signal-engine-04w4bi`.

**Check:** `ls scanner` lists `index.html`, `styles.css`, `js`, `test`,
`README.md`, `HOSTING.md`. If `scanner` does not exist you are on the wrong
branch — run `git branch --show-current` and repeat the checkout.

## Step 2 — Pick a server

Try these in order and use the first one that is already installed. There is
nothing to build and nothing to install beyond the server itself.

**Check what you have:**

```bash
node --version      # want v18 or newer
python3 --version   # want 3.7 or newer  (on Windows: python --version)
```

### Option A — Node (preferred)

```bash
npx --yes http-server ./scanner -p 8099 -c-1
```

`-c-1` disables caching, so edits show up on reload. The first run downloads
`http-server`; answer yes if prompted.

### Option B — Python (no Node needed)

```bash
cd scanner
python3 -m http.server 8099
```

On Windows use `python -m http.server 8099`.

### Option C — Any other static server

Anything works, with two requirements:

- Serve the `scanner/` directory as the site root.
- Serve `.js` files with a JavaScript media type (`text/javascript` or
  `application/javascript`). A server that sends `text/plain` for `.js` will
  cause the browser to refuse the modules.

**Check:** the terminal prints something like `Available on:
http://127.0.0.1:8099`. Leave this terminal open — closing it stops the server.

## Step 3 — Open it

Go to **http://localhost:8099/** in a browser.

**Check — all five must be true within about ten seconds:**

1. The header reads "Scanner" with a "Stop simulated feed" button.
2. Under LIVE SCAN there are three tiles (BTC/USDT, ETH/USDT, SOL/USDT), each
   showing a two-digit number and a price.
3. PRICE & VOLUME PROFILE shows candlesticks, not an empty box.
4. FOOTPRINT shows a grid of cells reading `number × number`.
5. SCORE BREAKDOWN lists five factors with bars.

If the page is blank or half-populated, open the browser console
(F12 → Console) and match the error against **Troubleshooting** below.

## Step 4 — Confirm the engines (optional, needs Node)

```bash
node scanner/test/run.js
```

**Check:** the last line reads `156/156 passed`. This exercises the analytics,
scoring, risk and backtest code with no browser and no network.

## Step 5 — Exercise the backtester

In the BACKTEST & VALIDATION card at the bottom:

1. Leave History on "Synthetic (offline)", set Bars to `1200`.
2. Click **Run backtest**. Within a few seconds a status line reports the number
   of trades, and the metric tiles and equity curve fill in.
3. Click **Monte Carlo**. It reshuffles those trades 1,000 times and reports a
   drawdown confidence band.
4. Click **Walk-forward** for the 70/30 out-of-sample validation. This one is
   the slowest — give it up to a minute.

Nothing here touches the network.

## Step 6 — The live exchange feed (optional)

Set **Data source** to "Binance USD-M futures" and click **Apply**.

The browser connects straight to Binance's public WebSocket and REST endpoints.
No API key is used and no order can be placed — these are read-only public
market data endpoints.

**Check:** the status line under the controls turns to `open`, then
`book-synced`, and the tiles start moving.

**This path has never been tested against the real venue** — it was written on a
network where Binance was blocked. Treat the first connection as untested code.
If the status line shows `reconnecting` or `error`, the likely causes are:

- **Your region blocks Binance** (notably the US for `fapi.binance.com`). Try
  "Binance spot" instead, or stay on the simulated venue.
- **A VPN, firewall or extension is blocking WebSockets.** The status line
  reports `stale` or `reconnecting` with a backoff.
- **Rate limiting.** Reduce the symbol list to one symbol and click Apply.

The simulated venue keeps every panel and the whole backtester working with no
network at all, so a blocked exchange costs you the live tape and nothing else.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Blank page; console says `Failed to load module script` or `strict MIME type` | Opened as a file, or the server sends the wrong type for `.js` | Use Step 2. Do not open `index.html` directly. |
| Blank page; console mentions `CORS` and `file://` | Same as above | Same as above. |
| `EADDRINUSE` / "port already in use" | Something else holds 8099 | Use another port: `-p 8100`, then open `http://localhost:8100/` |
| 404 on every file | Serving the wrong directory | The server's root must be `scanner/`, not the repo root. Or serve the repo root and open `http://localhost:8099/scanner/`. |
| Page loads, tiles say `—` and never fill | JavaScript error during boot | Open the console and read the first red error. |
| Fonts look wrong | Google Fonts is blocked | Harmless — the page falls back to a system sans. |
| `node: command not found` | Node not installed | Use Option B (Python), or install Node 18+ from nodejs.org. |
| Backtest button does nothing | A run is already in progress | The buttons disable while running. Wait for the status line. |

## Notes for an agent driving this

- **Do not modify any file to make it run.** The app has no build step, no
  dependencies and no configuration. If it does not run, the problem is the
  server or the URL, never the source.
- **Do not run `npm install`.** There is no `package.json` and none is needed.
- The server must stay running in its own process. If your tooling runs commands
  and waits for them to finish, start the server in the background or in a
  separate terminal, otherwise you will block forever on Step 2.
- Ports, paths and the branch name above are literal. Do not substitute values.
- Verification is visual for Steps 3, 5 and 6. If you cannot see the page,
  report which step you reached and what the console said rather than guessing.
- Settings, the signal log and webhook destinations persist in the browser's
  `localStorage`, scoped to the origin. Changing the port changes the origin and
  gives you a fresh slate.
