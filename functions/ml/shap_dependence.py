"""SHAP dependence plots — does the model encode 'reversal-at-GEX-levels' logic?

For the three signed GEX distance features, plot SHAP value vs feature value.
A monotonically *decreasing* curve means: as price moves above the level, the
model predicts increasingly negative future return — i.e., reversal toward
the level. The opposite slope would imply trend following.

Also computes the empirical SHAP-vs-feature slope (least-squares) as a single
summary number per feature.

Outputs:
  functions/ml/plots/shap_dependence_dist_call_wall.png
  functions/ml/plots/shap_dependence_dist_put_wall.png
  functions/ml/plots/shap_dependence_dist_zero_gamma.png
  functions/ml/plots/shap_dependence_above_zero_gamma.png
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import shap
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import FEATURES_BASELINE_PLUS_GEX, FEATURES_GEX, TARGET  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"
PLOTS_DIR = Path(__file__).resolve().parent / "plots"

# Features whose dependence we care about (and what we'd expect under each hypothesis)
TARGET_FEATURES = [
    ("dist_call_wall_atr",  "Distance to call wall (in ATR units, signed)",
     "Reversal hypothesis: positive slope below 0 (approach from below = price rises toward wall),\nnegative slope above 0 (above wall = revert back down)."),
    ("dist_put_wall_atr",   "Distance to put wall (in ATR units, signed)",
     "Reversal hypothesis: negative slope above 0 (approach from above = price falls toward wall),\nnegative slope below 0 (below put wall = revert back up)."),
    ("dist_zero_gamma_atr", "Distance to zero-gamma flip (in ATR units, signed)",
     "Suppression hypothesis: negative slope above 0 (positive-gamma regime suppresses moves)."),
    ("above_zero_gamma",    "Sign of (close - zero_gamma), {-1, +1}",
     "Suppression hypothesis: SHAP at +1 should be negative, SHAP at -1 should be positive."),
]


def run_for(parquet_name: str, label: str) -> None:
    df = pd.read_parquet(DATA_DIR / parquet_name)
    features = FEATURES_BASELINE_PLUS_GEX
    n_train = int(0.8 * len(df))
    X_train = df[features].iloc[:n_train].to_numpy()
    X_test  = df[features].iloc[n_train:].to_numpy()
    y_train = df[TARGET].iloc[:n_train].to_numpy()

    rf = RandomForestRegressor(n_estimators=500, min_samples_leaf=10,
                               max_features="sqrt", n_jobs=-1, random_state=42)
    rf.fit(X_train, y_train)
    explainer = shap.TreeExplainer(rf)
    shap_values = explainer.shap_values(X_test)

    print(f"\n=== {label} ===")
    for feat_name, axis_label, hypothesis in TARGET_FEATURES:
        if feat_name not in features:
            continue
        col = features.index(feat_name)
        x_vals = X_test[:, col]
        sv = shap_values[:, col]

        # Empirical slope: simple linear regression of SHAP on feature value
        if x_vals.std() > 0:
            slope = np.polyfit(x_vals, sv, 1)[0]
        else:
            slope = 0.0
        sign = "negative (reversal)" if slope < 0 else "positive (trend)"
        print(f"  {feat_name:25s}  slope = {slope:+.4e}  -> {sign}")

        fig, ax = plt.subplots(figsize=(7, 4.5))
        # Color points by another GEX feature (helps spot interactions)
        c_col = features.index("net_gex")
        sc = ax.scatter(x_vals, sv, c=X_test[:, c_col], cmap="coolwarm",
                        s=14, alpha=0.7, edgecolors="none")
        cb = fig.colorbar(sc, ax=ax)
        cb.set_label("net_gex (color)", fontsize=9)
        # LOESS-ish smoother via simple binning
        order = np.argsort(x_vals)
        x_sorted = x_vals[order]
        sv_sorted = sv[order]
        bin_size = max(20, len(x_sorted) // 25)
        bin_means_x = [x_sorted[i:i+bin_size].mean() for i in range(0, len(x_sorted), bin_size)]
        bin_means_y = [sv_sorted[i:i+bin_size].mean() for i in range(0, len(x_sorted), bin_size)]
        ax.plot(bin_means_x, bin_means_y, "k-", lw=1.5, alpha=0.7, label="binned mean")
        # Linear fit line
        xline = np.linspace(x_vals.min(), x_vals.max(), 50)
        b, a = np.polyfit(x_vals, sv, 1)
        ax.plot(xline, a + b * xline, "r--", lw=1, alpha=0.7,
                label=f"linear fit (slope={b:+.2e})")
        ax.axhline(0, color="k", lw=0.6, alpha=0.5)
        ax.axvline(0, color="k", lw=0.6, alpha=0.5)
        ax.set_xlabel(axis_label)
        ax.set_ylabel(f"SHAP value (impact on predicted 15-min return)")
        ax.set_title(f"{label}: SHAP dependence — {feat_name}\n{hypothesis}",
                     fontsize=10, loc="left")
        ax.legend(loc="best", fontsize=8)
        ax.grid(alpha=0.3)

        out = PLOTS_DIR / f"shap_dependence_{label.lower()}_{feat_name}.png"
        plt.tight_layout()
        plt.savefig(out, dpi=130, bbox_inches="tight")
        plt.close()
        print(f"    -> {out.name}")


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    for sym in ("qqq", "spy", "iwm", "dia"):
        parquet = f"{sym}_5m_features_h3.parquet"
        if not (DATA_DIR / parquet).exists():
            print(f"(skip {sym.upper()}: {parquet} not found)")
            continue
        run_for(parquet, sym.upper())


if __name__ == "__main__":
    sys.exit(main())
