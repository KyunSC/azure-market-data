"""Rebuild the live GEX snapshots historically from the ThetaData backfill.

For every 5-minute IV snapshot (09:35-16:00 ET; ThetaData's 09:30 row has no quotes)
this computes what functions/ScheduledGammaExposure would have stored at that moment,
using the live calculator's own constants, Black-Scholes gamma and _identify_key_levels:

  - expirations: the MAX_EXPIRATIONS (4) nearest with 0 <= DTE <= MAX_DAYS_OUT (30)
  - per contract: gamma(spot, K, max(DTE/365, MIN_T_YEARS), RISK_FREE_RATE, mid IV)
                  * OI * 100 * spot, negated for puts; skipped when OI <= 0 or IV < MIN_IV
  - levels: call wall, put wall, zero gamma, up to 3 more significant strikes per side
  - aggregates over those levels only, exactly as build_dataset's SQL/REST readers do

Point in time: an IV row stamped T uses quotes and underlying price as of T
(underlying_timestamp == timestamp), and OI is the prior close, published ~06:30 ET.
So computed_at = T. Spot is the snapshot's underlying_price.

--expiries 0dte keeps only contracts expiring that day (days without one are skipped) and
writes <symbol>_gex_snapshots_0dte.parquet. Caveat: OI is the prior close, so 0DTE GEX is
the gamma of positions carried into expiration day, not of same-day opened 0DTE flow.

Output: data/thetadata_gex/<symbol>_gex_snapshots.parquet, one row per snapshot, with the
same raw columns build_dataset.finish_gex_snapshots expects. ThetaData-derived: keep it
private (never in frontend/public), delete with the rest on cancellation.

Run: python functions/ml/thetadata_gex.py --symbol QQQ
     python functions/ml/thetadata_gex.py --symbol SPY --start 2022-01-01 --workers 8
     python functions/ml/thetadata_gex.py --symbol QQQ --expiries 0dte
"""
from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "GEXCalculator"))
from gex_calculator import (  # noqa: E402  — the live calculator is the spec
    MAX_DAYS_OUT, MAX_EXPIRATIONS, MIN_IV, MIN_T_YEARS, RISK_FREE_RATE, _identify_key_levels,
)
from thetadata_fetch import KEYS, OUT_ROOT as TD_ROOT, contract_keys  # noqa: E402

OUT_DIR = HERE / "data" / "thetadata_gex"
COLUMNS = ["computed_at", "spot", "call_wall", "put_wall", "zero_gamma",
           "call_wall_gex", "put_wall_gex", "call_wall_0dte_gex", "put_wall_0dte_gex",
           "net_gex", "abs_gex_total", "sum_gex_squared", "net_gex_0dte_raw", "abs_gex_0dte_total"]


def bs_gamma(S, K, T, r, sigma) -> np.ndarray:
    """Vectorized gex_calculator.black_scholes_gamma (0 where an input is non-positive)."""
    S, K, T, sigma = (np.asarray(x, dtype=float) for x in (S, K, T, sigma))
    ok = (T > 0) & (sigma > 0) & (S > 0) & (K > 0)
    out = np.zeros(np.broadcast(S, K, T, sigma).shape)
    s, k, t, v = (np.broadcast_to(x, out.shape)[ok] for x in (S, K, T, sigma))
    d1 = (np.log(s / k) + (r + 0.5 * v ** 2) * t) / (v * np.sqrt(t))
    out[ok] = np.exp(-0.5 * d1 * d1) / np.sqrt(2 * np.pi) / (s * v * np.sqrt(t))
    return out


