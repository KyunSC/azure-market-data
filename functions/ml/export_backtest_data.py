"""Export the research-plane dataset consumed by the frontend backtester.

`/api/gamma` only exposes the *current* GEX snapshot, so GEX and ML strategies
cannot be backtested off the live API. This script turns the bar-aligned
historical GEX that already lives in `functions/ml/data/*.parquet` into a static
JSON asset under `frontend/public/backtest/` — a data asset, not an endpoint.

Three joins happen here:
  1. the feature parquet (GEX + baseline features per 5m bar),
  2. OHLCV bars pulled from the public `/api/historical` endpoint (the parquet
     drops raw prices; the backtest engine needs them to fill orders),
  3. walk-forward OOS predictions from a freshly-fit RF, so the `mlSignal`
     strategy and the walk-forward panel show honest out-of-sample numbers.

Output is columnar (`{"close": [...], "volume": [...]}`) rather than row
objects: ~4x smaller over the wire and already the shape the engine wants.

Run:
    python functions/ml/export_backtest_data.py
    python functions/ml/export_backtest_data.py --symbols QQQ --horizon-bars 3
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

sys.path.insert(0, str(Path(__file__).resolve().parent))
from eval import (  # noqa: E402
    FEATURES_BASELINE,
    FEATURES_BASELINE_PLUS_GEX,
    FEATURES_GEX,
    TARGET,
    compute_metrics,
)

DATA_DIR = Path(__file__).resolve().parent / "data"
DEFAULT_OUT_DIR = Path(__file__).resolve().parents[2] / "frontend" / "public" / "backtest"
DEFAULT_API = "https://azure-market-data.onrender.com"

# Feature columns shipped to the browser. Everything the rule builder, the GEX
# strategies and the ML strategy can reference.
EXPORT_FEATURES = FEATURES_BASELINE_PLUS_GEX + ["close_vs_sma20", "minutes_since_open"]

# Walk-forward layout for the exported OOS predictions. Bigger test folds than
# eval.py's default (100) so the ML strategy has enough OOS bars to trade.
N_SPLITS = 5
MIN_TRAIN_FRACTION = 0.35  # first fold trains on at least this much of the sample

PRICE_DP = 4
FEATURE_SIG = 6


def fetch_bars(api_base: str, symbol: str, period: str, interval: str) -> pd.DataFrame:
    """Pull OHLCV from the Spring Boot historical endpoint (no credentials needed)."""
    qs = urllib.parse.urlencode({"symbol": symbol, "period": period, "interval": interval})
    url = f"{api_base.rstrip('/')}/api/historical?{qs}"
    logging.info("GET %s", url)
    # Render free tier cold-boots in 30-60s; give it room.
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        payload = json.loads(resp.read())

    rows = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not rows:
        raise SystemExit(f"No bars returned for {symbol} {period} {interval}")

    df = pd.DataFrame(rows)
    df["time"] = df["time"].astype(np.int64)
    df["date"] = pd.to_datetime(df["time"], unit="s", utc=True)
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float)
    df["volume"] = df["volume"].fillna(0).astype(float)
    return df[["date", "time", "open", "high", "low", "close", "volume"]].sort_values("date")


def walk_forward_predictions(df: pd.DataFrame, features: list[str], test_size: int) -> dict:
    """Expanding-window walk-forward mirroring eval.walk_forward, but also keeping
    the in-sample fit so the UI can render IS-vs-OOS per fold (the honest
    comparison — an IS Sharpe that dwarfs OOS is the overfitting tell)."""
    X = df[features].values
    y = df[TARGET].values
    n = len(df)

    pred = np.full(n, np.nan)
    fold_id = np.full(n, np.nan)
    folds = []

    first_test = n - N_SPLITS * test_size
    if first_test < MIN_TRAIN_FRACTION * n:
        raise SystemExit(f"test_size={test_size} leaves too little training data ({first_test} rows)")

    for k in range(N_SPLITS):
        test_start = first_test + k * test_size
        test_end = test_start + test_size
        train_idx = np.arange(0, test_start)
        test_idx = np.arange(test_start, test_end)

        model = RandomForestRegressor(
            n_estimators=300, min_samples_leaf=10, max_features="sqrt",
            n_jobs=-1, random_state=42,
        )
        model.fit(X[train_idx], y[train_idx])

        oos = model.predict(X[test_idx])
        ins = model.predict(X[train_idx])
        pred[test_idx] = oos
        fold_id[test_idx] = k + 1

        m_oos = compute_metrics(y[test_idx], oos)
        m_is = compute_metrics(y[train_idx], ins)
        folds.append({
            "fold": k + 1,
            "trainStart": int(train_idx[0]),
            "trainEnd": int(train_idx[-1]),
            "testStart": int(test_start),
            "testEnd": int(test_end - 1),
            "nTrain": int(len(train_idx)),
            "nTest": int(len(test_idx)),
            "isSharpe": round(float(m_is["strategy_sharpe_ann"]), 4),
            "oosSharpe": round(float(m_oos["strategy_sharpe_ann"]), 4),
            "isIc": round(float(m_is["ic_pearson"]), 4),
            "oosIc": round(float(m_oos["ic_pearson"]), 4),
            "oosDirAcc": round(float(m_oos["directional_acc"]), 4),
        })
        logging.info("fold %d: train=%d test=%d  OOS IC=%+.4f  OOS Sharpe=%+.2f",
                     k + 1, len(train_idx), len(test_idx),
                     m_oos["ic_pearson"], m_oos["strategy_sharpe_ann"])

    mask = ~np.isnan(pred)
    overall = compute_metrics(y[mask], pred[mask])
    return {
        "pred": pred,
        "foldId": fold_id,
        "folds": folds,
        "overall": {k: (round(float(v), 4) if isinstance(v, float) else v) for k, v in overall.items()},
    }


def _round(x, dp=None, sig=None):
    if x is None:
        return None
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return None
    if dp is not None:
        return round(v, dp)
    if v == 0:
        return 0.0
    mag = math.floor(math.log10(abs(v)))
    return round(v, max(0, sig - 1 - mag))


def build_symbol(symbol: str, horizon_bars: int, api_base: str, period: str, skip_ml: bool) -> dict:
    parquet = DATA_DIR / f"{symbol.lower()}_5m_features_h{horizon_bars}.parquet"
    if not parquet.exists():
        raise SystemExit(f"Missing {parquet}. Run build_dataset.py --symbol {symbol} --horizon-bars {horizon_bars}")

    feat = pd.read_parquet(parquet)
    feat["date"] = pd.to_datetime(feat["date"], utc=True)
    logging.info("%s: %d feature rows %s -> %s", symbol, len(feat),
                 feat["date"].min().date(), feat["date"].max().date())

    bars = fetch_bars(api_base, symbol, period, "5m")
    logging.info("%s: %d OHLCV bars %s -> %s", symbol, len(bars),
                 bars["date"].min().date(), bars["date"].max().date())

    df = feat.merge(bars, on="date", how="inner").sort_values("date").reset_index(drop=True)
    dropped = len(feat) - len(df)
    if dropped:
        logging.warning("%s: %d feature rows had no matching bar and were dropped", symbol, dropped)
    if df.empty:
        raise SystemExit(f"{symbol}: feature dates and bar dates do not overlap")

    # The engine needs a clean matrix — drop rows where a model feature is NaN
    # (early warm-up bars, and the pre-migration rows for flow/0DTE columns
    # which we do not export anyway).
    before = len(df)
    df = df.dropna(subset=FEATURES_BASELINE_PLUS_GEX + [TARGET]).reset_index(drop=True)
    if len(df) != before:
        logging.info("%s: dropped %d rows with NaN model features", symbol, before - len(df))

    ml = None
    if not skip_ml:
        test_size = max(120, len(df) // 10)
        ml = walk_forward_predictions(df, FEATURES_BASELINE_PLUS_GEX, test_size)

    out = {
        "symbol": symbol,
        "interval": "5m",
        "horizonBars": horizon_bars,
        "horizonMinutes": horizon_bars * 5,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": f"{parquet.name} + /api/historical",
        "bars": len(df),
        "start": df["date"].min().isoformat(),
        "end": df["date"].max().isoformat(),
        "time": [int(t) for t in df["time"]],
        "open": [_round(v, dp=PRICE_DP) for v in df["open"]],
        "high": [_round(v, dp=PRICE_DP) for v in df["high"]],
        "low": [_round(v, dp=PRICE_DP) for v in df["low"]],
        "close": [_round(v, dp=PRICE_DP) for v in df["close"]],
        "volume": [int(v) for v in df["volume"]],
        "features": {
            col: [_round(v, sig=FEATURE_SIG) for v in df[col]]
            for col in EXPORT_FEATURES if col in df.columns
        },
        "featureGroups": {
            "baseline": [c for c in FEATURES_BASELINE if c in df.columns],
            "gex": [c for c in FEATURES_GEX if c in df.columns],
        },
    }

    if ml is not None:
        out["ml"] = {
            "model": "RandomForest(300, leaf=10, sqrt) on baseline+GEX",
            "target": f"forward log return, {horizon_bars * 5}m",
            "pred": [_round(v, sig=FEATURE_SIG) for v in ml["pred"]],
            "target_return": [_round(v, sig=FEATURE_SIG) for v in df[TARGET]],
            "fold": [None if math.isnan(f) else int(f) for f in ml["foldId"]],
            "folds": ml["folds"],
            "overall": ml["overall"],
            "oosStart": int(np.argmax(~np.isnan(ml["pred"]))),
        }
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbols", nargs="+", default=["QQQ", "SPY"])
    ap.add_argument("--horizon-bars", type=int, default=3)
    ap.add_argument("--api", default=DEFAULT_API, help="Spring Boot base URL for OHLCV")
    ap.add_argument("--period", default="6mo", help="period passed to /api/historical")
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR)
    ap.add_argument("--skip-ml", action="store_true", help="skip the walk-forward RF fit")
    args = ap.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    args.out.mkdir(parents=True, exist_ok=True)

    manifest = []
    for symbol in (s.upper() for s in args.symbols):
        payload = build_symbol(symbol, args.horizon_bars, args.api, args.period, args.skip_ml)
        path = args.out / f"{symbol.lower()}_5m.json"
        path.write_text(json.dumps(payload, separators=(",", ":")))
        kb = path.stat().st_size / 1024
        logging.info("wrote %s (%.0f KB, %d bars)", path, kb, payload["bars"])
        manifest.append({
            "symbol": symbol,
            "file": path.name,
            "bars": payload["bars"],
            "start": payload["start"],
            "end": payload["end"],
            "interval": "5m",
            "horizonMinutes": payload["horizonMinutes"],
            "sizeKb": round(kb),
            "hasMl": "ml" in payload,
            "oosSharpe": payload.get("ml", {}).get("overall", {}).get("strategy_sharpe_ann"),
            "oosIc": payload.get("ml", {}).get("overall", {}).get("ic_pearson"),
        })

    index = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "datasets": manifest,
    }
    (args.out / "index.json").write_text(json.dumps(index, indent=2))
    logging.info("wrote %s", args.out / "index.json")


if __name__ == "__main__":
    sys.exit(main())
