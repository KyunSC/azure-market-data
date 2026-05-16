"""Build the feature matrix for the GEX-vs-baseline experiment.

Joins QQQ 5-minute bars with the most recent gamma_exposure snapshot
(max 15 minutes stale), computes 14 baseline features + 8 GEX features,
and writes a Parquet file with the 15-minute forward log return target.

Output: functions/ml/data/qqq_5m_features.parquet

Run: python -m functions.ml.build_dataset  (from repo root)
     or  python functions/ml/build_dataset.py
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2

SYMBOL = "QQQ"
INTERVAL = "5m"
HORIZON_BARS = 3
BAR_GRID_MINUTES = 5
GEX_MAX_STALENESS_MINUTES = 15
ROLLING_WINDOW = 20
ATR_WINDOW = 14
RSI_WINDOW = 14
VOLATILITY_WINDOW = 12

FEATURE_COLS_BASELINE = [
    "log_return_5m", "log_return_15m", "log_return_30m", "log_return_60m",
    "realized_vol_60m", "atr_14",
    "volume_zscore_20", "log_dollar_volume",
    "close_position",
    "close_vs_sma20", "rsi_14",
    "minutes_since_open", "hour_sin", "hour_cos",
]
FEATURE_COLS_GEX = [
    "dist_call_wall_atr", "dist_put_wall_atr", "dist_zero_gamma_atr",
    "above_zero_gamma",
    "net_gex", "abs_gex_total", "gex_concentration", "gex_age_minutes",
]
META_COLS = ["date", "computed_at", "target_time"]
TARGET_COL = "target_15m_return"

OUTPUT_PATH = Path(__file__).resolve().parent / "data" / "qqq_5m_features.parquet"


def load_database_url() -> str:
    if "DATABASE_URL" in os.environ:
        return os.environ["DATABASE_URL"]
    settings = Path(__file__).resolve().parent.parent / "local.settings.json"
    if settings.exists():
        cfg = json.loads(settings.read_text())
        url = cfg.get("Values", {}).get("DATABASE_URL")
        if url:
            return url
    raise RuntimeError("DATABASE_URL not found in env or functions/local.settings.json")


def _query_df(conn, sql: str, params: tuple) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()
        cols = [desc[0] for desc in cur.description]
    return pd.DataFrame(rows, columns=cols)


def fetch_bars(conn, symbol: str, interval: str) -> pd.DataFrame:
    sql = """
        SELECT date, open, high, low, close_price AS close, volume
        FROM historical_data
        WHERE symbol = %s AND interval_type = %s
        ORDER BY date
    """
    df = _query_df(conn, sql, (symbol, interval))
    df["date"] = pd.to_datetime(df["date"], utc=True)
    for col in ("open", "high", "low", "close"):
        df[col] = df[col].astype(float)
    df["volume"] = df["volume"].astype(float)
    return df


def fetch_gex_snapshots(conn, symbol: str) -> pd.DataFrame:
    sql = """
        SELECT
            ge.computed_at,
            MAX(CASE WHEN gl.label = 'call_wall'  THEN gl.strike_etf END) AS call_wall,
            MAX(CASE WHEN gl.label = 'put_wall'   THEN gl.strike_etf END) AS put_wall,
            MAX(CASE WHEN gl.label = 'zero_gamma' THEN gl.strike_etf END) AS zero_gamma,
            SUM(gl.gex)                  AS net_gex,
            SUM(ABS(gl.gex))             AS abs_gex_total,
            SUM(POWER(gl.gex, 2))        AS sum_gex_squared
        FROM gamma_exposure ge
        JOIN gamma_levels gl ON gl.gamma_exposure_id = ge.id
        WHERE ge.symbol = %s
        GROUP BY ge.computed_at
        ORDER BY ge.computed_at
    """
    df = _query_df(conn, sql, (symbol,))
    df["computed_at"] = pd.to_datetime(df["computed_at"], utc=True)
    for col in ("call_wall", "put_wall", "zero_gamma", "net_gex", "abs_gex_total", "sum_gex_squared"):
        df[col] = df[col].astype(float)
    df["gex_concentration"] = df["sum_gex_squared"] / (df["abs_gex_total"] ** 2)
    return df.drop(columns=["sum_gex_squared"])


def asof_join_gex(bars: pd.DataFrame, gex: pd.DataFrame) -> pd.DataFrame:
    bars_s = bars.sort_values("date").reset_index(drop=True)
    gex_s = gex.sort_values("computed_at").reset_index(drop=True)

    joined = pd.merge_asof(
        bars_s, gex_s,
        left_on="date", right_on="computed_at",
        direction="backward",
        tolerance=pd.Timedelta(minutes=GEX_MAX_STALENESS_MINUTES),
    )
    joined["gex_age_minutes"] = (joined["date"] - joined["computed_at"]).dt.total_seconds() / 60.0

    before = len(joined)
    joined = joined.dropna(subset=["computed_at"]).reset_index(drop=True)
    logging.info("asof_join: %d bars had no GEX within %dmin (dropped)",
                 before - len(joined), GEX_MAX_STALENESS_MINUTES)

    assert (joined["computed_at"] <= joined["date"]).all(), "LEAK: gex computed_at after bar.date"
    assert (joined["gex_age_minutes"] <= GEX_MAX_STALENESS_MINUTES).all()
    return joined


def compute_baseline_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.sort_values("date").reset_index(drop=True).copy()
    log_close = np.log(df["close"])

    df["log_return_5m"]  = log_close.diff(1)
    df["log_return_15m"] = log_close.diff(3)
    df["log_return_30m"] = log_close.diff(6)
    df["log_return_60m"] = log_close.diff(12)

    df["realized_vol_60m"] = df["log_return_5m"].rolling(VOLATILITY_WINDOW).std()

    prev_close = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev_close).abs(),
        (df["low"]  - prev_close).abs(),
    ], axis=1).max(axis=1)
    df["atr_14"] = tr.rolling(ATR_WINDOW).mean()

    vol_mean = df["volume"].rolling(ROLLING_WINDOW).mean()
    vol_std  = df["volume"].rolling(ROLLING_WINDOW).std()
    df["volume_zscore_20"] = (df["volume"] - vol_mean) / vol_std
    df["log_dollar_volume"] = np.log1p(df["close"] * df["volume"])

    bar_range = (df["high"] - df["low"]).replace(0, np.nan)
    df["close_position"] = (df["close"] - df["low"]) / bar_range

    sma20 = df["close"].rolling(ROLLING_WINDOW).mean()
    df["close_vs_sma20"] = df["close"] / sma20 - 1.0

    delta = df["close"].diff()
    gain = delta.clip(lower=0).rolling(RSI_WINDOW).mean()
    loss = (-delta.clip(upper=0)).rolling(RSI_WINDOW).mean()
    rs = gain / loss.replace(0, np.nan)
    df["rsi_14"] = 100.0 - 100.0 / (1.0 + rs)

    minute_of_day = df["date"].dt.hour * 60 + df["date"].dt.minute
    df["minutes_since_open"] = (minute_of_day - (13 * 60 + 30)).astype(float)
    df["hour_sin"] = np.sin(2 * np.pi * minute_of_day / 1440)
    df["hour_cos"] = np.cos(2 * np.pi * minute_of_day / 1440)

    return df


def compute_gex_features(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    atr = df["atr_14"].replace(0, np.nan)
    df["dist_call_wall_atr"]  = (df["close"] - df["call_wall"])  / atr
    df["dist_put_wall_atr"]   = (df["close"] - df["put_wall"])   / atr
    df["dist_zero_gamma_atr"] = (df["close"] - df["zero_gamma"]) / atr
    df["above_zero_gamma"]    = np.sign(df["close"] - df["zero_gamma"])
    return df


def compute_target(df: pd.DataFrame, horizon_bars: int) -> pd.DataFrame:
    df = df.sort_values("date").reset_index(drop=True).copy()
    expected_gap = pd.Timedelta(minutes=BAR_GRID_MINUTES * horizon_bars)

    future_close = df["close"].shift(-horizon_bars)
    future_time  = df["date"].shift(-horizon_bars)
    same_session = (future_time - df["date"]) == expected_gap

    df["target_time"] = future_time.where(same_session)
    df[TARGET_COL] = np.where(same_session, np.log(future_close / df["close"]), np.nan)

    valid = df[TARGET_COL].notna()
    assert (df.loc[valid, "target_time"] > df.loc[valid, "date"]).all(), "LEAK: target_time <= bar.date"
    return df


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    db_url = load_database_url()
    with psycopg2.connect(db_url) as conn:
        bars = fetch_bars(conn, SYMBOL, INTERVAL)
        gex  = fetch_gex_snapshots(conn, SYMBOL)

    logging.info("Loaded %d bars, %d gex snapshots", len(bars), len(gex))

    joined = asof_join_gex(bars, gex)
    logging.info("After asof join (≤%dmin staleness): %d rows", GEX_MAX_STALENESS_MINUTES, len(joined))

    joined = compute_baseline_features(joined)
    joined = compute_gex_features(joined)
    joined = compute_target(joined, HORIZON_BARS)

    all_features = FEATURE_COLS_BASELINE + FEATURE_COLS_GEX
    keep_cols = META_COLS + [TARGET_COL] + all_features
    final = joined[keep_cols].copy()

    before = len(final)
    final = final.dropna(subset=all_features + [TARGET_COL]).reset_index(drop=True)
    logging.info("After dropping NaNs (rolling warmup + session-end targets): %d rows (%d dropped)",
                 len(final), before - len(final))

    assert (final["computed_at"] <= final["date"]).all(), "LEAK: GEX after bar.date"
    assert (final["target_time"] > final["date"]).all(), "LEAK: target before bar.date"
    assert (final["target_time"] - final["date"] == pd.Timedelta(minutes=BAR_GRID_MINUTES * HORIZON_BARS)).all(), \
        "Target gap is not exactly 15 minutes"

    logging.info("Final dataset: %d rows, %d feature cols", len(final), len(all_features))
    logging.info("Date range: %s -> %s", final["date"].min(), final["date"].max())
    logging.info("Target mean=%.6f std=%.6f min=%.6f max=%.6f",
                 final[TARGET_COL].mean(), final[TARGET_COL].std(),
                 final[TARGET_COL].min(), final[TARGET_COL].max())

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    final.to_parquet(OUTPUT_PATH, index=False)
    logging.info("Wrote %s (%d rows, %d cols)", OUTPUT_PATH, len(final), len(final.columns))


if __name__ == "__main__":
    sys.exit(main())
