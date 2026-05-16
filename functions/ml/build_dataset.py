"""Build the feature matrix for the GEX-vs-baseline experiment.

Joins 5-minute bars for the chosen symbol with the most recent gamma_exposure snapshot
(max 15 min stale), computes 14 baseline features + 8 GEX features, and writes a Parquet
with a forward log return target whose horizon is controlled by --horizon-bars (each bar
= 5 min).

Output: functions/ml/data/{symbol_lower}_5m_features_h{N}.parquet

Run: python functions/ml/build_dataset.py --symbol QQQ --horizon-bars 3
     python functions/ml/build_dataset.py --symbol SPY --horizon-bars 12
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import psycopg2

INTERVAL = "5m"
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
    "above_zero_gamma", "gamma_regime_strength",
    "net_gex", "abs_gex_total", "gex_concentration", "gex_age_minutes",
    "call_wall_strength", "put_wall_strength",
]
# Option-flow features — available only in post-migration snapshots.
# Include in the parquet but NOT in training feature sets until enough
# post-migration rows accumulate (pre-migration rows will have NaN).
FEATURE_COLS_FLOW = ["pcr_volume", "pcr_oi", "iv_atm", "iv_skew"]

META_COLS = ["date", "computed_at", "target_time"]
TARGET_COL = "target_return"

OUTPUT_DIR = Path(__file__).resolve().parent / "data"


def load_supabase_rest_creds() -> Optional[tuple[str, str]]:
    """Read (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) from env or local.settings.json.
    Returns None if not configured. When present, takes precedence over DB connection.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not (url and key):
        settings = Path(__file__).resolve().parent.parent / "local.settings.json"
        if settings.exists():
            vals = json.loads(settings.read_text()).get("Values", {})
            url = url or vals.get("SUPABASE_URL")
            key = key or vals.get("SUPABASE_SERVICE_ROLE_KEY")
    if url and key:
        return url.rstrip("/"), key
    return None


