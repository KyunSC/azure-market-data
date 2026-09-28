"""GEX time-shift null test: does *aligned* GEX beat GEX from the wrong days?

Real statistic: ΔIC = IC(RF-GEX) − IC(RF-base) under the standard walk-forward.

Null: circularly roll every FEATURES_GEX column together by a whole number of
sessions k (MIN_SHIFT ≤ k ≤ n_sessions − MIN_SHIFT), then rerun RF-GEX. There are
only ~n_sessions such shifts, so every one is run once (an exact permutation
distribution); --perms caps it by sampling without replacement. The rolled
block keeps GEX's own distribution and autocorrelation but lines it up with the
wrong days' prices, so any ΔIC it earns is what "extra GEX-shaped columns" buys by
luck. RF-base doesn't depend on GEX, so it is fitted once.

p-value = (1 + #null ΔIC ≥ real ΔIC) / (1 + N) — share of misaligned GEX that did
at least as well as the real thing. With N shifts the smallest possible p is
1 / (1 + N), e.g. ~0.014 for 78 sessions.

Research data only (holdout.load_research); the verify block is never touched.

Run: python functions/ml/null_test.py --symbol QQQ --horizon-bars 3
     python functions/ml/null_test.py --symbol QQQ --horizon-bars 3 --tag td --perms 199
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (
    session_ids, walk_forward,
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, FEATURES_GEX,
)
from holdout import describe, load_research

DATA_DIR = Path(__file__).resolve().parent / "data"
PLOTS_DIR = Path(__file__).resolve().parent / "plots"
MIN_SHIFT = 5  # sessions — closer than a week and the rolled GEX is still near-aligned


def rf_factory():
    # Fewer trees than train_rf (500) so 200 permutations finish in minutes. Real
    # and null runs share this exact model and seed, so the comparison is fair.
    return RandomForestRegressor(
        n_estimators=100, min_samples_leaf=10, max_features="sqrt",
        n_jobs=-1, random_state=42,
    )


def gex_delta_ic(df, base_ic: float) -> float:
    res = walk_forward(df, features=FEATURES_BASELINE_PLUS_GEX, model_factory=rf_factory,
                       bootstrap_resamples=0)
    return res.overall_metrics["ic_pearson"] - base_ic


def shift_gex(df, session_start: np.ndarray, k: int):
    """Roll the GEX block forward by k sessions (row offset = start of session k)."""
    out = df.copy()
    out[FEATURES_GEX] = np.roll(df[FEATURES_GEX].to_numpy(), session_start[k], axis=0)
    return out


def plot(null: np.ndarray, real: float, p: float, title: str, out: Path) -> None:
    ink, muted, bars = "#0b0b0b", "#52514e", "#2a78d6"
    fig, ax = plt.subplots(figsize=(8, 4.5))
    ax.hist(null, bins=30, color=bars, edgecolor="#fcfcfb", linewidth=1.5)
    ax.axvline(real, color=ink, lw=2)
    ax.annotate(f"real GEX  ΔIC = {real:+.4f}\np = {p:.3f}", xy=(real, ax.get_ylim()[1] * 0.92),
                xytext=(8, 0), textcoords="offset points", color=ink, fontsize=9, va="top")
    ax.axvline(0, color=muted, lw=0.8, ls="--")
    ax.set_xlabel("ΔIC  (RF-GEX − RF-base)", color=muted)
    ax.set_ylabel("Shifted-GEX runs", color=muted)
    ax.set_title(title, loc="left", fontsize=11, color=ink)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.spines["left"].set_color(muted)
    ax.spines["bottom"].set_color(muted)
    ax.tick_params(colors=muted)
    ax.grid(axis="y", alpha=0.25)
    ax.set_axisbelow(True)
    plt.tight_layout()
    plt.savefig(out, dpi=150, bbox_inches="tight")
    plt.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="QQQ")
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--perms", type=int, default=0,
                        help="Max shifts to run (0 = all of them).")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--tag", default="", help="dataset suffix, e.g. td for the ThetaData rebuild")
    args = parser.parse_args()
    symbol, h = args.symbol.lower(), args.horizon_bars
    suffix = f"_{args.tag}" if args.tag else ""

    logging.basicConfig(level=logging.WARNING)
    df = load_research(DATA_DIR / f"{symbol}_5m_features_h{h}{suffix}.parquet")
    sid = session_ids(df["date"])
    n_sessions = int(sid.max()) + 1
    session_start = np.searchsorted(sid, np.arange(n_sessions))
    print(f"{symbol.upper()} h{h} research: {describe(df)}")
    if n_sessions < 2 * MIN_SHIFT + 1:
        raise SystemExit(f"Need ≥ {2 * MIN_SHIFT + 1} sessions for a ≥{MIN_SHIFT}-session shift")

    base_ic = walk_forward(df, features=FEATURES_BASELINE, model_factory=rf_factory,
                           bootstrap_resamples=0).overall_metrics["ic_pearson"]
    real = gex_delta_ic(df, base_ic)
    # shift 0 must reproduce the real run — guards the shifting code itself. Not ==:
    # the forest sums per-tree predictions in thread order, so reruns differ by ~1e-17.
    assert abs(gex_delta_ic(shift_gex(df, session_start, 0), base_ic) - real) < 1e-12
    print(f"RF-base IC = {base_ic:+.4f}   real ΔIC = {real:+.4f}")

    shifts = np.arange(MIN_SHIFT, n_sessions - MIN_SHIFT + 1)
    if 0 < args.perms < len(shifts):
        shifts = np.sort(np.random.default_rng(args.seed).choice(shifts, args.perms, replace=False))
    n = len(shifts)
    null = np.empty(n)
    t0 = time.time()
    for i, k in enumerate(shifts):
        null[i] = gex_delta_ic(shift_gex(df, session_start, int(k)), base_ic)
        if (i + 1) % 10 == 0 or i + 1 == n:
            print(f"  {i + 1}/{n}  ({time.time() - t0:.0f}s)", flush=True)

    p = (1 + int((null >= real).sum())) / (1 + n)
    lo, med, hi = np.percentile(null, [5, 50, 95])
    print(f"\nnull ΔIC: median={med:+.4f}  5%={lo:+.4f}  95%={hi:+.4f}")
    print(f"real ΔIC: {real:+.4f}   p = {p:.3f}   "
          f"({'beats' if p < 0.05 else 'does not beat'} misaligned GEX at 5%)")

    PLOTS_DIR.mkdir(parents=True, exist_ok=True)
    stem = f"gex_null_{symbol}_h{h}{suffix}"
    plot(null, real, p,
         f"{symbol.upper()} {5 * h}-min — real GEX vs {n} session-shifted GEX\n"
         f"walk-forward ΔIC over RF-base, p = {p:.3f}",
         PLOTS_DIR / f"{stem}.png")
    (DATA_DIR / f"{stem}.json").write_text(json.dumps({
        "symbol": symbol.upper(), "horizon_bars": h, "n_shifts": n, "seed": args.seed,
        "base_ic": base_ic, "real_delta_ic": real, "p_value": p,
        "null_median": med, "null_p05": lo, "null_p95": hi,
        "shifts": shifts.tolist(), "null": null.tolist(),
    }, indent=1))
    print(f"Saved: {PLOTS_DIR / (stem + '.png')}")


if __name__ == "__main__":
    sys.exit(main())
