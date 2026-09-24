"""Walk-forward evaluation harness shared by all model scripts.

Standard usage:

    from functions.ml.eval import walk_forward, summarize, FEATURES_BASELINE, FEATURES_GEX

    df = pd.read_parquet(DATA_PATH)
    result = walk_forward(df, features=FEATURES_BASELINE, model_factory=lambda: RandomForestRegressor(...))
    summarize("RF-base", result)
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
from scipy.stats import pearsonr, spearmanr
from sklearn.model_selection import TimeSeriesSplit

# Feature sets — the SHAP/SHAP-readable lists, with two redundant features dropped per EDA.
FEATURES_BASELINE = [
    "log_return_5m", "log_return_15m", "log_return_30m", "log_return_60m",
    "realized_vol_60m", "atr_14",
    "volume_zscore_20", "log_dollar_volume",
    "close_position",
    "rsi_14",
    "hour_sin", "hour_cos",
]
FEATURES_GEX = [
    "dist_call_wall_atr", "dist_put_wall_atr", "dist_zero_gamma_atr",
    "above_zero_gamma", "gamma_regime_strength",
    "net_gex", "abs_gex_total", "gex_concentration", "gex_age_minutes",
    "call_wall_strength", "put_wall_strength",
]
# Option-flow features — populated only in post-migration snapshots.
# Use FEATURES_BASELINE_PLUS_GEX_PLUS_FLOW once parquets are rebuilt
# after ~2 months of post-migration data.
FEATURES_FLOW = ["pcr_volume", "pcr_oi", "iv_atm", "iv_skew"]
# 0DTE features — populated only after the gex_0dte schema migration.
# Use FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE once enough post-migration rows
# accumulate. Rows missing any 0DTE feature must be dropped before fitting.
FEATURES_0DTE = [
    "gex_0dte_fraction", "gex_0dte_polarity",
    "call_wall_0dte_share", "put_wall_0dte_share",
]
FEATURES_BASELINE_PLUS_GEX = FEATURES_BASELINE + FEATURES_GEX
FEATURES_BASELINE_PLUS_GEX_PLUS_FLOW = FEATURES_BASELINE + FEATURES_GEX + FEATURES_FLOW
FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE = FEATURES_BASELINE + FEATURES_GEX + FEATURES_0DTE

TARGET = "target_return"
# Annualization factor depends on horizon — callers should override via summarize().
# Default below assumes a 15-min horizon (26 windows × 252 days). For other horizons,
# override `periods_per_year` when calling compute_metrics.
PERIODS_PER_YEAR = 252 * 26


@dataclass
class WalkForwardResult:
    oos_true: np.ndarray
    oos_pred: np.ndarray
    oos_idx: np.ndarray
    fold_metrics: list[dict]
    overall_metrics: dict
    bootstrap_ci: tuple[float, float, float]  # (lower, mean, upper) for IC


def compute_metrics(y_true: np.ndarray, y_pred: np.ndarray, periods_per_year: int = PERIODS_PER_YEAR) -> dict:
    ic_p, _ = pearsonr(y_true, y_pred)
    ic_s, _ = spearmanr(y_true, y_pred)

    nz = y_true != 0
    dir_acc = float((np.sign(y_pred[nz]) == np.sign(y_true[nz])).mean()) if nz.any() else float("nan")

    strat_ret = np.sign(y_pred) * y_true
    sharpe = strat_ret.mean() / strat_ret.std(ddof=1) if strat_ret.std(ddof=1) > 0 else 0.0

    return {
        "ic_pearson": float(ic_p),
        "ic_spearman": float(ic_s),
        "directional_acc": dir_acc,
        "strategy_sharpe_ann": float(sharpe * np.sqrt(periods_per_year)),
        "n_obs": int(len(y_true)),
    }


def block_bootstrap_ic(
    y_true: np.ndarray,
    y_pred: np.ndarray,
    n_resamples: int = 1000,
    block_size: int = 73,  # ~1 trading day at 5min bars over RTH
    seed: int = 42,
) -> tuple[float, float, float]:
    """Stationary block bootstrap for IC. Returns (2.5%-ile, mean, 97.5%-ile).

    n_resamples=0 skips it (NaNs) — for callers like the null test that only need the IC.
    """
    if n_resamples == 0:
        return float("nan"), float("nan"), float("nan")
    rng = np.random.default_rng(seed)
    n = len(y_true)
    n_blocks = int(np.ceil(n / block_size))

    samples = np.empty(n_resamples)
    for i in range(n_resamples):
        starts = rng.integers(0, n - block_size + 1, size=n_blocks)
        idx = np.concatenate([np.arange(s, s + block_size) for s in starts])[:n]
        ic, _ = pearsonr(y_true[idx], y_pred[idx])
        samples[i] = ic
    return float(np.percentile(samples, 2.5)), float(samples.mean()), float(np.percentile(samples, 97.5))


def session_ids(dates: pd.Series) -> np.ndarray:
    """Integer id per row for its RTH session (ET calendar date), 0 = first session."""
    d = pd.to_datetime(dates, utc=True).dt.tz_convert("America/New_York").dt.date
    return pd.factorize(d, sort=True)[0]


def session_folds(
    df: pd.DataFrame,
    n_splits: int = 5,
    test_sessions: int | None = None,
    embargo_sessions: int = 1,
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Expanding-window folds cut on session boundaries, with purge + embargo.

    The last `n_splits * test_sessions` sessions become consecutive test folds.
    Each fold trains on every earlier session except the `embargo_sessions`
    immediately before the test block:

        [ train ........ ][ embargo ][ test ]

    Purge: any training row whose `target_time` reaches into the test block is
    dropped. `build_dataset.compute_target` never lets a target cross a session,
    so on session-aligned cuts this removes nothing — it's the safety net if
    that ever changes.
    """
    sid = session_ids(df["date"])
    n_sessions = int(sid.max()) + 1
    if test_sessions is None:
        test_sessions = n_sessions // (n_splits + 1)
    first_test = n_sessions - n_splits * test_sessions
    if test_sessions < 1 or first_test - embargo_sessions < 1:
        raise ValueError(
            f"{n_sessions} sessions can't fit {n_splits} folds x {test_sessions} test "
            f"sessions + {embargo_sessions} embargo"
        )

    target_time = pd.to_datetime(df["target_time"], utc=True).values if "target_time" in df else None
    date = pd.to_datetime(df["date"], utc=True).values
    folds = []
    for k in range(n_splits):
        t0 = first_test + k * test_sessions
        test_mask = (sid >= t0) & (sid < t0 + test_sessions)
        train_mask = sid < t0 - embargo_sessions
        test_idx = np.flatnonzero(test_mask)
        test_start = date[test_idx].min()
        if target_time is not None:
            train_mask &= target_time < test_start
        train_idx = np.flatnonzero(train_mask)
        if target_time is not None:
            assert target_time[train_idx].max() < test_start, "LEAK: train target reaches test fold"
        folds.append((train_idx, test_idx))
    return folds


