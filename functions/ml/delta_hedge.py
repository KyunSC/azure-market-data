"""Delta-hedged short ATM straddle on QQQ/SPY from the ThetaData 5-minute IV backfill.

Each day: sell 1 straddle (x100) at the strike nearest spot at 09:35 ET and delta hedge it with
shares on a fixed 5-minute bar clock until 16:00 ET. The question is how much of a short-vol
day's P&L is the implied-vs-realized spread and how much is hedging error, and which Greeks
explain it.

Rules:
  - expiry: nearest with calendar DTE >= --dte. --dte 0 needs a same-day expiry (2022 had only
    Mon/Wed/Fri QQQ/SPY expiries, so other days are skipped). NYSE half days are skipped
    (options stop quoting at 13:15 but the grid runs to 16:00).
  - strike: nearest spot at 09:35 among strikes with BOTH legs quoted (bid > 0, ask > 0).
    ThetaData's 09:30 row has no quotes, so 09:35 is the first tradable bar.
  - fills: sell at the bid at 09:35; buy back at the ask at 16:00 (dte > 0) or settle at
    intrinsic |S_16:00 - K| on the 16:00 underlying (dte 0, no exit spread). --mid marks both
    at mid. dte > 0 positions are held for that day only (entry 09:35, exit 16:00); nothing
    is carried overnight.
  - hedge: h = 100 * Delta_straddle shares (long h offsets the short straddle), set on every
    `rebalance_every`-th bar and held in between. Variants: 5m (every bar), 30m, 60m,
    60m+charm, entry-only (hedged once at 09:35), none. The hedge is unwound at the exit bar.
  - charm adjust: on a rebalance, h += 100 * charm * CHARM_FRAC * (t_next_rebalance - t_now),
    i.e. hedge to the expected AVERAGE delta over the hold. CHARM_FRAC = 1/2 because the
    tracking error of a constant hedge against a linearly drifting delta is minimized at the
    midpoint; shifting by the full hold (to the end-of-hold delta) has the same variance as
    not shifting at all. Caveat: charm is the delta decay at FIXED spot. Under GBM at realized
    = implied, E[delta] barely drifts (spot diffusing through a convex delta offsets charm;
    ~N(d2) is a martingale), so the shift only helps when spot is pinned, i.e. realized <
    implied (see test_charm_adjust_helps_only_when_spot_is_pinned).
  - costs: |dh| * S * --hedge-cost-bps / 1e4 on every hedge trade, entry and unwind included.
    The option spread cost is reported separately (spread_cost). No commissions.
  - marks: per-bar P&L = -100 dV + h dS on mid marks (dte 0: last mark = intrinsic).
    pnl = option_pnl + hedge_pnl - hedge_cost - spread_cost.

Clock: T is calendar time to the expiry's 16:00 ET close in years of 365 days. Greeks use
max(T, MIN_T_INTRADAY) with MIN_T_INTRADAY = 5 minutes. The live calculator's MIN_T_YEARS (1 day) must NOT be used here: a 0DTE option at 09:35 has 6h25m / 8760h = 0.00073y
left, so a 1-day floor would pin every 0DTE bar and flatten theta and charm. Elapsed time dt,
realized vol and theta all run on this same calendar clock. Caveat for dte > 0: a calendar-clock
IV spreads the variance of nights and weekends over 24h/day, but the position only lives through
the 6.4 trading hours, so realized (intraday, calendar clock) tends to exceed implied and the
intraday theta collected is only ~27% of a day's; that is a genuine property of holding
intraday only, not a bug.

IV: each leg's IV is re-implied from its own (bid + ask) / 2 on this clock (bisection, r =
RISK_FREE_RATE), not taken from ThetaData's implied_vol. ThetaData's IVs match this clock to
within ~1-2 minutes of T until 15:00, but they floor T at ~1 hour: after 15:00 their 0DTE IV
reprices the mid 30-60% too low (e.g. 0.12 vs 0.44 at 15:55), which would leave the marks and
the Greeks inconsistent and swamp the attribution residual in the last hour.

Data hygiene: bars are reindexed onto the regular 09:35..16:00 5-minute grid. A leg quote that
is missing, has ask <= 0 or bid > ask is forward-filled from that leg's last good quote; an IV
that cannot be implied (mid outside the no-arbitrage bounds, typically an ITM leg quoted at
intrinsic) or is < MIN_IV is taken from the same-strike other leg at that bar (n_borrow_iv), and
forward-filled (back-filled at the start) only when neither leg inverts. Counts go to
n_ffill_quote / n_borrow_iv / n_ffill_iv. On a settlement bar dsigma is set to 0 (value at
expiry does not depend on vol). Deep-ITM legs are often quoted wide with a mid below intrinsic;
that mark noise lands in the residual.

Attribution per bar (Greeks at the START of the bar, per-leg IVs summed over legs, short
position so every option term carries -100):
  delta_err  = (h - 100 Delta) dS     hedge mismatch; 0 for 5m, all of -100 Delta dS for none
  gamma      = -100 * 1/2 Gamma dS^2
  theta      = -100 * Theta dt
  vega       = -100 * sum_legs vega_l dsigma_l
  vanna      = -100 * sum_legs vanna_l dsigma_l dS
  volga      = -100 * 1/2 sum_legs volga_l dsigma_l^2
  charm      = -100 * charm dt dS     (the Taylor cross term within the bar)
  res1 = actual - (delta_err + gamma + theta + vega); res2 = res1 - (vanna + volga + charm).
  Diagnostic, NOT part of the sum: delta_err_charm = (shift - 100 charm (t - t_last_rebalance)) dS,
  the slice of delta_err caused by delta decaying since the last rebalance (net of the charm
  shift, if any).
  Caveats: the charm cross term is O(dt^1.5), the same order as the omitted speed (dS^3) and
  color (dS^2 dt) terms, so on 0DTE it does not shrink the residual by itself; vanna and volga do
  the work. In the last ~hour of a 0DTE the Taylor series in sigma stops converging (IV swings
  of 10+ points with minutes left), and adding second-order terms can raise the residual there.
  The option terms and residuals do not depend on the hedge variant; only delta_err does.

Vol accounting: realized vol = sqrt(sum r^2 / window_years) with log returns of S and the entry
-> exit calendar window; theo_vol_pnl = 100 sum 1/2 Gamma S^2 (sigma_imp^2 dt - r^2), which a
short straddle earns when implied > realized.

Output: data/delta_hedge/<symbol>_dte<d>[_mid].parquet, one row per day x variant. ThetaData-
derived: keep it private, delete with the rest on cancellation.

Run: .venv/bin/python delta_hedge.py --symbol QQQ --dte 0
     .venv/bin/python delta_hedge.py --symbol SPY --dte 1 --start 2024-01-01 --workers 8
     .venv/bin/python -m unittest test_delta_hedge -v
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
import greeks as g  # noqa: E402
from greeks import MIN_IV, RISK_FREE_RATE  # noqa: E402

ET = "America/New_York"
IV_ROOT = HERE / "data" / "thetadata" / "iv_5m"
OUT_DIR = HERE / "data" / "delta_hedge"
MULTIPLIER = 100
YEAR_S = 365 * 24 * 3600
MIN_T_INTRADAY = 5 / (60 * 24 * 365)  # 5 minutes; see the docstring for why not MIN_T_YEARS
CHARM_FRAC = 0.5
ENTRY_ONLY = 10**9  # a rebalance interval longer than any day: hedge once at entry
ENTRY, CLOSE = "09:35", "16:00"
# NYSE 13:00 early closes in the backfill window (options stop quoting ~13:15, grid runs to 16:00).
EARLY_CLOSE = {"2022-11-25", "2023-07-03", "2023-11-24", "2024-07-03", "2024-11-29", "2024-12-24",
               "2025-07-03", "2025-11-28", "2025-12-24", "2026-11-27", "2026-12-24"}
VARIANTS = {"5m": (1, False), "30m": (6, False), "60m": (12, False), "60m+charm": (12, True),
            "entry-only": (ENTRY_ONLY, False), "none": (None, False)}
COLS = ["expiration", "strike", "right", "timestamp", "bid", "ask", "underlying_price"]
IV_LO, IV_HI = 1e-4, 5.0  # bisection bracket for implied_vol
ATTR = ["delta_err", "gamma", "theta", "vega", "vanna", "volga", "charm"]


def _ffill(x: np.ndarray, ok: np.ndarray) -> tuple[np.ndarray, int]:
    """Forward-fill x where ~ok (back-fill a bad start); returns the array and the fill count."""
    s = pd.Series(np.where(ok, x, np.nan))
    return s.ffill().bfill().to_numpy(), int((~ok).sum())


def implied_vol(price, S, K, T, right, r: float = RISK_FREE_RATE, iters: int = 60) -> np.ndarray:
    """Vectorized Black-Scholes IV by bisection on [IV_LO, IV_HI]; NaN where the price is outside
    the bracket's price range (at/below intrinsic, above the IV_HI price) or an input is <= 0."""
    price, S, K, T = np.broadcast_arrays(*(np.asarray(x, dtype=float) for x in (price, S, K, T)))
    c = np.broadcast_to(g.is_call(right), price.shape)
    lo, hi = np.full(price.shape, IV_LO), np.full(price.shape, IV_HI)
    ok = (price > g.bs_price(S, K, T, lo, c, r)) & (price < g.bs_price(S, K, T, hi, c, r)) & (T > 0)
    for _ in range(iters):  # price is increasing in vol
        mid = 0.5 * (lo + hi)
        up = g.bs_price(S, K, T, mid, c, r) < price
        lo, hi = np.where(up, mid, lo), np.where(up, hi, mid)
    return np.where(ok, 0.5 * (lo + hi), np.nan)


