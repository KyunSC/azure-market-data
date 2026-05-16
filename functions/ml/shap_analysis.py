"""SHAP analysis on the two key RF configurations.

Plot 1: RF-GEX at 15min   -> did the model actually use GEX features?
Plot 2: RF-base at 120min -> what baseline features drive the long-horizon signal?

For each: train RF on the first 80% of the data (time-ordered), compute SHAP on the
held-out 20%, then save beeswarm + custom bar chart with GEX features highlighted.
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
from eval import FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, FEATURES_GEX, TARGET  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"
PLOTS_DIR = Path(__file__).resolve().parent / "plots"


def make_rf() -> RandomForestRegressor:
    return RandomForestRegressor(
        n_estimators=500, min_samples_leaf=10, max_features="sqrt",
        n_jobs=-1, random_state=42,
    )


def shap_analyze(parquet_name: str, features: list[str], plot_stem: str, title: str) -> None:
    df = pd.read_parquet(DATA_DIR / parquet_name)
    n_train = int(0.8 * len(df))
    X_train = df[features].iloc[:n_train].to_numpy()
    X_test  = df[features].iloc[n_train:].to_numpy()
    y_train = df[TARGET].iloc[:n_train].to_numpy()

    logging.info("%s: train on %d rows, SHAP on %d held-out rows", plot_stem, n_train, len(X_test))
    model = make_rf()
    model.fit(X_train, y_train)

    explainer = shap.TreeExplainer(model)
    shap_values = explainer.shap_values(X_test)

    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    # Beeswarm (default SHAP colorscheme: red=high feature value, blue=low)
    plt.figure(figsize=(9, max(4.0, 0.4 * len(features))))
    shap.summary_plot(shap_values, X_test, feature_names=features, show=False)
    plt.title(title, loc="left", fontsize=11)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / f"{plot_stem}_beeswarm.png", dpi=150, bbox_inches="tight")
    plt.close()

    # Custom bar plot: mean |SHAP|, GEX features in red
    mean_abs = np.abs(shap_values).mean(axis=0)
    order = np.argsort(mean_abs)
    feats_sorted = [features[i] for i in order]
    colors = ["crimson" if f in FEATURES_GEX else "steelblue" for f in feats_sorted]

    fig, ax = plt.subplots(figsize=(8, max(4.0, 0.35 * len(features))))
    ax.barh(feats_sorted, mean_abs[order], color=colors)
    ax.set_xlabel("Mean |SHAP value| — impact on prediction")
    ax.set_title(f"{title}\nfeature importance (red = GEX feature)", loc="left", fontsize=11)
    plt.tight_layout()
    plt.savefig(PLOTS_DIR / f"{plot_stem}_bar.png", dpi=150, bbox_inches="tight")
    plt.close()

    print(f"\n=== {title} ===")
    print(f"Trained on {n_train} rows, SHAP on {len(X_test)} held-out rows")
    print("Rank | Type | Feature                   | mean|SHAP|")
    for rank, idx in enumerate(reversed(order), 1):
        feat = features[idx]
        tag = "GEX " if feat in FEATURES_GEX else "BASE"
        print(f"  {rank:2d} | {tag} | {feat:25s} | {mean_abs[idx]:.6f}")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    shap_analyze(
        parquet_name="qqq_5m_features_h3.parquet",
        features=FEATURES_BASELINE_PLUS_GEX,
        plot_stem="rf_gex_h3",
        title="RF-GEX, 15-min horizon — did the model use GEX features?",
    )

    shap_analyze(
        parquet_name="qqq_5m_features_h24.parquet",
        features=FEATURES_BASELINE,
        plot_stem="rf_base_h24",
        title="RF-base, 120-min horizon — what drives the long-horizon signal?",
    )

    print(f"\nPlots saved to: {PLOTS_DIR}")


if __name__ == "__main__":
    sys.exit(main())