def snapshot(chain: pd.DataFrame, spot: float, day: date, expiries: str = "nearest4") -> dict | None:
    """One live-style GEX snapshot from one timestamp's chain (keys + implied_vol + open_interest).

    expiries: "nearest4" (live: MAX_EXPIRATIONS nearest within MAX_DAYS_OUT) or "0dte" (same-day only).
    """
    dte = (pd.to_datetime(chain["expiration"]) - pd.Timestamp(day)).dt.days
    if expiries == "0dte":
        window = [day.isoformat()]
    else:
        window = sorted(chain.loc[(dte >= 0) & (dte <= MAX_DAYS_OUT), "expiration"].unique())[:MAX_EXPIRATIONS]
    c = chain[chain["expiration"].isin(window) & (chain["open_interest"] > 0) & (chain["implied_vol"] >= MIN_IV)]
    if c.empty:
        return None
    days = (pd.to_datetime(c["expiration"]) - pd.Timestamp(day)).dt.days.to_numpy()
    T = np.maximum(days / 365.0, MIN_T_YEARS)
    sign = np.where(c["right"].to_numpy() == "C", 1.0, -1.0)
    gex = bs_gamma(spot, c["strike"].to_numpy(), T, RISK_FREE_RATE, c["implied_vol"].to_numpy()) \
        * c["open_interest"].to_numpy() * 100 * spot * sign
    per = pd.DataFrame({"strike": c["strike"].to_numpy(), "gex": gex,
                        "gex_call": np.where(sign > 0, gex, 0.0), "gex_put": np.where(sign < 0, gex, 0.0),
                        "gex_0dte": np.where(days <= 0, gex, 0.0)}).groupby("strike").sum().sort_index()
    strikes = [{"strike_etf": round(k, 2), "strike_futures": round(k, 2), "gex": round(r.gex, 2),
                "gex_call": round(r.gex_call, 2), "gex_put": round(r.gex_put, 2), "gex_0dte": round(r.gex_0dte, 2)}
               for k, r in zip(per.index, per.itertuples())]
    levels = _identify_key_levels(strikes, spot)
    if not levels:
        return None
    g = np.array([lv["gex"] for lv in levels], dtype=float)
    g0 = np.array([lv.get("gex_0dte", 0.0) for lv in levels], dtype=float)
    out = {"spot": spot, "net_gex": g.sum(), "abs_gex_total": np.abs(g).sum(), "sum_gex_squared": (g ** 2).sum(),
           "net_gex_0dte_raw": g0.sum(), "abs_gex_0dte_total": np.abs(g0).sum(),
           "call_wall": np.nan, "put_wall": np.nan, "zero_gamma": np.nan,
           "call_wall_gex": np.nan, "put_wall_gex": np.nan, "call_wall_0dte_gex": np.nan, "put_wall_0dte_gex": np.nan}
    for lv in levels:
        name = lv["label"]
        if name in ("call_wall", "put_wall", "zero_gamma"):
            out[name] = lv["strike_etf"]
        if name in ("call_wall", "put_wall"):
            out[f"{name}_gex"] = lv["gex"]
            out[f"{name}_0dte_gex"] = lv.get("gex_0dte", 0.0)
    return out


def day_snapshots(symbol: str, day: date, expiries: str = "nearest4") -> list[dict]:
    part = lambda job: TD_ROOT / job / f"symbol={symbol}" / f"date={day.isoformat()}" / "part.parquet"  # noqa: E731
    if not part("iv_5m").exists() or not part("oi").exists():
        return []
    iv = pd.read_parquet(part("iv_5m"), columns=[*KEYS, "timestamp", "implied_vol", "underlying_price"])
    oi = pd.read_parquet(part("oi"), columns=[*KEYS, "open_interest"])
    iv[KEYS] = contract_keys(iv)
    oi[KEYS] = contract_keys(oi)
    oi = oi.groupby(KEYS, as_index=False)["open_interest"].max()
    chain = iv.merge(oi, on=KEYS, how="inner")
    rows = []
    for ts, snap in chain.groupby("timestamp", sort=True):
        spot = float(snap["underlying_price"].median())
        if not np.isfinite(spot) or spot <= 0 or not (snap["implied_vol"] >= MIN_IV).any():
            continue  # the 09:30 placeholder row, or a bar without an underlying print
        s = snapshot(snap, spot, day, expiries)
        if s is not None:
            rows.append({"computed_at": pd.Timestamp(ts).tz_convert("UTC"), **s})
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default=None, help="exclusive; default: all downloaded days")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--expiries", choices=["nearest4", "0dte"], default="nearest4")
    args = ap.parse_args()
    symbol = args.symbol.upper()

    days = sorted(date.fromisoformat(p.name[5:]) for p in (TD_ROOT / "iv_5m" / f"symbol={symbol}").glob("date=*")
                  if (p / "part.parquet").exists())
    days = [d for d in days if d >= date.fromisoformat(args.start)
            and (args.end is None or d < date.fromisoformat(args.end))]
    if not days:
        print(f"no downloaded iv_5m days for {symbol}")
        return 2
    t0 = time.time()
    rows = []
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, day_rows in enumerate(ex.map(day_snapshots, [symbol] * len(days), days,
                                            [args.expiries] * len(days), chunksize=4)):
            rows.extend(day_rows)
            if (i + 1) % 100 == 0 or i + 1 == len(days):
                print(f"  {i + 1}/{len(days)} days, {len(rows)} snapshots ({time.time() - t0:.0f}s)", flush=True)
    df = pd.DataFrame(rows, columns=COLUMNS).sort_values("computed_at").reset_index(drop=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{symbol.lower()}_gex_snapshots{'_0dte' if args.expiries == '0dte' else ''}.parquet"
    df.to_parquet(out, index=False)
    per_day = df.groupby(df["computed_at"].dt.tz_convert("America/New_York").dt.date).size()
    print(f"{symbol}: {len(df)} snapshots over {per_day.size} days "
          f"(median {per_day.median():.0f}/day, min {per_day.min()}) -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
