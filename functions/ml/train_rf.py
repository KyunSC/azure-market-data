"""Train Random Forest, two variants (with vs without GEX features), via walk-forward CV.

Outputs:
  - Console: per-fold IC + overall summary for each variant + delta
  - functions/ml/data/rf_oos_predictions.parquet (OOS preds for both, for plotting)

Run: python functions/ml/train_rf.py
     python functions/ml/train_rf.py --symbol SPY --horizon-bars 3 --tag td   # 2022+ ThetaData dataset
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
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE, TARGET,
)
from holdout import load_research

DATA_DIR = Path(__file__).resolve().parent / "data"


def rf_factory():
    return RandomForestRegressor(
        n_estimators=500,
        min_samples_leaf=10,   # regularization — prevents memorizing tiny clusters
        max_features="sqrt",
        n_jobs=-1,
        random_state=42,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--horizon-bars", type=int, default=3)
    ap.add_argument("--tag", default="", help="dataset suffix, e.g. td for the ThetaData rebuild")
    ap.add_argument("--with-0dte", action="store_true",
                    help="GEX variant also gets the four 0DTE share features (rows missing them are dropped)")
    args = ap.parse_args()
    gex_features = FEATURES_BASELINE_PLUS_GEX_PLUS_0DTE if args.with_0dte else FEATURES_BASELINE_PLUS_GEX
    suffix = f"_{args.tag}" if args.tag else ""
    data_path = DATA_DIR / f"{args.symbol.lower()}_5m_features_h{args.horizon_bars}{suffix}.parquet"
    # The original QQQ/15-min run keeps its old output name.
    variant = suffix + ("_0dtefeat" if args.with_0dte else "")
    oos_out = DATA_DIR / ("rf_oos_predictions.parquet" if (args.symbol.upper(), args.horizon_bars, variant) == ("QQQ", 3, "")
                          else f"rf_oos_predictions_{args.symbol.lower()}_h{args.horizon_bars}{variant}.parquet")

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    df = load_research(data_path)
    if args.with_0dte:
        # Both variants fit on the same rows, so the comparison stays paired.
        df = df.dropna(subset=gex_features).reset_index(drop=True)
    logging.info("Loaded %d rows, target=%s", len(df), TARGET)

    print("\n[1/2] RF-base — baseline features only (%d features)" % len(FEATURES_BASELINE))
    res_base = walk_forward(df, features=FEATURES_BASELINE, model_factory=rf_factory)
    summarize("RF-base", res_base)

    print("\n[2/2] RF-GEX — baseline + GEX features (%d features)" % len(gex_features))
    res_gex = walk_forward(df, features=gex_features, model_factory=rf_factory)
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
    oos_out.parent.mkdir(parents=True, exist_ok=True)
    oos.to_parquet(oos_out, index=False)
    print(f"\nSaved OOS predictions: {oos_out}")


if __name__ == "__main__":
    sys.exit(main())
