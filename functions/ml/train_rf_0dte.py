"""Random Forest training with 0DTE-aware GEX features.

Runs three walk-forward variants on rows that have populated 0DTE columns
(i.e. ingested after the gex_0dte schema migration):
  1. RF-base       — baseline price/volume only
  2. RF-GEX        — baseline + legacy GEX (no 0DTE split)
  3. RF-GEX+0DTE   — baseline + legacy GEX + 4 new 0DTE features

Rationale: ~50% of options volume is 0DTE. Per-DTE-bucket GEX columns let the
tree see how concentrated dealer flow is in same-day expiry versus longer-dated
contracts, which the aggregated GEX collapsed into a single number.

Usage:
    python train_rf_0dte.py --symbol QQQ --horizon-bars 3
    python train_rf_0dte.py --symbol SPY --horizon-bars 12

Skips automatically (with a warning) if fewer than 200 rows have populated
0DTE columns — small samples produce unreliable IC.
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (
    walk_forward, summarize,
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX,
    FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE, FEATURES_0DTE,
    TARGET,
)

DATA_DIR = Path(__file__).resolve().parent / "data"
MIN_ROWS_FOR_TRAIN = 200  # below this the 5-fold CV is meaningless


def rf_factory():
    return RandomForestRegressor(
        n_estimators=500,
        min_samples_leaf=10,
        max_features="sqrt",
        n_jobs=-1,
        random_state=42,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="QQQ")
    parser.add_argument("--horizon-bars", type=int, default=3)
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    symbol = args.symbol.upper()
    horizon_bars = args.horizon_bars
    data_path = DATA_DIR / f"{symbol.lower()}_5m_features_h{horizon_bars}.parquet"

    if not data_path.exists():
        raise SystemExit(f"Missing dataset: {data_path}. Run build_dataset.py first.")

    df_all = pd.read_parquet(data_path)
    logging.info("Loaded %d rows from %s", len(df_all), data_path.name)

    df = df_all.dropna(subset=FEATURES_0DTE).reset_index(drop=True)
    logging.info("Rows with all 0DTE features populated: %d / %d (%.1f%%)",
                 len(df), len(df_all), 100.0 * len(df) / max(len(df_all), 1))

    if len(df) < MIN_ROWS_FOR_TRAIN:
        logging.warning(
            "Only %d 0DTE-populated rows (< %d). Skipping 0DTE training; the "
            "schema migration likely landed too recently for enough fresh GEX "
            "snapshots to accumulate. Re-run in 1-2 weeks.",
            len(df), MIN_ROWS_FOR_TRAIN)
        return

    print(f"\n[1/3] RF-base — baseline features only ({len(FEATURES_BASELINE)} features)")
    res_base = walk_forward(df, features=FEATURES_BASELINE, model_factory=rf_factory)
    summarize("RF-base", res_base)

    print(f"\n[2/3] RF-GEX — baseline + legacy GEX ({len(FEATURES_BASELINE_PLUS_GEX)} features)")
    res_gex = walk_forward(df, features=FEATURES_BASELINE_PLUS_GEX, model_factory=rf_factory)
    summarize("RF-GEX", res_gex)

    print(f"\n[3/3] RF-GEX+0DTE — baseline + legacy GEX + 0DTE ({len(FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE)} features)")
    res_0dte = walk_forward(df, features=FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE, model_factory=rf_factory)
    summarize("RF-GEX+0DTE", res_0dte)

    print("\n=== Delta (RF-GEX+0DTE minus RF-GEX) ===")
    gm, dm = res_gex.overall_metrics, res_0dte.overall_metrics
    print(f"  d(IC Pearson)        = {dm['ic_pearson']  - gm['ic_pearson']:+.4f}")
    print(f"  d(IC Spearman)       = {dm['ic_spearman'] - gm['ic_spearman']:+.4f}")
    print(f"  d(Directional acc)   = {dm['directional_acc'] - gm['directional_acc']:+.4f}")

    print("\n=== Delta (RF-GEX+0DTE minus RF-base) ===")
    bm = res_base.overall_metrics
    print(f"  d(IC Pearson)        = {dm['ic_pearson']  - bm['ic_pearson']:+.4f}")
    print(f"  d(IC Spearman)       = {dm['ic_spearman'] - bm['ic_spearman']:+.4f}")
    print(f"  d(Directional acc)   = {dm['directional_acc'] - bm['directional_acc']:+.4f}")


if __name__ == "__main__":
    sys.exit(main())
