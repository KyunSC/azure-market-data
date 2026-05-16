"""RF sweep across prediction horizons.

For each horizon in {5, 15, 30, 60, 120} minutes, trains RF-base + RF-GEX and reports
IC with 95% block-bootstrap CI and directional accuracy. The point of the sweep is to
locate the timescale (if any) at which GEX features carry signal — not to maximize
metrics at a single horizon.

Output:
  - Console: per-horizon results + delta table
  - functions/ml/data/horizons_summary.csv
"""
from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

import pandas as pd
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import walk_forward, FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent / "data"

HORIZONS = [
    (1, "5min"),
    (3, "15min"),
    (6, "30min"),
    (12, "60min"),
    (24, "120min"),
]


def rf_factory():
    return RandomForestRegressor(
        n_estimators=500, min_samples_leaf=10, max_features="sqrt",
        n_jobs=-1, random_state=42,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="QQQ",
                        help="Symbol prefix for the input parquet files (default QQQ).")
    args = parser.parse_args()
    symbol = args.symbol.lower()

    logging.basicConfig(level=logging.WARNING)

    rows = []
    for h_bars, h_label in HORIZONS:
        path = DATA_DIR / f"{symbol}_5m_features_h{h_bars}.parquet"
        df = pd.read_parquet(path)
        print(f"\n=== {symbol.upper()}  Horizon {h_label}  (h={h_bars} bars,  n={len(df)}) ===")

        for variant, features in [
            ("RF-base", FEATURES_BASELINE),
            ("RF-GEX",  FEATURES_BASELINE_PLUS_GEX),
        ]:
            res = walk_forward(df, features=features, model_factory=rf_factory)
            m = res.overall_metrics
            ci_lo, _, ci_hi = res.bootstrap_ci
            rows.append({
                "horizon": h_label, "h_bars": h_bars, "model": variant,
                "n_total": len(df), "n_oos": m["n_obs"],
                "ic": m["ic_pearson"],
                "ic_ci_lo": ci_lo, "ic_ci_hi": ci_hi,
                "ic_spearman": m["ic_spearman"],
                "dir_acc": m["directional_acc"],
            })
            print(f"  {variant:8s}  IC={m['ic_pearson']:+.4f}  "
                  f"CI=[{ci_lo:+.4f},{ci_hi:+.4f}]  "
                  f"Spearman={m['ic_spearman']:+.4f}  "
                  f"dir_acc={m['directional_acc']:.3f}")

    out = pd.DataFrame(rows)
    out_csv = DATA_DIR / f"horizons_summary_{symbol}.csv"
    out.to_csv(out_csv, index=False)

    print("\n\n========== Horizon-by-horizon DELTA (GEX minus base) ==========")
    print(f"{'horizon':<10}{'n_oos':<8}{'IC base':<12}{'IC gex':<12}{'d(IC)':<11}{'d(dir)':<10}{'CI overlaps 0?':<15}")
    for h_bars, h_label in HORIZONS:
        b = next(r for r in rows if r["h_bars"] == h_bars and r["model"] == "RF-base")
        g = next(r for r in rows if r["h_bars"] == h_bars and r["model"] == "RF-GEX")
        d_ic  = g["ic"] - b["ic"]
        d_dir = g["dir_acc"] - b["dir_acc"]
        ci_msg = "yes" if (g["ic_ci_lo"] < 0 < g["ic_ci_hi"]) else "NO"
        print(f"{h_label:<10}{b['n_oos']:<8}{b['ic']:<+12.4f}{g['ic']:<+12.4f}{d_ic:<+11.4f}{d_dir:<+10.4f}{ci_msg:<15}")

    print(f"\nSaved: {out_csv}")


if __name__ == "__main__":
    sys.exit(main())
