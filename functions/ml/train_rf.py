"""Train Random Forest, two variants (with vs without GEX features), via walk-forward CV.

Outputs:
  - Console: per-fold IC + overall summary for each variant + delta
  - functions/ml/data/rf_oos_predictions.parquet (OOS preds for both, for plotting)

Run: python functions/ml/train_rf.py
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import pandas as pd
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (
    walk_forward, summarize,
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, TARGET,
)

DATA_PATH = Path(__file__).resolve().parent / "data" / "qqq_5m_features_h3.parquet"
OOS_OUT = Path(__file__).resolve().parent / "data" / "rf_oos_predictions.parquet"


def rf_factory():
    return RandomForestRegressor(
        n_estimators=500,
        min_samples_leaf=10,   # regularization — prevents memorizing tiny clusters
        max_features="sqrt",
        n_jobs=-1,
        random_state=42,
    )


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    df = pd.read_parquet(DATA_PATH)
    logging.info("Loaded %d rows, target=%s", len(df), TARGET)

    print("\n[1/2] RF-base — baseline features only (%d features)" % len(FEATURES_BASELINE))
    res_base = walk_forward(df, features=FEATURES_BASELINE, model_factory=rf_factory)
    summarize("RF-base", res_base)

    print("\n[2/2] RF-GEX — baseline + GEX features (%d features)" % len(FEATURES_BASELINE_PLUS_GEX))
    res_gex = walk_forward(df, features=FEATURES_BASELINE_PLUS_GEX, model_factory=rf_factory)
    summarize("RF-GEX", res_gex)

    print("\n=== Delta (RF-GEX minus RF-base) ===")
    base_m, gex_m = res_base.overall_metrics, res_gex.overall_metrics
    print(f"  d(IC Pearson)        = {gex_m['ic_pearson']  - base_m['ic_pearson']:+.4f}")
    print(f"  d(IC Spearman)       = {gex_m['ic_spearman'] - base_m['ic_spearman']:+.4f}")
    print(f"  d(Directional acc)   = {gex_m['directional_acc'] - base_m['directional_acc']:+.4f}")
    print(f"  d(Sharpe annualized) = {gex_m['strategy_sharpe_ann'] - base_m['strategy_sharpe_ann']:+.2f}")

    # Save OOS predictions for plotting / SHAP step
    oos = pd.DataFrame({
        "oos_idx":      res_base.oos_idx,
        "date":         df["date"].iloc[res_base.oos_idx].values,
        "y_true":       res_base.oos_true,
        "rf_base_pred": res_base.oos_pred,
        "rf_gex_pred":  res_gex.oos_pred,
    })
    OOS_OUT.parent.mkdir(parents=True, exist_ok=True)
    oos.to_parquet(OOS_OUT, index=False)
    print(f"\nSaved OOS predictions: {OOS_OUT}")


if __name__ == "__main__":
    sys.exit(main())
