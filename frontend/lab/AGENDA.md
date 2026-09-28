# Strategy lab — research agenda

Work through these families roughly in order. Within a family, write the
*mechanism* first, then the spec. Try to cover families before going deep on
any one of them: the ledger pays a deflation cost for every config, so twenty
re-tunes of one idea cost as much as twenty different ideas and teach less.

Tick a family off (`[x]`) in this file once it has at least 3 specs, and add
new families under **Discovered** when a result suggests one.

## Families

- [x] **Negative controls** — `control-random-entry` (done in the dry run). Add one
      shuffled-regime control: the same rule as the best GEX spec but gated on a
      feature with no GEX information (e.g. `minutes_since_open < 260`, which matches
      long gamma's ~70% base rate), to check that GEX adds something over time-of-day.
- [x] **Regime × time of day** — long-gamma vs short-gamma behaviour in the open
      (0–60 min), midday (120–270) and power hour (330–390).
- [ ] **Wall proximity × participation** — fade walls only when
      `volume_zscore_20` is low (no breakout volume); break walls when it is high.
- [ ] **Zero-gamma crosses** — `dist_zero_gamma_atr` crossing 0: momentum
      (negative gamma accelerates) vs fade (flip back into positive gamma).
- [ ] **GEX staleness** — does any GEX edge disappear when `gex_age_minutes` is
      large? Gate an otherwise-reasonable spec on freshness.
- [ ] **Concentration** — high `gex_concentration` (one dominant strike) as a pin:
      mean-revert toward it; low concentration as a trend day.
- [ ] **Model signal** — `ml:pred` thresholds, gated by regime. Note: predictions
      only exist on roughly the second half of discovery, so the early walk-forward
      folds trade nothing. Treat trade counts with care.
- [ ] **Classic TA gated by gamma** — VWAP/BB reversion only in long gamma; EMA
      trend only in short gamma. Is the gate better than the ungated version?
- [ ] **Session structure** — opening-range breakout/fade, with the direction
      conditioned on `above_zero_gamma` and on distance to the nearer wall.
- [ ] **Exits** — for the best 2–3 entries so far, test the exits as new specs:
      `risk.maxBars`, `risk.stopPct`, `flatAtSessionEnd`.

## Discovered

(add families here as results suggest them)

- [ ] **Opening overextension × regime** — regime-tod-fade-longgamma picked the same cell on
      both symbols (fade a ≥ 2 ATR 30m move in the first hour). Test the gate, not the grid:
      the same fade with no regime gate, and in short gamma only. If long gamma does not
      beat both on both symbols, the regime story is not what's working. (rehearsal night)

## Data reference

Lab datasets: QQQ and SPY 5m RTH bars, 2026-04-24 → 2026-08-14, discovery = first ~70%.
All of it is EDT, so `minutes_since_open` 0 = 09:30 ET. The last bar of each session
is 370 (15:40 ET): the final 15 minutes have no 15m forward target and are dropped, so
windows like "power hour" are really 330–370, and a `holdUntil` of 390 never fires.
`hour_sin`/`hour_cos` are computed from **UTC** minute-of-day: `hour_sin` is negative on
every RTH bar, so gate on `minutes_since_open` instead.

| Key | Meaning |
|---|---|
| `f:above_zero_gamma` | +1 above zero gamma (long-gamma, dealers dampen), −1 below |
| `f:dist_zero_gamma_atr` | (close − zero_gamma) / ATR |
| `f:dist_call_wall_atr` / `f:dist_put_wall_atr` | (close − wall) / ATR; 0 = at the wall |
| `f:call_wall_strength` / `f:put_wall_strength` | \|wall GEX\| / total \|GEX\| (0–1) |
| `f:gamma_regime_strength` | net_gex / abs_gex_total (−1…1) |
| `f:net_gex`, `f:abs_gex_total` | raw GEX totals (scale drifts; prefer ratios) |
| `f:gex_concentration` | Σgex² / (Σ\|gex\|)² — Herfindahl of strike GEX |
| `f:gex_age_minutes` | minutes since the GEX snapshot used at this bar |
| `f:minutes_since_open` | 0 at 09:30 ET |
| `f:hour_sin`, `f:hour_cos` | time-of-day encodings (UTC-based; always < 0 in RTH) |
| `f:rsi_14`, `f:atr_14`, `f:realized_vol_60m`, `f:volume_zscore_20`, `f:close_vs_sma20`, `f:close_position`, `f:log_return_{5,15,30,60}m`, `f:log_dollar_volume` | baseline features |
| `ml:pred` | walk-forward OOS RF prediction of the 15m forward log return |
| `close` `open` `high` `low` `volume` `sma:N` `ema:N` `rsi:N` `atr:N` `vwap` `bbUpper:N:k` `bbLower:N:k` `bbMid:N` | computed series (`getSeries`) |
