# Flybrain: private mushroom-body strategy research

This package tests whether the signed wiring of the fruit fly's mushroom body helps forecast intraday ETF returns. The mushroom body is an associative-learning circuit with sparse Kenyon-cell representations, inhibitory feedback, output neurons, and dopamine-mediated learning. Its wiring is a fixed rate reservoir here, not a spiking brain simulation.

Every sampled parameter set is evaluated under four paired circuits: FlyWire, degree-preserving shuffle, random locations with the exact original signed weights, and normalized features without a reservoir. GEX-off runs retain input dimensions and zero the dealer/wall inputs. A null result is a valid result; the gates are never relaxed.

## Run locally

Use the existing environment, from `functions/ml`. No dependencies, credentials, database, or paid data downloads are needed. Public FlyWire downloads are the only network operation.

```sh
.venv/bin/python -m flybrain.connectome
.venv/bin/python -m flybrain.search --help
.venv/bin/python -m flybrain.search run --trials 100 --night 2026-10-03 --seed 42
.venv/bin/python -m flybrain.search status
.venv/bin/python -m flybrain.search leaderboard --all
.venv/bin/python -m flybrain.search finalize --night 2026-10-03 --top 5
# Only after reviewing a finalized CANDIDATE or LEAD; consumes its one look:
.venv/bin/python -m flybrain.search verify HASH
```

`--trials` counts paired groups, each consuming four variants of the lifetime budget. Both symbols belong to each variant. Search finishes the paired group before stopping on an eligible result. Reusing a sampled hash is refused. Use `--eval-fee` to set the evaluation fee for the reported expected take; it does not change eligibility. Every command accepts `--runs-dir` for isolated experiments. Do not remove a real research ledger to reset the budget.

Regenerate synthetic JavaScript fixtures from the repository root:

```sh
cd frontend
node ../functions/ml/flybrain/tools/export_fixtures.mjs
```

This snapshots all 32 Lucid plan/size/DLL combinations and checks the Python account replay, bootstrap RNG, and Sharpe inference against the JavaScript source. No live firm-rule assumptions are fetched or substituted.

## Data boundaries

```text
Research only (< research_cutoff)
[ 20-session warmup ][ discovery ~70% ][ lab holdout ~30% ] | 5-session gap | sealed verify
                      purged 4-fold WF  preregister once                    >= 2026-08-24 ET
```

Research bounds come from `gex_vol_study.research_cutoff`, using IV partition names only. Reads of bar, snapshot, and optional feature parquet files use upper-bound filters. Search loads discovery only. The research-frame smoke test may read the complete research frame to check its shape; it does not fit or score the lab holdout. Finalization durably writes `preregistered.json` and `finalize.lock` before loading the lab holdout. An interrupted finalization cannot be retried for that night.

Raw prices are retained separately from `z_` model inputs. Expanding normalization uses only prior sessions, drops a 20-session warmup, clips to ±5, and replaces missing inputs with zero. The local market-open clock uses New York time across DST. Optional cached IV/RV features are never rebuilt during research. GEX is joined backward with the existing 15-minute tolerance.

Finalization fits on discovery, freezes coefficients and training-derived thresholds, and saves the research-end normalization statistics. Verification first appends and fsyncs a `started` record, then reads the sealed period with 20 prior warmup sessions. Warmup rows are never scored. It uses frozen normalization and readouts, checks artifact checksums, and refuses any second attempt, including after a failure. No verify data is read by the test suite or normal search.

## Reproducibility and interpretation

The cached right hemisphere contains **139 uniglomerular PNs, 2,597 KCs, 1 APL, 48 MBONs, and 165 DANs**. `data/flybrain/flywire/manifest.json` records the actual URLs, column names, SHA-256 hashes, sizes, and download times. The annotation schema uses `Kenyon_Cell`, `ALPN` plus `cell_sub_class=uniglomerular`, `MBIN` plus `cell_type=APL`, `MBON`, and `DAN`.

Only readout parameters are learned. ON/OFF encoding uses disjoint PN pools. Reservoir state resets every session; short sessions are masked. k-WTA retains at most ceil(k × KC count) active KCs; zero activity is not invented to fill the quota. In particular, PN-only input cannot reach KCs on the first recurrent step from a zero initial state.

Documented implementation choices:

