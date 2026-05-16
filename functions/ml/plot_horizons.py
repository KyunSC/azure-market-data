"""IC vs prediction horizon, RF-base vs RF-GEX, with 95% bootstrap CI bands.

Reads functions/ml/data/horizons_summary.csv (produced by train_rf_horizons.py)
and saves functions/ml/data/plots/ic_vs_horizon.png.
"""
from __future__ import annotations

import sys
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd

DATA_DIR = Path(__file__).resolve().parent / "data"
PLOTS_DIR = Path(__file__).resolve().parent / "plots"


def _plot_single(ax, df, label_to_min, title):
    df = df.assign(horizon_min=df["horizon"].map(label_to_min)).sort_values("horizon_min")
    base = df[df["model"] == "RF-base"].reset_index(drop=True)
    gex  = df[df["model"] == "RF-GEX"].reset_index(drop=True)
    ax.fill_between(base["horizon_min"], base["ic_ci_lo"], base["ic_ci_hi"],
                    color="steelblue", alpha=0.18, label="RF-base 95% CI")
    ax.plot(base["horizon_min"], base["ic"], "o-", color="steelblue", lw=2,
            markersize=7, label="RF-base (price/volume only)")
    ax.fill_between(gex["horizon_min"], gex["ic_ci_lo"], gex["ic_ci_hi"],
                    color="crimson", alpha=0.18, label="RF-GEX 95% CI")
    ax.plot(gex["horizon_min"], gex["ic"], "s-", color="crimson", lw=2,
            markersize=7, label="RF-GEX (+ 8 GEX features)")
    ax.axhline(0, color="k", lw=0.8, ls="--", alpha=0.5)
    ax.set_xscale("log")
    ax.set_xticks([5, 15, 30, 60, 120])
    ax.set_xticklabels(["5", "15", "30", "60", "120"])
    ax.set_xlabel("Prediction horizon (minutes, log scale)")
    ax.set_ylabel("Information Coefficient (Pearson)")
    ax.set_title(title, fontsize=11, loc="left")
    ax.legend(loc="upper left", fontsize=8)
    ax.grid(alpha=0.3)


def main() -> None:
    label_to_min = {"5min": 5, "15min": 15, "30min": 30, "60min": 60, "120min": 120}
    PLOTS_DIR.mkdir(parents=True, exist_ok=True)

    # Per-symbol plots
    for symbol in ("qqq", "spy"):
        path = DATA_DIR / f"horizons_summary_{symbol}.csv"
        if not path.exists():
            print(f"(skip {symbol}: {path.name} not found)")
            continue
        df = pd.read_csv(path)
        fig, ax = plt.subplots(figsize=(8, 5))
        _plot_single(ax, df, label_to_min,
                     f"{symbol.upper()} — RF IC vs. horizon, with/without GEX features\n"
                     "95% CIs from block bootstrap (block=73 ~ 1 trading day)")
        out = PLOTS_DIR / f"ic_vs_horizon_{symbol}.png"
        plt.tight_layout()
        plt.savefig(out, dpi=150, bbox_inches="tight")
        plt.close()
        print(f"Saved: {out}")

    # Side-by-side QQQ vs SPY
    qqq_path = DATA_DIR / "horizons_summary_qqq.csv"
    spy_path = DATA_DIR / "horizons_summary_spy.csv"
    if qqq_path.exists() and spy_path.exists():
        qqq = pd.read_csv(qqq_path)
        spy = pd.read_csv(spy_path)
        fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5), sharey=True)
        _plot_single(ax1, qqq, label_to_min, "QQQ")
        _plot_single(ax2, spy, label_to_min, "SPY")
        fig.suptitle("RF — IC vs horizon, cross-symbol replication\n(QQQ vs SPY, both with 95% block-bootstrap CIs)",
                     fontsize=12, y=1.02)
        plt.tight_layout()
        out = PLOTS_DIR / "ic_vs_horizon_cross_symbol.png"
        plt.savefig(out, dpi=150, bbox_inches="tight")
        plt.close()
        print(f"Saved: {out}")


if __name__ == "__main__":
    sys.exit(main())