def walk_forward(
    df: pd.DataFrame,
    features: list[str],
    model_factory: Callable,
    target: str = TARGET,
    n_splits: int = 5,
    test_size: int = 100,
    bootstrap_resamples: int = 1000,
    split: str = "sessions",
    test_sessions: int | None = None,
    embargo_sessions: int = 1,
) -> WalkForwardResult:
    """Expanding-window walk-forward CV.

    split="sessions" (default): folds from `session_folds` — cut on trading-day
    boundaries, purged, with `embargo_sessions` skipped before every test fold.
    `test_sessions` defaults to n_sessions // (n_splits + 1).

    split="rows": the original row-count split, kept only so the README's
    pre-embargo numbers stay reproducible. With n_splits=5 and test_size=100 on
    1095 rows:
      fold 1: train [0:595],  test [595:695]
      ...
      fold 5: train [0:995],  test [995:1095]
    Folds cut mid-session, so the last `horizon` training rows' targets overlap
    the test fold — slightly optimistic.

    `model_factory` is a zero-arg callable that returns a fresh estimator with
    .fit(X, y) and .predict(X). The harness fits on the train slice only.
    """
    X = df[features].values
    y = df[target].values

    if split == "sessions":
        folds = session_folds(df, n_splits=n_splits, test_sessions=test_sessions,
                              embargo_sessions=embargo_sessions)
    elif split == "rows":
        folds = list(TimeSeriesSplit(n_splits=n_splits, test_size=test_size).split(X))
    else:
        raise ValueError(f"unknown split={split!r}")

    all_preds, all_true, all_idx, fold_metrics = [], [], [], []

    for fold, (train_idx, test_idx) in enumerate(folds):
        model = model_factory()
        model.fit(X[train_idx], y[train_idx])
        preds = model.predict(X[test_idx])

        all_preds.append(preds)
        all_true.append(y[test_idx])
        all_idx.append(test_idx)
        fm = compute_metrics(y[test_idx], preds)
        fm["n_train"] = int(len(train_idx))
        fold_metrics.append(fm)
        logging.info(
            "Fold %d/%d  train=%d test=%d  IC=%+.4f  dir_acc=%.3f",
            fold + 1, len(folds), len(train_idx), len(test_idx),
            fm["ic_pearson"], fm["directional_acc"],
        )

    oos_pred = np.concatenate(all_preds)
    oos_true = np.concatenate(all_true)
    oos_idx = np.concatenate(all_idx)

    overall = compute_metrics(oos_true, oos_pred)
    ci = block_bootstrap_ic(oos_true, oos_pred, n_resamples=bootstrap_resamples)

    return WalkForwardResult(
        oos_true=oos_true, oos_pred=oos_pred, oos_idx=oos_idx,
        fold_metrics=fold_metrics, overall_metrics=overall, bootstrap_ci=ci,
    )


def summarize(name: str, result: WalkForwardResult) -> str:
    m = result.overall_metrics
    lo, mid, hi = result.bootstrap_ci
    lines = [
        f"=== {name} ===",
        f"  n_oos                       = {m['n_obs']}",
        f"  IC (Pearson)                = {m['ic_pearson']:+.4f}",
        f"  IC 95% CI (block bootstrap) = [{lo:+.4f}, {hi:+.4f}]   mean={mid:+.4f}",
        f"  IC (Spearman)               = {m['ic_spearman']:+.4f}",
        f"  Directional accuracy        = {m['directional_acc']:.3f}",
        f"  Strategy Sharpe (annualized)= {m['strategy_sharpe_ann']:+.2f}",
        f"  Per-fold IC: " + ", ".join(f"{fm['ic_pearson']:+.4f}" for fm in result.fold_metrics),
    ]
    out = "\n".join(lines)
    print(out)
    return out