def _rest_get(base: str, key: str, table: str, params: dict, page_size: int = 1000) -> list:
    rows: list = []
    offset = 0
    while True:
        q = dict(params)
        q["limit"] = page_size
        q["offset"] = offset
        full_url = f"{base}/rest/v1/{table}?{urllib.parse.urlencode(q)}"
        req = urllib.request.Request(full_url, headers={
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            page = json.loads(resp.read())
        rows.extend(page)
        if len(page) < page_size:
            return rows
        offset += page_size


def fetch_bars_rest(base: str, key: str, symbol: str, interval: str) -> pd.DataFrame:
    rows = _rest_get(base, key, "historical_data", {
        "symbol": f"eq.{symbol}",
        "interval_type": f"eq.{interval}",
        "select": "date,open,high,low,close_price,volume",
        "order": "date.asc",
    })
    df = pd.DataFrame(rows).rename(columns={"close_price": "close"})
    df["date"] = pd.to_datetime(df["date"], utc=True)
    for col in ("open", "high", "low", "close", "volume"):
        df[col] = df[col].astype(float)
    return df


def fetch_gex_snapshots_rest(base: str, key: str, symbol: str) -> pd.DataFrame:
    # Fetch exposures and levels in separate paginated calls, then join in Python.
    # Embedded nested fetch hit Supabase's payload limits at scale.
    ge_rows = _rest_get(base, key, "gamma_exposure", {
        "symbol": f"eq.{symbol}",
        "select": "id,computed_at,pcr_volume,pcr_oi,iv_atm,iv_skew",
        "order": "computed_at.asc",
    })
    if not ge_rows:
        return pd.DataFrame()

    gl_rows = _rest_get(base, key, "gamma_levels", {
        "select": "gamma_exposure_id,label,strike_etf,gex,gamma_exposure!inner(symbol)",
        "gamma_exposure.symbol": f"eq.{symbol}",
    })
    logging.info("REST: fetched %d exposures, %d levels", len(ge_rows), len(gl_rows))

    levels_by_id: dict = {}
    for lvl in gl_rows:
        levels_by_id.setdefault(lvl["gamma_exposure_id"], []).append(lvl)

    out = []
    for ge in ge_rows:
        levels = levels_by_id.get(ge["id"], [])
        if not levels:
            continue
        agg = {"computed_at": ge["computed_at"],
               "call_wall": None, "put_wall": None, "zero_gamma": None,
               "call_wall_gex": None, "put_wall_gex": None,
               "net_gex": 0.0, "abs_gex_total": 0.0, "sum_gex_squared": 0.0,
               # Option-flow fields (NULL on pre-migration snapshots)
               "pcr_volume": ge.get("pcr_volume"),
               "pcr_oi":     ge.get("pcr_oi"),
               "iv_atm":     ge.get("iv_atm"),
               "iv_skew":    ge.get("iv_skew"),
               }
        for lvl in levels:
            label = lvl["label"]
            g = float(lvl["gex"])
            if label == "call_wall":
                agg["call_wall"] = lvl["strike_etf"]
                agg["call_wall_gex"] = g
            elif label == "put_wall":
                agg["put_wall"] = lvl["strike_etf"]
                agg["put_wall_gex"] = g
            elif label == "zero_gamma":
                agg["zero_gamma"] = lvl["strike_etf"]
            agg["net_gex"] += g
            agg["abs_gex_total"] += abs(g)
            agg["sum_gex_squared"] += g * g
        out.append(agg)

    df = pd.DataFrame(out)
    df["computed_at"] = pd.to_datetime(df["computed_at"], utc=True)
    for col in ("call_wall", "put_wall", "zero_gamma",
                "call_wall_gex", "put_wall_gex",
                "net_gex", "abs_gex_total", "sum_gex_squared"):
        df[col] = df[col].astype(float)
    # Flow cols: None for pre-migration rows → NaN (errors='coerce' handles None/str gracefully)
    for col in ("pcr_volume", "pcr_oi", "iv_atm", "iv_skew"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["gex_concentration"] = df["sum_gex_squared"] / (df["abs_gex_total"] ** 2)
    df["call_wall_strength"] = df["call_wall_gex"].abs() / df["abs_gex_total"]
    df["put_wall_strength"]  = df["put_wall_gex"].abs()  / df["abs_gex_total"]
    return df.drop(columns=["sum_gex_squared", "call_wall_gex", "put_wall_gex"])


def load_database_url() -> str:
    # Prefer the direct (port-5432) URL when present — bypasses the Supavisor
    # pooler's circuit breaker, which trips on shared-pool auth failures.
    for key in ("DATABASE_URL_DIRECT", "DATABASE_URL"):
        if os.environ.get(key):
            return os.environ[key]
    settings = Path(__file__).resolve().parent.parent / "local.settings.json"
    if settings.exists():
        cfg = json.loads(settings.read_text())
        for key in ("DATABASE_URL_DIRECT", "DATABASE_URL"):
            url = cfg.get("Values", {}).get(key)
            if url:
                return url
    raise RuntimeError("DATABASE_URL[_DIRECT] not found in env or functions/local.settings.json")


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
            MAX(CASE WHEN gl.label = 'call_wall'  THEN gl.gex END)        AS call_wall_gex,
            MAX(CASE WHEN gl.label = 'put_wall'   THEN gl.gex END)        AS put_wall_gex,
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
    for col in ("call_wall", "put_wall", "zero_gamma",
                "call_wall_gex", "put_wall_gex",
                "net_gex", "abs_gex_total", "sum_gex_squared"):
        df[col] = df[col].astype(float)
    df["gex_concentration"] = df["sum_gex_squared"] / (df["abs_gex_total"] ** 2)
    df["call_wall_strength"] = df["call_wall_gex"].abs() / df["abs_gex_total"]
    df["put_wall_strength"]  = df["put_wall_gex"].abs()  / df["abs_gex_total"]
    return df.drop(columns=["sum_gex_squared", "call_wall_gex", "put_wall_gex"])


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
    # Normalized regime polarity: +1 = deep positive gamma (suppression),
    # -1 = deep negative gamma (amplification), ~0 = near the flip.
    df["gamma_regime_strength"] = df["net_gex"] / (df["abs_gex_total"] + 1e-8)
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
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, default="QQQ",
                        help="Ticker symbol present in both historical_data and gamma_exposure tables (default QQQ).")
    parser.add_argument("--horizon-bars", type=int, default=3,
                        help="Forward-return horizon in 5-min bars (default 3 = 15min).")
    args = parser.parse_args()
    symbol = args.symbol.upper()
    horizon_bars = args.horizon_bars
    horizon_min = BAR_GRID_MINUTES * horizon_bars

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    logging.info("Building dataset for symbol=%s, horizon = %d bars = %d minutes",
                 symbol, horizon_bars, horizon_min)

    rest = load_supabase_rest_creds()
    if rest is not None:
        base, key = rest
        logging.info("Using Supabase REST API (bypasses Supavisor pooler)")
        bars = fetch_bars_rest(base, key, symbol, INTERVAL)
        gex  = fetch_gex_snapshots_rest(base, key, symbol)
    else:
        db_url = load_database_url()
        logging.info("Using direct Postgres connection")
        with psycopg2.connect(db_url) as conn:
            bars = fetch_bars(conn, symbol, INTERVAL)
            gex  = fetch_gex_snapshots(conn, symbol)

    logging.info("Loaded %d bars, %d gex snapshots", len(bars), len(gex))

    joined = asof_join_gex(bars, gex)
    logging.info("After asof join (≤%dmin staleness): %d rows", GEX_MAX_STALENESS_MINUTES, len(joined))

    joined = compute_baseline_features(joined)
    joined = compute_gex_features(joined)
    joined = compute_target(joined, horizon_bars)

    all_features = FEATURE_COLS_BASELINE + FEATURE_COLS_GEX
    # Include flow cols in parquet (with NaN for pre-migration rows) but
    # exclude them from the dropna guard — they'll be NaN until data accumulates.
    keep_cols = META_COLS + [TARGET_COL] + all_features + FEATURE_COLS_FLOW
    final = joined[keep_cols].copy()

    before = len(final)
    final = final.dropna(subset=all_features + [TARGET_COL]).reset_index(drop=True)
    logging.info("After dropping NaNs (rolling warmup + session-end targets): %d rows (%d dropped)",
                 len(final), before - len(final))

    assert (final["computed_at"] <= final["date"]).all(), "LEAK: GEX after bar.date"
    assert (final["target_time"] > final["date"]).all(), "LEAK: target before bar.date"
    assert (final["target_time"] - final["date"] == pd.Timedelta(minutes=horizon_min)).all(), \
        f"Target gap is not exactly {horizon_min} minutes"

    logging.info("Final dataset: %d rows, %d feature cols", len(final), len(all_features))
    logging.info("Date range: %s -> %s", final["date"].min(), final["date"].max())
    logging.info("Target mean=%.6f std=%.6f min=%.6f max=%.6f",
                 final[TARGET_COL].mean(), final[TARGET_COL].std(),
                 final[TARGET_COL].min(), final[TARGET_COL].max())

    output_path = OUTPUT_DIR / f"{symbol.lower()}_5m_features_h{horizon_bars}.parquet"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    final.to_parquet(output_path, index=False)
    logging.info("Wrote %s (%d rows, %d cols)", output_path, len(final), len(final.columns))


if __name__ == "__main__":
    sys.exit(main())