def load_day(symbol: str, day: date | str, dte: int = 0) -> dict | None:
    """Per-bar arrays (09:35..16:00 ET, 5-minute grid) for the day's straddle, or None when the
    day has no eligible expiry/strike. See the module docstring for the rules."""
    day = date.fromisoformat(str(day))
    path = IV_ROOT / f"symbol={symbol}" / f"date={day.isoformat()}" / "part.parquet"
    if not path.exists() or day.isoformat() in EARLY_CLOSE:
        return None
    exps = pd.to_datetime(pd.read_parquet(path, columns=["expiration"])["expiration"].unique())
    days_out = np.asarray((exps - pd.Timestamp(day)).days)
    ok = days_out == 0 if dte == 0 else days_out >= dte
    if not ok.any():
        return None
    exp = exps[ok][np.argmin(days_out[ok])].strftime("%Y-%m-%d")
    df = pd.read_parquet(path, columns=COLS, filters=[("expiration", "==", exp)])
    df["call"] = df["right"].astype(str).str.upper().str[0] == "C"

    grid = pd.date_range(f"{day} {ENTRY}", f"{day} {CLOSE}", freq="5min", tz=ET)
    ts = df["timestamp"].dt.tz_convert(ET)
    at0 = df[(ts == grid[0]) & (df["bid"] > 0) & (df["ask"] > 0)]
    spot = at0["underlying_price"].median()
    if at0.empty or not np.isfinite(spot) or spot <= 0:
        return None
    both = at0.groupby("strike")["call"].nunique()
    both = both.index[both == 2].to_numpy()
    if both.size == 0:
        return None
    K = float(both[np.argmin(np.abs(both - spot))])

    close = pd.Timestamp(f"{exp} {CLOSE}", tz=ET)
    T = np.asarray((close - grid).total_seconds(), float) / YEAR_S  # raw; floored in hedge_pnl
    sub = df[df["strike"] == K].assign(timestamp=ts[df["strike"] == K])
    S = sub.groupby("timestamp")["underlying_price"].median().reindex(grid).to_numpy(float)
    S, _ = _ffill(S, np.isfinite(S) & (S > 0))
    out = {"symbol": symbol, "date": day.isoformat(), "expiration": exp, "dte": int((pd.Timestamp(exp)
           - pd.Timestamp(day)).days), "strike": K, "ts": grid, "S": S, "settle": exp == day.isoformat(),
           "T": T, "n_ffill_quote": 0, "n_ffill_iv": 0, "n_borrow_iv": 0}
    for leg, is_c in (("call", True), ("put", False)):
        x = sub[sub["call"] == is_c].drop_duplicates("timestamp").set_index("timestamp").reindex(grid)
        bid, ask = x["bid"].to_numpy(float), x["ask"].to_numpy(float)
        good = np.isfinite(bid) & np.isfinite(ask) & (ask > 0) & (bid >= 0) & (ask >= bid)
        bid, nq = _ffill(bid, good)
        ask, _ = _ffill(ask, good)
        iv = implied_vol((bid + ask) / 2, S, K, np.maximum(T, MIN_T_INTRADAY), is_c)
        out.update({f"{leg}_bid": bid, f"{leg}_ask": ask, f"{leg}_mid": (bid + ask) / 2, f"iv_{leg}": iv})
        out["n_ffill_quote"] += nq
    # An ITM leg quoted at intrinsic has no time value to invert; borrow the same-strike other leg's
    # IV at that bar (put-call parity), and forward-fill only when neither leg inverts.
    raw = {leg: out[f"iv_{leg}"] for leg in ("call", "put")}
    good = {leg: np.isfinite(v) & (v >= MIN_IV) for leg, v in raw.items()}
    for leg, other in (("call", "put"), ("put", "call")):
        iv = np.where(good[leg], raw[leg], raw[other])
        out[f"iv_{leg}"], ni = _ffill(iv, good[leg] | good[other])
        out["n_borrow_iv"] += int((~good[leg] & good[other]).sum())
        out["n_ffill_iv"] += ni
        if not np.isfinite(out[f"iv_{leg}"]).all():
            return None
    return out


