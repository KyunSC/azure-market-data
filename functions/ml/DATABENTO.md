# Databento research integration

Scope: **ES/NQ futures only** (GLBX.MDP3). Historical GEX comes from a separate
options-analytics provider, not from Databento option data. Nothing beyond the
one-day definition sample below has been purchased; no purchase is authorized
without explicit approval of a quote.

## Jobs

| Job | Schema | Symbols | Chunking | Quote, full window (2026-09-26) |
|---|---|---|---|---:|
| `fut-ohlcv-1m` | ohlcv-1m | `ES.FUT`, `NQ.FUT` (every outright) | month | ~$1.74 |
| `fut-bbo-1s` | bbo-1s, 09:25–16:00 ET | `ES.v.0`, `NQ.v.0` | weekday | < ~$23 (quoted over full days) |
| `nq-mbo` | mbo (L3) | `NQ.v.0` | month, explicit dates only | ~$235 full window; pilot first |

Outright 1m bars keep the futures–index basis roll-aware when mapping the
provider's index/ETF GEX levels onto ES/NQ. `nq-mbo` is deferred until cheaper
features justify it; request MBO from UTC midnight, since that is where the
synthetic order-book snapshot lives.

```sh
.venv/bin/python functions/ml/databento_fetch.py fut-ohlcv-1m fut-bbo-1s          # free quote
.venv/bin/python functions/ml/databento_fetch.py fut-ohlcv-1m fut-bbo-1s \
  --download --max-cost 25                                                         # needs approval
```

All dates are exclusive at end. The default window (2026-04-24 → 2026-09-24)
includes sealed verify dates (from 2026-08-24); downloading them does not
authorize inspecting them. Use `holdout.load_research` for research.

## Acquisition guarantees and limitations

- Default is quote-only. A finite nonnegative aggregate cap is mandatory for
  downloading. Re-price immediately before each request; stop if remaining cap
  is insufficient. Provider billing may differ from estimates.
- Keep original DBN plus Parquet. Existing DBN is converted locally, not bought
  again. Exclusive intent files prevent concurrent same-chunk purchases.
- Failed/interrupted attempts retain intent and partial files and block retry.
  Reconcile provider billing and artifact completeness manually; do not simply
  delete these markers. There is no automatic paid-request retry.
- Overlapping stored date chunks block new purchases. Resume using the original
  chunk boundaries; do not re-partition previously purchased intervals.
- BBO uses 09:25–16:00 America/New_York, with DST-aware UTC conversion.

## Next implementation gates

1. Quote, approve, and fetch `fut-ohlcv-1m` + `fut-bbo-1s`.
2. Build BBO spread and size imbalance using interval-end availability; avoid
   mixing contracts across rolls, crossed/missing quotes, or filling across
   sessions. Preserve coverage diagnostics. Add as optional feature columns in
   `build_dataset.py` without changing existing experiment baselines.
3. Ingest the external GEX provider's history point-in-time (use the timestamp
   each snapshot was *available*, not recomputed later), convert index/ETF levels
   to ES/NQ with the bar-aligned basis, and compare against the current
   QQQ-converted yfinance GEX on discovery rows only. Freeze feature choices
   before any sealed verification.
4. Only then decide whether an `nq-mbo` pilot merits spending credit.

## Offline verification

```sh
.venv/bin/python -m unittest discover -s functions/ml -p test_databento_fetch.py
```

## Retired: option definition sample (2026-07-06)

Bought before the scope change: ES + NQ option definitions for one day, quoted
$0.0628 total (see `data/databento/ledger.jsonl`). Files remain under
`data/databento/fopt-def/` with the audit in
`data/databento/definition_audit_2026-07-06.json`; the option jobs were removed
from `databento_fetch.py`. Findings, kept in case native GEX is revisited:
`contract_multiplier` holds the undefined sentinel 2147483647 (use
`unit_of_measure_qty`: 50 ES, 20 NQ); quarterly families are American-style
(OCAFPS/OPAFPS) while weeklies/dailies are European (OCEFPS/OPEFPS); non-call/put
records must be filtered; each CME expiry cycle is its own parent symbol, so
`ES.OPT` alone covers only quarterlies.
