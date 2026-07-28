# Backtester UI — Implementation Plan

Frontend-only strategy backtester for the Azure Market Data project. No new backend
endpoints; all simulation runs in the browser.

**Status:** implemented (2026-07-27). Route is live at `/backtest`; see
[§8 What shipped](#8-what-shipped) for the deltas against this plan.

---

## 0. The constraint that shapes everything

`/api/gamma` only returns the **current** snapshot.
[`GammaExposureController`](../API_Server/src/main/java/com/example/api_server/controller/GammaExposureController.java)
exposes one timestamp per symbol — there is no historical GEX endpoint. GEX and ML
strategies therefore **cannot** be backtested off the live API without backend work.

The frontend-only fix: the ML pipeline already produced bar-aligned historical GEX in
[`functions/ml/data/`](../functions/ml/data/) — `qqq_5m_features_h*.parquet` carries `date`
and all 22 baseline + GEX features per bar. Two corrections to the original assumption:

- The parquets **do not** carry OHLCV — `build_dataset.py` drops raw prices after computing
  features. The export script re-joins bars from `/api/historical`, which the engine needs
  to fill orders against.
- `rf_oos_predictions.parquet` is stale (500 rows, ends 2026-05-15). The export script
  re-fits the walk-forward RF over the whole current sample instead.

A one-off export script ([`functions/ml/export_backtest_data.py`](../functions/ml/export_backtest_data.py))
turns those into static JSON under `public/backtest/`. That is a data asset, not an endpoint.

This yields **two data planes**, surfaced as a dataset switcher in the UI:

| Plane | Source | Coverage | Powers |
|---|---|---|---|
| **Live** | `GET /api/historical?symbol&period&interval` | any symbol, 1m–1wk, up to 2y (see [`HistoricalDataService`](../API_Server/src/main/java/com/example/api_server/service/HistoricalDataService.java)) | TA strategies, custom rules |
| **Research** | static JSON exported from the parquets | QQQ 3,226 bars + SPY 3,115 bars, 5m, 2026-04-24 → 2026-07-10 | GEX strategies, ML signal, walk-forward |

The research plane is the differentiated part — historical GEX is not commercially
available at affordable prices, so this dataset is genuinely novel.

---

## 1. Stack

Scoped to the `/backtest` route so it does not disturb the existing 1055-line
[`globals.css`](app/globals.css).

| Library | Purpose |
|---|---|
| **tailwindcss v4** | CSS-first `@theme`, no config file. Import `theme.css` + `utilities.css` **only, not `preflight.css`** — preflight would reset the existing app's styles. |
| **@visx/\*** (scale, shape, axis, heatmap, gradient) | SVG primitives for equity / drawdown / heatmap / fan charts. Chosen over Recharts so the terminal aesthetic isn't fighting a themed component library. |
| **lightweight-charts** (already installed) | Price panel with trade markers via v5 `createSeriesMarkers`. |
| **framer-motion** | Staggered panel entry, `pathLength` equity-curve draw, metric count-ups. |
| **cmdk** | ⌘K palette — run, switch strategy, jump to param, load sweep cell. |
| **zustand** | Run state shared across ~10 panels without prop drilling. |
| **comlink** + Web Worker | Simulation off the main thread. Required for a 500-combination sweep; the honest way to do client-side compute at this scale. |
| **@tanstack/react-virtual** | Trade blotter virtualization. |
| **react-resizable-panels** | Draggable terminal column grid. |
| **JetBrains Mono + Inter** | Self-hosted via `next/font/local`. |

All dynamically imported so the dashboard bundle is untouched.

---

## 2. Design language — "quant research terminal"

- Canvas `#0B0C0E`, panels `#131519`, hairline borders `#22262D`
- Phosphor amber `#E8B339` primary; keeps the existing `#4A90A4` cyan and
  `#4caf50` / `#ff6b6b` P/L colors so it reads as a family member of the current app,
  not a bolt-on
- Every panel gets a 10px uppercase tracked label
- All numbers `tabular-nums`, right-aligned, fixed decimals
- Keyboard-first: `⌘K` palette, `R` run, `1–4` strategy family, `[` / `]` step the focused
  param, `?` shortcut sheet

```
┌──────────────────────────────────────────────────────────────────┐
│ TAPE  QQQ · 5m · 04-24→05-15 · 1,120 bars · 47ms · runs:12   ⌘K │
├──────────────┬───────────────────────────────┬───────────────────┤
│ STRATEGY     │  PRICE + TRADE MARKERS        │  METRICS          │
│  family      │  (lightweight-charts)         │  Sharpe Sortino   │
│  params      ├───────────────────────────────┤  MaxDD Hit PF     │
│  costs       │  EQUITY + DRAWDOWN (visx)     ├───────────────────┤
│  dataset     ├───────────────────────────────┤  COMPARE  A B C   │
│  ▸ RUN       │  Blotter │ Sweep │ WF │ MC    │                   │
└──────────────┴───────────────────────────────┴───────────────────┘
```

Resizable columns; stacks vertically under 1024px.

Route: `app/backtest/page.jsx`, with its own layout opting out of the `.app` max-width.
Linked from the dashboard header and the ticker page toolbar.

---

## 3. Engine — `frontend/lib/backtest/`

- **`engine.js`** — bar loop, position state machine, next-bar-open fills, slippage bps +
  commission, long/short/flat, stop / target / time exits
- **`metrics.js`** — Sharpe, Sortino, max DD + duration, hit rate, profit factor,
  expectancy, exposure, turnover
- **`strategies/*.js`** — each exports `{ id, label, params: [schema], signal(ctx) }`.
  **The param schema drives the form generically** — no hand-written UI per strategy, and
  the sweep panel reads the same schema to populate its axis dropdowns.
  - `gexWallFade` — short near call wall / long near put wall, gated by `above_zero_gamma`
  - `gexRegime` — trend-follow below zero-gamma, mean-revert above
  - `smaCross`, `bbReversion`, `vwapReversion` — reuse [`components/indicators.js`](components/indicators.js)
  - `mlSignal` — long/short on `rf_gex_pred` vs threshold θ, horizon exit
  - `custom` — interprets the rule-builder AST
- **`ruleAst.js`** — `Compare / And / Or / Not`; operands = indicator refs, GEX feature
  refs, constants, `crossesAbove` / `crossesBelow`
- **`worker.js`** — `runBacktest(config)` and `runSweep(config, grid)` with streaming progress

**Custom rule builder UI:** chip rows (`[operand ▾] [op ▾] [operand ▾]` joined by AND/OR
chips), not drag-and-drop — denser, more terminal-appropriate, and much faster to build.
Live-compiled pseudocode preview in mono underneath. Separate entry / exit tabs.

---

## 4. Analytics panels

1. **Equity + drawdown** — visx, buy-and-hold ghost line, x-brush shared with the price chart
2. **Trade blotter** — virtualized; click a row pans the chart to that trade, hover
   highlights the marker
3. **Parameter sweep** — visx heatmap, two params off the strategy schema, cell = OOS Sharpe
   on a diverging scale, click to load that param set. Streams in from the worker.
4. **Walk-forward** — mirrors the [`eval.py`](../functions/ml/eval.py) fold structure
   visually: expanding-window folds as horizontal bars, IS vs OOS Sharpe per fold, stitched
   OOS equity. This is the panel that reads as research rather than trading toy.
5. **Monte Carlo** — block bootstrap of trade returns (block size configurable, matching the
   block-bootstrap CIs in the ML README), 1000 paths, fan chart at 5/25/50/75/95 percentiles
   plus final-equity and max-DD distributions.

---

## 5. Overfitting-honesty layer

For an ML research audience these matter more than another chart type:

- Sweep panel reports **best-cell vs median-cell Sharpe** side by side, with a
  multiple-testing note
- OOS is the headline number; in-sample is rendered greyed
- A **`runs:12` counter in the tape** — a visible data-snooping tally for the session
- **Cost-sensitivity slider** — watch Sharpe collapse as slippage rises

---

## 6. Build order

| Phase | Deliverable |
|---|---|
| **P0** | Route, Tailwind without preflight, fonts, theme tokens, panel grid, zustand store, tape bar — dead layout with fake numbers |
| **P1** | Engine + metrics + 2 TA strategies on the live plane; equity curve, metrics row, blotter, chart markers. First real end-to-end. |
| **P2** | Parquet→JSON export script, dataset switcher, GEX strategies + ML signal |
| **P3** | Worker, sweep heatmap, walk-forward, Monte Carlo |
| **P4** | Custom rule builder |
| **P5** | cmdk, motion pass, A/B/C compare, config-in-URL sharing, cold-backend / empty / error states, mobile |

P1 is the risk-retiring milestone — if the engine and the visx + lightweight-charts pairing
work there, everything after is additive.

---

## 7. Risks

1. **Historical GEX gap** — the reason for the research plane. The 3-week window also caps
   what the GEX strategies can claim; worth stating in the UI itself.
2. **Tailwind preflight** would wreck the existing dashboard — mitigated by the
   theme+utilities-only import. Verify against the dashboard route during P0.
3. **JSON payload size** — ~1.1k rows × 22 cols × 2 symbols. Ship columnar arrays
   (`{date: [...], close: [...]}`) rather than row objects: roughly 4× smaller, and it is
   the shape the engine wants anyway.
4. **Live-plane 5m depth** — `/api/historical` accepts periods up to 2y, but the DB only
   holds what has actually been ingested. Check real 5m row counts before promising long
   TA backtests.
5. **Bundle size** — visx + framer-motion + cmdk are meaningful additions; keep them behind
   dynamic imports on the `/backtest` route only.

---

## 8. What shipped

Every phase P0–P5 landed. Where reality differed from the plan:

| Plan said | Shipped | Why |
|---|---|---|
| fonts self-hosted via `next/font/local` | `next/font/google` | Same outcome — next/font downloads at build and serves from our origin — without committing binaries. |
| `@visx/heatmap` | plain `<rect>` grid + `@visx/scale` | The heatmap component gives no per-cell click/hover hooks, and clicking a cell to load its parameters is the panel's whole point. Dependency removed. |
| `react-resizable-panels` `PanelGroup/Panel/PanelResizeHandle` | `Group/Panel/Separator` | v4 renamed the parts; numeric sizes are pixels there, so percentages are passed as strings. |
| strategies "reuse `components/indicators.js`" | [`lib/backtest/series.js`](lib/backtest/series.js) mirrors its formulas columnar-ly | The chart's row-object API costs a full conversion per sweep cell. Same SMA/EMA/BB/VWAP definitions, memoised per dataset so 500 cells compute each series once. |
| research plane ~1.1k bars to 05-15 | 3,226 bars to 07-10, OHLCV re-joined, RF re-fit | See §0. |

Verified end to end: engine correctness harness (no look-ahead — fills land on the next
bar's open; equity reconciles with trade P/L to the cent; stops, session-flat and window
confinement all fire), production build, Comlink worker actually spawning under
`next start`, keyboard paths, share-URL round trip, and the dashboard route rendering
byte-identically with Tailwind installed (risk 2 cleared — utilities land only in the
`/backtest` CSS chunk, `globals.css` passes through untouched).

Known caveat, stated in the UI rather than hidden: with default parameters the GEX
strategies lose money on this sample. The wall-fade thesis inverts here — over three months
of 2026 data the walls acted as accelerants more often than pins. That is a finding, not a
bug, and it is exactly what the sweep/walk-forward/cost panels exist to expose.