def straddle_path(d: dict, mid: bool = False) -> dict:
    """hedge_pnl inputs from a load_day dict: mid marks (intrinsic on a settlement bar) and fills."""
    S, K = d["S"], d["strike"]
    V = d["call_mid"] + d["put_mid"]
    ivc, ivp = d["iv_call"].copy(), d["iv_put"].copy()
    if d["settle"]:
        V = V.copy()
        V[-1] = abs(S[-1] - K)
        ivc[-1], ivp[-1] = ivc[-2], ivp[-2]  # no vega term into expiry
    exit_fill = V[-1] if d["settle"] else d["call_ask"][-1] + d["put_ask"][-1]
    fills = None if mid else (d["call_bid"][0] + d["put_bid"][0], exit_fill)
    return dict(S=S, V=V, iv_call=ivc, iv_put=ivp, T=d["T"], K=K, fills=fills)


def hedge_pnl(S, V, iv_call, iv_put, T, K, rebalance_every: int | None, charm_adjust: bool = False,
              hedge_cost_bps: float = 0.0, fills: tuple[float, float] | None = None,
              multiplier: int = MULTIPLIER, r: float = RISK_FREE_RATE, min_t: float = MIN_T_INTRADAY,
              charm_frac: float = CHARM_FRAC) -> dict:
    """P&L and Greek attribution of a short straddle (x multiplier) hedged with shares.

    S, V, iv_call, iv_put, T: per-bar arrays (n points, n-1 bars); V is the straddle mark and T the
    raw calendar time to expiry in years (Greeks use max(T, min_t); elapsed time uses raw T).
    rebalance_every: bars between hedge resets, None for no hedge. fills: (entry, exit) straddle
    prices; None = V[0], V[-1]. Returns totals plus per-bar arrays under "bars".
    """
    S, V, sc, sp, T = (np.asarray(x, dtype=float) for x in (S, V, iv_call, iv_put, T))
    n, m = len(S), multiplier
    s0, c0, p0, Tg = S[:-1], sc[:-1], sp[:-1], np.maximum(T[:-1], min_t)
    t = T[0] - T  # elapsed calendar years
    dt, dS, dV, dsc, dsp = np.diff(t), np.diff(S), np.diff(V), np.diff(sc), np.diff(sp)
    lr = np.diff(np.log(S))

    dlt = g.delta(s0, K, Tg, c0, "C", r) + g.delta(s0, K, Tg, p0, "P", r)
    gc, gp = g.gamma(s0, K, Tg, c0, r), g.gamma(s0, K, Tg, p0, r)
    th = g.theta(s0, K, Tg, c0, "C", r) + g.theta(s0, K, Tg, p0, "P", r)
    vgc, vgp = g.vega(s0, K, Tg, c0, r), g.vega(s0, K, Tg, p0, r)
    vac, vap = g.vanna(s0, K, Tg, c0, r), g.vanna(s0, K, Tg, p0, r)
    voc, vop = g.volga(s0, K, Tg, c0, r), g.volga(s0, K, Tg, p0, r)
    ch = g.charm(s0, K, Tg, c0, "C", r) + g.charm(s0, K, Tg, p0, "P", r)

    h = np.zeros(n - 1)
    shift = np.zeros(n - 1)  # charm pre-shift in shares, per bar (constant within a hold)
    since = np.zeros(n - 1)  # calendar time since the last rebalance
    reb = np.zeros(n - 1, bool)
    if rebalance_every is not None:
        idx = np.arange(0, n - 1, rebalance_every)
        reb[idx] = True
        nxt = np.minimum(idx + rebalance_every, n - 1)
        sh = m * ch[idx] * charm_frac * (t[nxt] - t[idx]) if charm_adjust else np.zeros(len(idx))
        seg = np.cumsum(reb) - 1  # which rebalance each bar is held under
        h = (m * dlt[idx] + sh)[seg]
        shift = sh[seg]
        since = t[:-1] - t[idx][seg]

    trades = np.diff(np.r_[0.0, h, 0.0])  # at points 0..n-1; the last one unwinds at the exit bar
    cost = np.abs(trades) * S * hedge_cost_bps / 1e4

    actual = -m * dV + h * dS
    bars = {
        "actual": actual,
        "delta_err": (h - m * dlt) * dS,
        "gamma": -m * 0.5 * (gc + gp) * dS ** 2,
        "theta": -m * th * dt,
        "vega": -m * (vgc * dsc + vgp * dsp),
        "vanna": -m * (vac * dsc + vap * dsp) * dS,
        "volga": -m * 0.5 * (voc * dsc ** 2 + vop * dsp ** 2),
        "charm": -m * ch * dt * dS,
        "delta_err_charm": (shift - m * ch * since) * dS if rebalance_every is not None else np.zeros(n - 1),
        "hedge": h, "cost": cost[:-1] + np.r_[np.zeros(n - 2), cost[-1]],
    }
    bars["res1"] = actual - sum(bars[k] for k in ATTR[:4])
    bars["res2"] = bars["res1"] - sum(bars[k] for k in ATTR[4:])
    entry_fill, exit_fill = (V[0], V[-1]) if fills is None else fills
    option_pnl, hedge = -m * (V[-1] - V[0]), float((h * dS).sum())
    spread = m * ((V[0] - entry_fill) + (exit_fill - V[-1]))
    window = t[-1]
    out = {
        "pnl": option_pnl + hedge - cost.sum() - spread,
        "premium": m * entry_fill, "option_pnl": option_pnl, "hedge_pnl": hedge,
        "hedge_cost": float(cost.sum()), "spread_cost": float(spread), "n_rebalances": int(reb.sum()),
        **{k: float(bars[k].sum()) for k in [*ATTR, "delta_err_charm", "res1", "res2"]},
        "res1_absbar": float(np.abs(bars["res1"]).sum()), "res2_absbar": float(np.abs(bars["res2"]).sum()),
        "entry_iv": float((sc[0] + sp[0]) / 2),
        "rv": float(np.sqrt((lr ** 2).sum() / window)) if window > 0 else np.nan,
        "theo_vol_pnl": float(m * (0.5 * (gc * c0 ** 2 + gp * p0 ** 2) * s0 ** 2 * dt
                                   - 0.5 * (gc + gp) * s0 ** 2 * lr ** 2).sum()),
        "bars": bars,
    }
    return out