- `random_control(W, seed)` replaces the brief's scalar-only signature because preserving the exact weight multiset requires the original matrix. This adjustment was accepted before implementation.
- DAN starts from seeded small random weights to escape the zero-weight/no-trade fixed point. Rewards are signed ETF points divided by entry ATR, applied only when the simulated next-open trade closes, and the update is `lr * side * pattern * reward` (decay 1e-4). The brief writes `-lr * s * (-pnl)` without a side term; taken literally, a winning short would push the readout toward long, so reinforcement is made side-symmetric (a winning trade strengthens the pattern-to-action association in the direction taken). Prediction thresholds use prior predictions only; finalized thresholds are frozen and the frozen readout does no further learning. This is a simplified dopamine rule, not a fitted biological DAN model.
- The reservoir has no bias term (`b = 0` in the brief's update). Cached states are keyed on the circuit hash, reservoir parameters, input bytes and the reservoir, connectome and features sources; cache files are written atomically and shape-checked on load.
- An interrupted or failed variant is recorded as `rejected: error:<Type>` and still consumes one lifetime slot, so aborting a run cannot reset the budget. That includes the extra top-five guard evaluation.
- A hold of H bars counts the entry bar and exits at that H-th bar's close, or earlier at session close. Entry/exit prices in trade records are futures-scaled fills; `raw_*_price` fields retain ETF prices.
- Random-entry controls preserve each session's trade count and the realized hold-length multiset. They randomize placements and sides without overlapping positions. Prop uncertainty is the bootstrap interval over 50 control seeds; censored/undefined control pass rates cannot pass the gates.
- Prefix guards preserve the experiment's original fold schedule. Completed-session reservoir caches are reusable because sessions are independent; the truncated session is recomputed. Training-only fitted ridge models are reused only where their training rows are identical.
- Deflation is recalculated over the lifetime ledger when displaying or finalizing results. Earlier append-only records are snapshots of what was known at their evaluation time.

## Paired results and GEX ablation

`leaderboard --all` produces the main scientific output: all circuit rows, a per-group table with all four circuits side by side (both symbols and their median), paired group counts, median Sharpe and prop lift, and bootstrap CIs for fly-minus-control differences, overall and per symbol. Each walk-forward fold entry reports Sharpe inference, trades, P&L and max drawdown. Both symbols are summarized within each group before bootstrapping groups, so they are not treated as independent trials. The `gex_ablation` field has descriptive GEX-on/GEX-off strata plus a `matched` section that only uses groups whose sampled parameters are identical except `gex_off`; random sampling rarely produces such pairs, and an empty `matched` section means no pair exists, not no effect. Unmatched or rejected groups are excluded from paired comparisons.

No production-budget search or sealed verification has been run as part of implementation. The implementation smoke results are recorded below after validation; they are not evidence of a trading edge.

## Caveats and licensing

- QQQ→MNQ and SPY→MES are ETF proxies using fixed ratios 41.2 and 10.05. Basis drift, futures rolls, and overnight/Globex trading are omitted. Only RTH bars are used.
- Lucid rules are the repository's **Sep 2026** snapshot (`PROP_ASOF`), not a claim about current offerings. All rule values come from exported fixtures.
- Per-bar Sharpe inference inherits the JavaScript convention and its independence assumption. Serial dependence can make these intervals optimistic. Lifetime deflation and family-wide Bonferroni correction help control selection but do not establish live profitability.
- A profitable account simulation does not guarantee a funded-account payout or an executable futures edge.
- **ThetaData-derived outputs are private and must never be redistributed.** Keep run ledgers, frozen models, and reports private. Public FlyWire data are attributed under CC-BY 4.0; see the upstream data licensing notices.

Sources: Dorkenwald et al. (2024), *Nature*; Schlegel et al. (2024), *Nature*; Shiu et al. (2024), *Nature*. The data and accompanying references are available in [FlyWire annotations](https://github.com/flyconnectome/flywire_annotations) and the [Drosophila brain model repository](https://github.com/philshiu/Drosophila_brain_model). Annotation versions can have additional citation requirements; the cache manifest identifies the downloaded content.

## Validation

```sh
.venv/bin/python -m unittest test_flybrain_connectome test_flybrain_features test_flybrain_reservoir test_flybrain_engine test_flybrain_prop test_flybrain_search
.venv/bin/python -m unittest discover -p 'test_*.py'
# From frontend: npm test
```

Synthetic tests cover signed wiring and controls, causal normalization, session splits, batched reservoir equivalence, reward timing, training-only thresholds, dollar accounting, JavaScript parity, lifetime budgeting, leakage rejection, planted/noise signals, finalization lock ordering, and failed-verification one-look persistence. Real-data tests use only cached public connectome data; market-data smoke runs are explicitly separate.
