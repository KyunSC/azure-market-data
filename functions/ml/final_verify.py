"""Score a frozen model once on the sealed verify block (see holdout.py).

Fits RF-base and RF-GEX on *all* research data, predicts the verify block, and
appends the result to data/verify_log.jsonl. A config that has already been
scored is refused unless --force, and every run prints how many times this
symbol/horizon's verify block has been looked at — re-tuning after a look turns
verify into research data, and the count keeps that visible.

Run: python functions/ml/final_verify.py --symbol QQQ --horizon-bars 3
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (
    block_bootstrap_ic, compute_metrics,
    FEATURES_BASELINE, FEATURES_BASELINE_PLUS_GEX, TARGET,
)
from holdout import GAP_SESSIONS, VERIFY_START, describe, split_holdout
from train_rf import rf_factory

DATA_DIR = Path(__file__).resolve().parent / "data"
LOG_PATH = DATA_DIR / "verify_log.jsonl"


def config_hash(cfg: dict) -> str:
    return hashlib.sha256(json.dumps(cfg, sort_keys=True, default=str).encode()).hexdigest()[:12]


def read_log() -> list[dict]:
    if not LOG_PATH.exists():
        return []
    return [json.loads(line) for line in LOG_PATH.read_text().splitlines() if line.strip()]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="QQQ")
    parser.add_argument("--horizon-bars", type=int, default=3)
    parser.add_argument("--force", action="store_true",
                        help="Score again even though this exact config was already scored.")
    args = parser.parse_args()
    symbol, h = args.symbol.upper(), args.horizon_bars

    logging.basicConfig(level=logging.WARNING)
    df = pd.read_parquet(DATA_DIR / f"{symbol.lower()}_5m_features_h{h}.parquet")
    research, verify = split_holdout(df)
    if verify.empty:
        raise SystemExit(f"No rows on/after {VERIFY_START.date()} — rebuild the parquet first.")

    model = rf_factory()
    cfg = {
        "symbol": symbol, "horizon_bars": h,
        "verify_start": str(VERIFY_START.date()), "gap_sessions": GAP_SESSIONS,
        "research_end": str(research["date"].max()), "verify_end": str(verify["date"].max()),
        "model": repr(model),
    }
    key = config_hash(cfg)
    log = read_log()
    prior = [r for r in log if r["hash"] == key]
    looks = sum(1 for r in log if r["config"]["symbol"] == symbol and r["config"]["horizon_bars"] == h)

    print(f"research: {describe(research)}")
    print(f"verify:   {describe(verify)}")
    print(f"previous looks at {symbol} h{h} verify: {looks}")
    if prior and not args.force:
        print(f"\nConfig {key} was already scored at {prior[-1]['at']}:")
        for name, m in prior[-1]["results"].items():
            print(f"  {name:8s} IC={m['ic_pearson']:+.4f}  CI=[{m['ci_lo']:+.4f}, {m['ci_hi']:+.4f}]"
                  f"  dir={m['directional_acc']:.3f}")
        raise SystemExit("Refusing to re-score. Pass --force to log another look.")

    results = {}
    for name, features in [("RF-base", FEATURES_BASELINE), ("RF-GEX", FEATURES_BASELINE_PLUS_GEX)]:
        m = rf_factory()
        m.fit(research[features].values, research[TARGET].values)
        pred = m.predict(verify[features].values)
        y = verify[TARGET].values
        met = compute_metrics(y, pred)
        met["ci_lo"], _, met["ci_hi"] = block_bootstrap_ic(y, pred)
        results[name] = met
        print(f"\n{name:8s} IC={met['ic_pearson']:+.4f}  CI=[{met['ci_lo']:+.4f}, {met['ci_hi']:+.4f}]"
              f"  dir={met['directional_acc']:.3f}  Sharpe={met['strategy_sharpe_ann']:+.2f}")
    print(f"\nΔIC (GEX − base) = {results['RF-GEX']['ic_pearson'] - results['RF-base']['ic_pearson']:+.4f}")

    entry = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
             "hash": key, "forced": bool(prior), "config": cfg, "results": results}
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOG_PATH.open("a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"Logged look #{looks + 1} to {LOG_PATH.name}")


if __name__ == "__main__":
    sys.exit(main())