def run_day(symbol: str, day: date, dte: int, mid: bool = False, bps: float = 0.0) -> list[dict]:
    """All hedge variants for one day; [] when the day has no eligible straddle."""
    d = load_day(symbol, day, dte)
    if d is None:
        return []
    p = straddle_path(d, mid)
    base = {k: d[k] for k in ("symbol", "date", "expiration", "dte", "strike", "settle",
                              "n_ffill_quote", "n_ffill_iv", "n_borrow_iv")}
    base["spot0"] = float(d["S"][0])
    rows = []
    for name, (every, charm_adj) in VARIANTS.items():
        res = hedge_pnl(**p, rebalance_every=every, charm_adjust=charm_adj, hedge_cost_bps=bps)
        res.pop("bars")
        rows.append({**base, "variant": name, **res, "pnl_pct": res["pnl"] / res["premium"]})
    return rows


def summarize(df: pd.DataFrame) -> pd.DataFrame:
    """Per-variant summary of a run_day DataFrame (pure; reused by plotting scripts)."""
    out = {}
    for name, x in df.groupby("variant", sort=False):
        pnl, theo = x["pnl"].to_numpy(), x["theo_vol_pnl"].to_numpy()
        sd = pnl.std(ddof=1) if len(x) > 1 else np.nan
        slope, r2 = np.nan, np.nan
        if len(x) > 2 and theo.std() > 0:
            slope = np.polyfit(theo, pnl, 1)[0]
            r2 = np.corrcoef(theo, pnl)[0, 1] ** 2
        out[name] = {
            "n": len(x), "mean": pnl.mean(), "pct_prem": 100 * x["pnl_pct"].mean(), "std": sd,
            "sharpe": pnl.mean() / sd * np.sqrt(252) if sd > 0 else np.nan, "hit": (pnl > 0).mean(),
            **{k: x[k].mean() for k in ["delta_err", "gamma", "theta", "vega"]},
            "second": (x["vanna"] + x["volga"] + x["charm"]).mean(),
            "res1": x["res1"].mean(), "res2": x["res2"].mean(),
            "res_red": 1 - x["res2"].abs().mean() / x["res1"].abs().mean(),
            "res_red_bar": 1 - x["res2_absbar"].mean() / x["res1_absbar"].mean(),
            "costs": (x["hedge_cost"] + x["spread_cost"]).mean(),
            "iv_rv": (x["entry_iv"] - x["rv"]).mean(), "slope": slope, "r2": r2,
        }
    return pd.DataFrame.from_dict(out, orient="index")


