"""Results table for the ThetaData (2022+) runs: symbol x horizon x GEX variant.

Reads the OOS predictions train_rf.py saved and reports RF-base IC, RF-GEX IC and dIC,
each with a 95% block-bootstrap CI. The dIC CI is paired: both models are scored on the
same resampled blocks, so it reflects the uncertainty of the difference, not of each IC.

Variants:
  td          nearest-4-expiry GEX (live logic)            train_rf.py --tag td
  td+0dte     td plus the four 0DTE share features         train_rf.py --tag td --with-0dte
  td0dte      GEX rebuilt from same-day expiries only      train_rf.py --tag td0dte

Run: python functions/ml/td_results.py      # -> data/td_results.csv
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import session_ids

DATA_DIR = Path(__file__).resolve().parent / "data"
SYMBOLS = ["QQQ", "SPY"]
HORIZONS = [1, 3, 6, 12, 24]
VARIANTS = {"td": "_td", "td+0dte": "_td_0dtefeat", "td0dte": "_td0dte"}


def _ic(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.corrcoef(y, p)[0, 1])


def paired_block_bootstrap(y, base, gex, n_resamples=1000, block_size=73, seed=42):
    """Same resampling scheme as eval.block_bootstrap_ic, applied to both models at once."""
    rng = np.random.default_rng(seed)
    n = len(y)
    n_blocks = int(np.ceil(n / block_size))
    out = np.empty((n_resamples, 3))
    for i in range(n_resamples):
        starts = rng.integers(0, n - block_size + 1, size=n_blocks)
        idx = (starts[:, None] + np.arange(block_size)).ravel()[:n]
        b, g = _ic(y[idx], base[idx]), _ic(y[idx], gex[idx])
        out[i] = b, g, g - b
    return np.percentile(out, [2.5, 97.5], axis=0)


def main() -> None:
    rows = []
    for sym in SYMBOLS:
        for h in HORIZONS:
            for name, suffix in VARIANTS.items():
                path = DATA_DIR / f"rf_oos_predictions_{sym.lower()}_h{h}{suffix}.parquet"
                if not path.exists():
                    continue
                oos = pd.read_parquet(path).sort_values("date")
                y, b, g = (oos[c].to_numpy() for c in ("y_true", "rf_base_pred", "rf_gex_pred"))
                ci = paired_block_bootstrap(y, b, g)
                rows.append({
                    "symbol": sym, "horizon_min": 5 * h, "variant": name,
                    "oos_sessions": len(np.unique(session_ids(oos["date"]))), "oos_rows": len(oos),
                    "base_ic": _ic(y, b), "base_lo": ci[0, 0], "base_hi": ci[1, 0],
                    "gex_ic": _ic(y, g), "gex_lo": ci[0, 1], "gex_hi": ci[1, 1],
                    "d_ic": _ic(y, g) - _ic(y, b), "d_lo": ci[0, 2], "d_hi": ci[1, 2],
                })
    df = pd.DataFrame(rows)
    df.to_csv(DATA_DIR / "td_results.csv", index=False)

    print("| symbol | horizon | variant | OOS sessions | base IC [95% CI] | GEX IC [95% CI] | dIC [95% CI] |")
    print("|---|---|---|---|---|---|---|")
    for r in df.itertuples():
        flag = " **" if r.d_lo > 0 else (" *" if r.d_ic > 0 else "")
        print(f"| {r.symbol} | {r.horizon_min}m | {r.variant} | {r.oos_sessions} "
              f"| {r.base_ic:+.4f} [{r.base_lo:+.3f}, {r.base_hi:+.3f}] "
              f"| {r.gex_ic:+.4f} [{r.gex_lo:+.3f}, {r.gex_hi:+.3f}] "
              f"| {r.d_ic:+.4f} [{r.d_lo:+.3f}, {r.d_hi:+.3f}]{flag} |")
    print("\n* dIC > 0 (candidate for null_test.py); ** paired CI excludes 0")
    print(f"Saved {DATA_DIR / 'td_results.csv'}")


if __name__ == "__main__":
    sys.exit(main())