def print_summary(s: pd.DataFrame) -> None:
    perf = ["n", "mean", "pct_prem", "std", "sharpe", "hit", "costs", "iv_rv", "slope", "r2"]
    attr = ["delta_err", "gamma", "theta", "vega", "second", "res1", "res2", "res_red", "res_red_bar"]
    with pd.option_context("display.width", 200, "display.max_columns", 30, "display.float_format", "{:.3f}".format):
        print("\nper straddle ($, x100); pct_prem = mean % of premium; slope/r2 = OLS of pnl on theo_vol_pnl")
        print(s[perf].to_string())
        print("\nmean attribution ($); second = vanna+volga+charm; res_red = 1 - mean|res2|/mean|res1| "
              "(daily sums), res_red_bar = same on per-bar |res|")
        print(s[attr].to_string())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--dte", type=int, default=0)
    ap.add_argument("--start", default="2022-01-01")
    ap.add_argument("--end", default=None, help="exclusive; default: all downloaded days")
    ap.add_argument("--mid", action="store_true", help="fill entry and exit at mid instead of bid/ask")
    ap.add_argument("--hedge-cost-bps", type=float, default=0.5)
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    symbol = args.symbol.upper()

    days = sorted(date.fromisoformat(p.name[5:]) for p in (IV_ROOT / f"symbol={symbol}").glob("date=*")
                  if (p / "part.parquet").exists())
    days = [d for d in days if d >= date.fromisoformat(args.start)
            and (args.end is None or d < date.fromisoformat(args.end))]
    if not days:
        print(f"no downloaded iv_5m days for {symbol}")
        return 2
    t0 = time.time()
    rows = []
    n = len(days)
    with ProcessPoolExecutor(max_workers=args.workers) as ex:
        for i, day_rows in enumerate(ex.map(run_day, [symbol] * n, days, [args.dte] * n, [args.mid] * n,
                                            [args.hedge_cost_bps] * n, chunksize=4)):
            rows.extend(day_rows)
            if (i + 1) % 100 == 0 or i + 1 == n:
                print(f"  {i + 1}/{n} days, {len(rows) // len(VARIANTS)} traded ({time.time() - t0:.0f}s)", flush=True)
    if not rows:
        print(f"{symbol}: no eligible dte={args.dte} days")
        return 2
    df = pd.DataFrame(rows)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / f"{symbol.lower()}_dte{args.dte}{'_mid' if args.mid else ''}.parquet"
    df.to_parquet(out, index=False)
    print(f"{symbol} dte>={args.dte}: {df['date'].nunique()} days {df['date'].min()}..{df['date'].max()}, "
          f"fills={'mid' if args.mid else 'bid/ask'}, hedge cost {args.hedge_cost_bps} bps -> {out}")
    print_summary(summarize(df))
    return 0


if __name__ == "__main__":
    sys.exit(main())
