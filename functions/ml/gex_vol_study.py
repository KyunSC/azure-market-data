"""Does dealer positioning (GEX, VEX, CEX) forecast QQQ/SPY forward REALIZED VOLATILITY?

The main GEX study (null_test.py) found little in forward RETURNS. The textbook dealer-hedging
claim is about volatility instead: when dealers are long gamma they sell rallies and buy dips,
damping realized vol; short gamma, they chase and amplify it. Vanna (VEX) and charm (CEX) flows
may add. This asks whether the dealer block improves an out-of-sample forecast of log realized
variance over controls that any vol desk would use first.

Rules (fixed before any out-of-sample number was looked at; see "Specification" below):
  - snapshot t: every 5-minute GEX snapshot from thetadata_gex.py (computed_at = t, OI = prior
    close, quotes and spot as of t). One observation per snapshot.
  - bars: Databento XNAS.ITCH 1-min bars -> 5-min RTH bars stamped at their start (the same
    aggregation as build_dataset.load_databento_bars). Bar k covers [k, k+5min).
  - returns: r_k = log(close_k / close_{k-1}) within a session; the first bar of a session uses
    log(close / open), so no overnight gap enters any RV.
  - target, horizon h bars: RV_t = mean of squared returns of the bars STARTING at t, t+5, ...,
    t+5(h-1). The first term is log(close_t / open_t), so the target is a function of bars that
    start at/after t only (no price at or before t enters it). h = 6 (30m), 12 (60m): all h bars
    must exist, contiguously, in t's session, or the snapshot is dropped (16:00 snapshots and,
    for 60m, everything after 15:00 drop out). "ros" = rest of session: every bar from t to the
    session's last bar (>= 1). target = log(max(RV, EPS_VAR)); RV is per 5-min bar (not
    annualized) for every horizon, so horizons are on one scale. target_time = end of window.
  - features use information <= t only: the snapshot at t and bars that END by t.
      controls  log_iv_front   ATM IV (mean of call/put ThetaData implied_vol at the strike
                               nearest spot) of the nearest expiry with DTE >= 1, at t
                log_iv_0dte    the same for today's expiry (0 on days without one)
                is_0dte_day    today has an expiry in the chain
                log_rv_lag30m  mean r^2 of the 6 bars ending at t (may reach into the prior
                               session's last bars; never includes the overnight gap)
                log_rv_lag1d   mean r^2 over the previous session (HAR daily)
                log_rv_lag5d   mean of the previous 5 sessions' mean r^2 (HAR weekly)
                tod_*          30-minute time-of-day buckets (12 dummies; intraday U-shape)
                dow_*          day-of-week dummies (4)
      dealer    gex_regime     net_gex / abs_gex_total over the key levels (+1 long gamma)
                gex_slog       signed log1p(net_gex)
                above_zero_gamma  sign(spot - zero_gamma) (0 when no flip level was found)
                zero_gamma_dist   (spot - zero_gamma) / spot, clipped to +-5% (0 when none)
                gex_0dte_slog  signed log1p(net_gex_0dte_raw) (0DTE gamma on the key levels)
                vex_slog, cex_slog, vex_0dte_slog, cex_0dte_slog  signed log1p of the whole-
                               window vanna / charm sums and their 0DTE parts
    Distances are NOT scaled by ATR (build_dataset's dist_*_atr): ATR is itself lagged vol and
    would smuggle a control into the dealer block.

Method:
  - OLS of the target on [controls] and on [controls + dealer block] (and, as the one
    pre-declared secondary spec, [controls + gex_regime] -- the classic single-number claim).
  - Out of sample: expanding-window walk-forward from eval.session_folds (N_SPLITS session
    folds, 1-session embargo, train rows whose target_time reaches the test block are purged).
    OOS R^2 = 1 - SSE / SSE(train-mean forecast), pooled over folds. dR^2 = R^2_full - R^2_ctrl.
    CI: moving-block bootstrap over OOS days (BOOT_BLOCK consecutive days per block).
  - Null: roll the whole dealer block by k whole sessions (row offset = start of session k, as
    null_test.py), MIN_SHIFT <= k <= n_sessions - MIN_SHIFT, refit the walk-forward, recompute
    dR^2. The rolled block keeps its own distribution and autocorrelation but meets the wrong
    days' vol. p = (1 + #null >= real) / (1 + N).
  - In sample (research rows only): standardized coefficients (X and y z-scored) with Newey-West
    HAC errors, Bartlett kernel, HAC_LAGS bars (>= the target horizon: 78 = one session for
    30m/60m, 156 for rest-of-session), and a HAC Wald test of the dealer block.

Holdout (holdout.py): the sealed verify block (VERIFY_START, plus the GAP_SESSIONS sessions
before it) is NEVER LOADED. The research session list is taken from the iv_5m partition
directory NAMES (metadata only): sessions before VERIFY_START minus the last GAP_SESSIONS --
the same cut split_holdout makes. Every read is then bounded by the end of the last research
session: Databento files are read with a pyarrow filter ts_event < cutoff, the snapshot parquet
with computed_at < cutoff, and iv_5m partitions only for research days. main() asserts nothing
at/after the cutoff made it into the frame. There is no discovery/holdout split inside research:
walk-forward OOS is the out-of-sample evidence, and nothing here is tuned (OLS, fixed spec).

Specification: the regressor lists, horizons, HAC lags, fold count, EPS_VAR and bootstrap block
were written down (this docstring) before the first OOS run and not changed after it. Added
AFTER the first OOS run, and labelled post hoc everywhere: (1) the leverage-effect check (LEVERAGE:
signed returns over the last 30m / 1d / 5d and their negative parts appended to the controls,
results under "robust_leverage"), because GEX turns negative after sell-offs and falling prices
raise vol on their own; (2) per-fold dR^2; (3) running the null over every shift (--perms 0)
instead of 199, which only sharpens the p-value floor.

Caveats:
  - OI is the prior close: intraday-opened (especially 0DTE) positions are invisible, and the
    dealer sign is the naive "customers long calls and puts" convention (calls +, puts -).
  - GEX (net_gex, abs_gex_total, net_gex_0dte_raw) sums ONLY the key levels chosen by the live
    calculator (call wall, put wall, zero gamma (gex 0), up to 3 more positive and 3 more
    negative strikes: <= 8 strikes); VEX/CEX sum the WHOLE window (nearest 4 expiries within 30
    days, OI > 0, IV >= MIN_IV). They are not the same universe.
  - Greeks in the snapshots use T = max(DTE/365, 1 day) (the live MIN_T_YEARS), so 0DTE gamma,
    vanna and charm are those of a 1-day option, not of the hours actually left.
  - ThetaData's implied_vol floors T at ~1 hour (see delta_hedge.py), so late-day 0DTE ATM IV
    reads too low; log_iv_front (DTE >= 1) is unaffected.
  - Overlapping targets: rows 5 minutes apart share 5/6 (30m) or all but one (ros) of their bars;
    that is what the HAC lags and the day-block bootstrap are for.

Outputs (gitignored data/, ThetaData-derived): data/gex_vol/gex_vol_<sym>.json (summary,
coefficients, null draws) and data/gex_vol/gex_vol_summary.csv (one row per symbol x horizon,
merged across runs). Plot (aggregates only): plots/gex_vol_<sym>.png.

Run: .venv/bin/python gex_vol_study.py --symbol QQQ --perms 0 --rebuild   # as reported (all shifts)
     .venv/bin/python gex_vol_study.py --symbol SPY --perms 0 --workers 3
     .venv/bin/python gex_vol_study.py --symbol QQQ --replot     # plot from the saved JSON
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import chi2

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent / "GEXCalculator"))
from eval import session_folds, session_ids  # noqa: E402
from gex_calculator import MIN_IV  # noqa: E402
from holdout import GAP_SESSIONS, VERIFY_START  # noqa: E402
from thetadata_fetch import KEYS, OUT_ROOT as TD_ROOT, contract_keys  # noqa: E402

ET = "America/New_York"
DATA = HERE / "data"
OUT = DATA / "gex_vol"
PLOTS = HERE / "plots"
BARS_DIR = DATA / "databento" / "eq-ohlcv-1m"
GEX_DIR = DATA / "thetadata_gex"
BAR = pd.Timedelta(minutes=5)

HORIZONS = {"30m": 6, "60m": 12, "ros": 0}  # bars; 0 = rest of session
HAC_LAGS = {"30m": 78, "60m": 78, "ros": 156}
EPS_VAR = 1e-9  # per-bar variance floor before the log (~one 0.3 bp move per bar)
N_SPLITS = 10
EMBARGO_SESSIONS = 1
MIN_SHIFT = 5
BOOT_BLOCK = 5  # days per bootstrap block
ZG_CLIP = 0.05

CONTROLS_CONT = ["log_iv_front", "log_iv_0dte", "is_0dte_day",
                 "log_rv_lag30m", "log_rv_lag1d", "log_rv_lag5d"]
DEALER = ["gex_regime", "gex_slog", "above_zero_gamma", "zero_gamma_dist", "gex_0dte_slog",
          "vex_slog", "cex_slog", "vex_0dte_slog", "cex_0dte_slog"]
CLASSIC = ["gex_regime"]
# POST-HOC robustness (added after the first OOS run, not part of the pre-declared spec): the
# leverage effect. Dealer gamma tends to turn negative after sell-offs, and falling prices raise
# future vol by themselves, so the dealer block might just be a proxy for recent signed returns.
# Price-based log returns over the last 6 / 78 / 390 bars ending by t (overnight gaps included:
# they are known at t) and their negative parts (HAR with leverage, Corsi & Reno 2012).
LEVERAGE = ["ret_30m", "ret_1d", "ret_5d", "neg_ret_30m", "neg_ret_1d", "neg_ret_5d"]


# ---------------------------------------------------------------- pure: sessions and bars

def research_sessions(sessions, verify_start: pd.Timestamp = VERIFY_START,
                      gap: int = GAP_SESSIONS) -> list[date]:
    """Sessions split_holdout would keep on the research side: those before verify_start, minus
    the last `gap` of them."""
    pre = sorted(d for d in sessions if d < verify_start.date())
    return pre[:len(pre) - gap] if gap else pre


def aggregate_5m(m: pd.DataFrame) -> pd.DataFrame:
    """1-min OHLCV (UTC index) -> 5-min RTH bars stamped at their start, with an ET session date."""
    m = m[~m.index.duplicated()].sort_index()
    et = m.index.tz_convert(ET)
    minute = et.hour * 60 + et.minute
    m = m[(minute >= 9 * 60 + 30) & (minute < 16 * 60)]
    m.index = m.index.tz_convert(ET)
    bars = m.resample("5min", label="left", closed="left").agg(
        {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna(subset=["close"])
    bars["session"] = bars.index.date
    bars.index = bars.index.tz_convert("UTC")
    return bars.rename_axis("date").reset_index()


def bar_returns(bars: pd.DataFrame) -> tuple[np.ndarray, np.ndarray]:
    """(r, first_open): r_k = log(close_k / close_{k-1}) within a session and log(close/open) on a
    session's first bar; first_open_k = log(close_k / open_k) for every bar."""
    c = bars["close"].to_numpy(float)
    first_open = np.log(c / bars["open"].to_numpy(float))
    s = bars["session"].to_numpy()
    new = np.r_[True, s[1:] != s[:-1]]
    r = np.empty_like(c)
    r[0] = first_open[0]
    r[1:] = np.log(c[1:] / c[:-1])
    r[new] = first_open[new]
    return r, first_open


def forward_log_rv(bars: pd.DataFrame, times, h: int) -> tuple[np.ndarray, pd.Series]:
    """log per-bar realized variance over the bars starting at t .. t+5(h-1) (h = 0: to session end).

    Uses only bars starting at/after t; the first bar contributes log(close_t / open_t).
    Returns (target, target_time); NaN / NaT where the window is incomplete or t is not a bar.
    """
    r, fo = bar_returns(bars)
    cs = np.r_[0.0, np.cumsum(r * r)]
    dates = pd.DatetimeIndex(bars["date"])
    sess = bars["session"].to_numpy()
    n = len(bars)
    i = dates.get_indexer(pd.DatetimeIndex(times))
    ok = i >= 0
    ii = np.where(ok, i, 0)
    if h > 0:
        j = ii + h - 1
        ok &= j < n
        jj = np.where(ok, j, 0)
        ok &= (sess[jj] == sess[ii]) & ((dates[jj] - dates[ii]) == (h - 1) * BAR)
    else:
        last = np.r_[np.flatnonzero(sess[1:] != sess[:-1]), n - 1]  # last bar of each session
        sid = np.cumsum(np.r_[True, sess[1:] != sess[:-1]]) - 1
        jj = last[sid[ii]]
    jj = np.where(ok, jj, ii)
    nbar = jj - ii + 1
    ss = (cs[jj + 1] - cs[ii + 1]) + fo[ii] ** 2
    target = np.where(ok, np.log(np.maximum(ss / nbar, EPS_VAR)), np.nan)
    tt = pd.Series(np.where(ok, dates[jj] + BAR, pd.NaT), dtype="datetime64[ns, UTC]")
    return target, tt


def lagged_log_rv(bars: pd.DataFrame, times) -> pd.DataFrame:
    """HAR-style controls from bars ending by t: last 6 bars, previous session, previous 5 sessions."""
    r, _ = bar_returns(bars)
    r2 = r * r
    cs = np.r_[0.0, np.cumsum(r2)]
    dates = pd.DatetimeIndex(bars["date"])
    i = dates.get_indexer(pd.DatetimeIndex(times))  # bar starting at t: bars i-6 .. i-1 end by t
    ok = i >= 6
    ii = np.where(ok, i, 6)
    lag30 = np.where(ok, (cs[ii] - cs[ii - 6]) / 6, np.nan)
    per_sess = pd.Series(r2).groupby(bars["session"].to_numpy()).mean()
    d1, d5 = per_sess.shift(1), per_sess.shift(1).rolling(5).mean()
    sess = bars["session"].to_numpy()[np.where(i >= 0, i, 0)]
    has = i >= 0
    lag = lambda v: np.log(np.maximum(v, EPS_VAR))  # noqa: E731
    return pd.DataFrame({
        "log_rv_lag30m": lag(lag30),
        "log_rv_lag1d": np.where(has, lag(d1.reindex(sess).to_numpy()), np.nan),
        "log_rv_lag5d": np.where(has, lag(d5.reindex(sess).to_numpy()), np.nan),
    })


def lagged_returns(bars: pd.DataFrame, times) -> pd.DataFrame:
    """Signed log returns to the close of the bar ending at t from 6 / 78 / 390 bars earlier, and
    their negative parts (POST-HOC leverage controls)."""
    c = np.log(bars["close"].to_numpy(float))
    i = pd.DatetimeIndex(bars["date"]).get_indexer(pd.DatetimeIndex(times)) - 1  # bar closing at t
    out = {}
    for name, k in (("30m", 6), ("1d", 78), ("5d", 390)):
        ok = i - k >= 0
        ii = np.where(ok, i, k)
        ret = np.where(ok, c[ii] - c[ii - k], np.nan)
        out[f"ret_{name}"], out[f"neg_ret_{name}"] = ret, np.minimum(ret, 0.0)
    return pd.DataFrame(out)[LEVERAGE]


# ---------------------------------------------------------------- pure: option-side features

def slog(x) -> np.ndarray:
    x = np.asarray(x, dtype=float)
    return np.sign(x) * np.log1p(np.abs(x))


def dealer_features(snap: pd.DataFrame) -> pd.DataFrame:
    """Scale-free dealer-positioning block from raw thetadata_gex.py snapshot columns."""
    spot, zg = snap["spot"].to_numpy(float), snap["zero_gamma"].to_numpy(float)
    return pd.DataFrame({
        "gex_regime": snap["net_gex"].to_numpy(float) / (snap["abs_gex_total"].to_numpy(float) + 1e-8),
        "gex_slog": slog(snap["net_gex"]),
        "above_zero_gamma": np.nan_to_num(np.sign(spot - zg)),
        "zero_gamma_dist": np.nan_to_num(np.clip((spot - zg) / spot, -ZG_CLIP, ZG_CLIP)),
        "gex_0dte_slog": slog(snap["net_gex_0dte_raw"].fillna(0.0)),
        "vex_slog": slog(snap["net_vex"]), "cex_slog": slog(snap["net_cex"]),
        "vex_0dte_slog": slog(snap["net_vex_0dte"]), "cex_0dte_slog": slog(snap["net_cex_0dte"]),
    }, index=snap.index)


def atm_iv(chain: pd.DataFrame, spot: float, day: date) -> tuple[float, float]:
    """(front, 0dte) ATM IV at one timestamp: mean call/put implied_vol at the strike nearest spot,
    among quotes with implied_vol >= MIN_IV and midpoint > 0. front = nearest expiry after `day`."""
    c = chain[(chain["implied_vol"] >= MIN_IV) & (chain["midpoint"] > 0)]
    today = day.isoformat()

    def at(exp: str) -> float:
        e = c[c["expiration"] == exp]
        if e.empty:
            return np.nan
        k = e["strike"].to_numpy()[np.argmin(np.abs(e["strike"].to_numpy() - spot))]
        return float(e.loc[e["strike"] == k, "implied_vol"].mean())

    later = sorted(x for x in c["expiration"].unique() if x > today)
    return (at(later[0]) if later else np.nan), at(today)


def day_iv(symbol: str, day: date) -> list[dict]:
    """ATM IV rows for one research day (I/O worker)."""
    p = TD_ROOT / "iv_5m" / f"symbol={symbol}" / f"date={day.isoformat()}" / "part.parquet"
    if not p.exists():
        return []
    iv = pd.read_parquet(p, columns=[*KEYS, "timestamp", "implied_vol", "midpoint", "underlying_price"])
    iv[KEYS] = contract_keys(iv)
    has_0dte = bool((iv["expiration"] == day.isoformat()).any())
    rows = []
    for ts, snap in iv.groupby("timestamp", sort=True):
        spot = float(snap["underlying_price"].median())
        if not np.isfinite(spot) or spot <= 0:
            continue
        front, zero = atm_iv(snap, spot, day)
        rows.append({"computed_at": pd.Timestamp(ts).tz_convert("UTC"), "iv_front": front,
                     "iv_0dte": zero, "is_0dte_day": float(has_0dte)})
    return rows


def calendar_dummies(times) -> pd.DataFrame:
    et = pd.DatetimeIndex(times).tz_convert(ET)
    bucket = np.clip((et.hour * 60 + et.minute - (9 * 60 + 30)) // 30, 0, 12)
    out = {f"tod_{b}": (bucket == b).astype(float) for b in range(1, 13)}
    out |= {f"dow_{d}": (et.dayofweek == d).astype(float) for d in range(1, 5)}
    return pd.DataFrame(out)


def build_frame(bars: pd.DataFrame, snaps: pd.DataFrame, iv: pd.DataFrame) -> pd.DataFrame:
    """One row per snapshot: features at t, and targets/target_time per horizon."""
    snaps = snaps.sort_values("computed_at").reset_index(drop=True)
    t = snaps["computed_at"]
    df = pd.DataFrame({"date": t.to_numpy()}).astype({"date": "datetime64[ns, UTC]"})
    df = pd.concat([df, dealer_features(snaps).reset_index(drop=True),
                    lagged_log_rv(bars, t).reset_index(drop=True),
                    lagged_returns(bars, t).reset_index(drop=True),
                    calendar_dummies(t).reset_index(drop=True)], axis=1)
    iv = iv.set_index("computed_at").reindex(pd.DatetimeIndex(t))
    df["log_iv_front"] = np.log(iv["iv_front"].to_numpy())
    df["log_iv_0dte"] = np.nan_to_num(np.log(iv["iv_0dte"].to_numpy()))
    df["is_0dte_day"] = iv["is_0dte_day"].to_numpy()
    for name, h in HORIZONS.items():
        y, tt = forward_log_rv(bars, t, h)
        df[f"y_{name}"] = y
        df[f"target_time_{name}"] = tt.to_numpy()
    return df


def controls(df: pd.DataFrame) -> list[str]:
    return CONTROLS_CONT + [c for c in df.columns if c.startswith(("tod_", "dow_"))]


# ---------------------------------------------------------------- pure: estimation

def _design(X: np.ndarray) -> np.ndarray:
    return np.column_stack([np.ones(len(X)), X])


def ols(X: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Coefficients [intercept, *X] by least squares."""
    return np.linalg.lstsq(_design(X), y, rcond=None)[0]


def oos_predict(X: np.ndarray, y: np.ndarray, folds) -> np.ndarray:
    """Concatenated walk-forward OLS predictions over the folds' test rows."""
    return np.concatenate([_design(X[te]) @ ols(X[tr], y[tr]) for tr, te in folds])


def bench_predict(y: np.ndarray, folds) -> np.ndarray:
    return np.concatenate([np.full(len(te), y[tr].mean()) for tr, te in folds])


def oos_r2(y: np.ndarray, pred: np.ndarray, bench: np.ndarray) -> float:
    return float(1.0 - np.sum((y - pred) ** 2) / np.sum((y - bench) ** 2))


def block_bootstrap_r2(day: np.ndarray, y, pc, pf, pb, n: int = 1000, block: int = BOOT_BLOCK,
                       seed: int = 0) -> np.ndarray:
    """Moving-block bootstrap over days of (R2_ctrl, R2_full, dR2); returns an (n, 3) array.
    `day` = integer day id per OOS row, in time order."""
    _, d = np.unique(day, return_inverse=True)
    nd = d.max() + 1
    sse = np.stack([np.bincount(d, (y - p) ** 2, minlength=nd) for p in (pc, pf, pb)], axis=1)
    rng = np.random.default_rng(seed)
    b = min(block, nd)
    nb = int(np.ceil(nd / b))
    out = np.empty((n, 3))
    for k in range(n):
        idx = (rng.integers(0, nd - b + 1, nb)[:, None] + np.arange(b)).ravel()[:nd]
        c, f, z = sse[idx].sum(axis=0)
        out[k] = (1 - c / z, 1 - f / z, (c - f) / z)
    return out


def newey_west(X: np.ndarray, resid: np.ndarray, lags: int) -> np.ndarray:
    """HAC (Bartlett) covariance of OLS coefficients. X includes the intercept column if any."""
    xu = X * resid[:, None]
    S = xu.T @ xu
    for L in range(1, min(lags, len(X) - 1) + 1):
        g = xu[L:].T @ xu[:-L]
        S += (1.0 - L / (lags + 1.0)) * (g + g.T)
    bread = np.linalg.inv(X.T @ X)
    return bread @ S @ bread


def hac_standardized(X: np.ndarray, y: np.ndarray, lags: int, names: list[str], test: list[str]) -> dict:
    """In-sample standardized OLS (X, y z-scored) with HAC 95% CIs, plus a HAC Wald test of `test`."""
    sd = X.std(axis=0)
    keep = sd > 0
    Z = (X[:, keep] - X[:, keep].mean(axis=0)) / sd[keep]
    names = [nm for nm, k in zip(names, keep) if k]
    yz = (y - y.mean()) / y.std()
    D = _design(Z)
    beta = np.linalg.lstsq(D, yz, rcond=None)[0]
    resid = yz - D @ beta
    cov = newey_west(D, resid, lags)
    se = np.sqrt(np.diag(cov))
    coefs = {nm: {"beta": float(beta[i + 1]), "se": float(se[i + 1]),
                  "lo": float(beta[i + 1] - 1.96 * se[i + 1]), "hi": float(beta[i + 1] + 1.96 * se[i + 1]),
                  "t": float(beta[i + 1] / se[i + 1])} for i, nm in enumerate(names)}
    idx = [names.index(nm) + 1 for nm in test if nm in names]
    b, V = beta[idx], cov[np.ix_(idx, idx)]
    w = float(b @ np.linalg.solve(V, b)) if idx else float("nan")
    return {"coefs": coefs, "wald": w, "wald_df": len(idx),
            "wald_p": float(chi2.sf(w, len(idx))) if idx else float("nan"),
            "r2_in_sample": float(1 - resid.var() / yz.var())}


def shift_block(X: np.ndarray, session_start: np.ndarray, k: int) -> np.ndarray:
    """Roll rows by k whole sessions (row offset = first row of session k), as null_test.shift_gex."""
    return np.roll(X, session_start[k], axis=0)


def analyze(df: pd.DataFrame, horizon: str, perms: int = 199, boot: int = 1000, seed: int = 0,
            n_splits: int = N_SPLITS, extra_controls=()) -> dict:
    """Walk-forward dR^2, bootstrap CI, session-shift null and in-sample HAC coefficients for one horizon.
    extra_controls: appended to the pre-declared controls (the POST-HOC LEVERAGE check)."""
    ctrl = controls(df) + list(extra_controls)
    d = df.dropna(subset=ctrl + DEALER + [f"y_{horizon}"]).reset_index(drop=True)
    d = d.assign(target_time=d[f"target_time_{horizon}"])
    y = d[f"y_{horizon}"].to_numpy(float)
    Xc, Xg = d[ctrl].to_numpy(float), d[DEALER].to_numpy(float)
    Xk = d[CLASSIC].to_numpy(float)
    folds = session_folds(d, n_splits=n_splits, embargo_sessions=EMBARGO_SESSIONS)
    te = np.concatenate([t for _, t in folds])
    yo, pb = y[te], bench_predict(y, folds)
    pc = oos_predict(Xc, y, folds)
    pf = oos_predict(np.hstack([Xc, Xg]), y, folds)
    pk = oos_predict(np.hstack([Xc, Xk]), y, folds)
    r2c, r2f, r2k = (oos_r2(yo, p, pb) for p in (pc, pf, pk))
    edges = np.cumsum([0] + [len(t) for _, t in folds])
    fold_dr2 = [[oos_r2(yo[a:b], p[a:b], pb[a:b]) - oos_r2(yo[a:b], pc[a:b], pb[a:b]) for a, b in zip(edges, edges[1:])]
                for p in (pf, pk)]
    fold_first_day = [str(pd.Timestamp(d["date"].iloc[t[0]]).tz_convert(ET).date()) for _, t in folds]
    sid = session_ids(d["date"])
    bs = block_bootstrap_r2(sid[te], yo, pc, pf, pb, n=boot, seed=seed)
    bsk = block_bootstrap_r2(sid[te], yo, pc, pk, pb, n=boot, seed=seed)

    n_sessions = int(sid.max()) + 1
    session_start = np.searchsorted(sid, np.arange(n_sessions))
    assert abs(oos_r2(yo, oos_predict(np.hstack([Xc, shift_block(Xg, session_start, 0)]), y, folds), pb) - r2f) < 1e-12
    shifts = np.arange(MIN_SHIFT, n_sessions - MIN_SHIFT + 1)
    if 0 < perms < len(shifts):
        shifts = np.sort(np.random.default_rng(seed).choice(shifts, perms, replace=False))
    null_full, null_classic = np.empty(len(shifts)), np.empty(len(shifts))
    for n, k in enumerate(shifts):
        null_full[n] = oos_r2(yo, oos_predict(np.hstack([Xc, shift_block(Xg, session_start, int(k))]), y, folds), pb) - r2c
        null_classic[n] = oos_r2(yo, oos_predict(np.hstack([Xc, shift_block(Xk, session_start, int(k))]), y, folds), pb) - r2c
    p_full = (1 + int((null_full >= r2f - r2c).sum())) / (1 + len(shifts))
    p_classic = (1 + int((null_classic >= r2k - r2c).sum())) / (1 + len(shifts))

    ins = hac_standardized(np.hstack([Xc, Xg]), y, HAC_LAGS.get(horizon, 78), ctrl + DEALER, DEALER)
    ci = lambda a: [float(np.percentile(a, 2.5)), float(np.percentile(a, 97.5))]  # noqa: E731
    return {
        "horizon": horizon, "n_obs": int(len(d)), "n_days": int(n_sessions), "n_oos": int(len(te)),
        "n_oos_days": int(np.unique(sid[te]).size), "n_folds": len(folds),
        "first_day": str(pd.Timestamp(d["date"].min()).tz_convert(ET).date()),
        "last_day": str(pd.Timestamp(d["date"].max()).tz_convert(ET).date()),
        "r2_ctrl": r2c, "r2_ctrl_ci": ci(bs[:, 0]), "r2_full": r2f, "r2_full_ci": ci(bs[:, 1]),
        "dr2": r2f - r2c, "dr2_ci": ci(bs[:, 2]), "p_perm": p_full,
        "fold_first_day": fold_first_day, "fold_dr2": fold_dr2[0], "fold_dr2_classic": fold_dr2[1],
        "dr2_classic": r2k - r2c, "dr2_classic_ci": ci(bsk[:, 2]), "p_perm_classic": p_classic,
        "n_shifts": int(len(shifts)), "null_p95": float(np.percentile(null_full, 95)),
        "null_max": float(null_full.max()), "null_classic_max": float(null_classic.max()),
        "null_classic_p95": float(np.percentile(null_classic, 95)), "extra_controls": list(extra_controls),
        "null_median": float(np.median(null_full)),
        "null_full": null_full.tolist(), "null_classic": null_classic.tolist(),
        "hac_lags": HAC_LAGS.get(horizon, 78), "in_sample": ins,
        "zero_rv_share": float((y <= np.log(EPS_VAR) + 1e-12).mean()),
    }


# ---------------------------------------------------------------- I/O (research rows only)

def research_cutoff(symbol: str) -> tuple[list[date], pd.Timestamp]:
    """Research days (from iv_5m partition NAMES only) and the exclusive UTC cutoff after the last one."""
    root = TD_ROOT / "iv_5m" / f"symbol={symbol}"
    sessions = [date.fromisoformat(p.name[5:]) for p in root.glob("date=*") if (p / "part.parquet").exists()]
    days = research_sessions(sessions)
    if not days:
        raise SystemExit(f"no research iv_5m days for {symbol}")
    return days, pd.Timestamp(days[-1] + timedelta(days=1), tz=ET).tz_convert("UTC")


def load_bars(symbol: str, cutoff: pd.Timestamp) -> pd.DataFrame:
    files = [f for f in sorted((BARS_DIR / symbol).glob("*.parquet"))
             if date.fromisoformat(f.name[:10]) < cutoff.tz_convert(ET).date()]
    if not files:
        raise FileNotFoundError(f"no Databento bars for {symbol}; run databento_fetch.py eq-ohlcv-1m")
    m = pd.concat([pd.read_parquet(f, columns=["open", "high", "low", "close", "volume"],
                                   filters=[("ts_event", "<", cutoff)]) for f in files])
    return aggregate_5m(m)


def load_snapshots(symbol: str, cutoff: pd.Timestamp) -> pd.DataFrame:
    path = GEX_DIR / f"{symbol.lower()}_gex_snapshots.parquet"
    s = pd.read_parquet(path, filters=[("computed_at", "<", cutoff)])
    missing = [c for c in ("net_vex", "net_cex", "net_vex_0dte", "net_cex_0dte") if c not in s]
    if missing:
        raise SystemExit(f"{path} lacks {missing}; rerun thetadata_gex.py --symbol {symbol}")
    s["computed_at"] = pd.to_datetime(s["computed_at"], utc=True).astype("datetime64[ns, UTC]")
    return s


def load_iv(symbol: str, days: list[date], workers: int) -> pd.DataFrame:
    rows = []
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for i, day_rows in enumerate(ex.map(day_iv, [symbol] * len(days), days, chunksize=8)):
            rows.extend(day_rows)
            if (i + 1) % 200 == 0 or i + 1 == len(days):
                print(f"  ATM IV {i + 1}/{len(days)} days ({time.time() - t0:.0f}s)", flush=True)
    iv = pd.DataFrame(rows)
    iv["computed_at"] = iv["computed_at"].astype("datetime64[ns, UTC]")
    return iv


def load_frame(symbol: str, workers: int) -> pd.DataFrame:
    days, cutoff = research_cutoff(symbol)
    print(f"{symbol}: research = {len(days)} sessions {days[0]} -> {days[-1]}; reads bounded by < {cutoff}")
    bars, snaps = load_bars(symbol, cutoff), load_snapshots(symbol, cutoff)
    df = build_frame(bars, snaps, load_iv(symbol, days, workers))
    # Holdout guard: nothing at/after the research cutoff, and no target reaching it.
    assert (df["date"] < cutoff).all() and (bars["date"] < cutoff).all(), "LEAK: verify-period row loaded"
    for h in HORIZONS:
        tt = df[f"target_time_{h}"].dropna()
        assert (tt <= cutoff).all() and (tt > df.loc[tt.index, "date"]).all()
    assert pd.Timestamp(days[-1], tz=ET) < VERIFY_START
    return df


# ---------------------------------------------------------------- plot (aggregates only)

SURFACE, INK, INK2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
# Categorical slots 1-3 of the dataviz reference palette, in fixed order (as plot_delta_hedge.py).
H_COLORS = {"30m": "#2a78d6", "60m": "#eb6834", "ros": "#1baf7a"}
H_LABELS = {"30m": "next 30 min", "60m": "next 60 min", "ros": "rest of session"}
F_LABELS = {"gex_regime": "GEX regime (net / gross)", "gex_slog": "net GEX (signed log)",
            "above_zero_gamma": "spot above zero-gamma", "zero_gamma_dist": "distance to zero-gamma",
            "gex_0dte_slog": "0DTE net GEX (signed log)", "vex_slog": "VEX (signed log)",
            "cex_slog": "CEX (signed log)", "vex_0dte_slog": "0DTE VEX (signed log)",
            "cex_0dte_slog": "0DTE CEX (signed log)", "log_iv_front": "ref: log ATM IV (front)",
            "log_rv_lag30m": "ref: log RV last 30 min"}


def _style(ax, title):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=10.5, color=INK)
    ax.tick_params(colors=INK2, labelsize=8.5)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
    ax.set_axisbelow(True)


def plot_study(res: dict, out: Path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D

    sym, hs = res["symbol"], [h for h in HORIZONS if h in res["horizons"]]
    rob = res.get("robust_leverage", {})
    feats = DEALER + ["log_iv_front", "log_rv_lag30m"]
    fig, (a, b) = plt.subplots(1, 2, figsize=(13.5, 6.6), facecolor=SURFACE,
                               gridspec_kw={"width_ratios": [1.55, 1], "wspace": 0.45})
    r0 = res["horizons"][hs[0]]
    fig.suptitle(f"{sym}: does dealer positioning forecast forward realized vol beyond implied vol and HAR controls?\n"
                 f"5-min snapshots, research sessions {r0['first_day']} to {r0['last_day']} (sealed verify block not loaded)",
                 x=0.01, y=1.0, ha="left", fontsize=11.5, color=INK)

    _style(a, "a  Standardized OLS coefficients on log forward RV\n    (in sample, 95% Newey-West CI)")
    ypos = np.arange(len(feats))[::-1].astype(float)
    ypos[-2:] -= 0.6  # gap before the two reference controls
    off = {h: (1 - i) * 0.24 for i, h in enumerate(hs)}
    for h in hs:
        co = res["horizons"][h]["in_sample"]["coefs"]
        bb = np.array([co[f]["beta"] for f in feats])
        lo, hi = np.array([co[f]["lo"] for f in feats]), np.array([co[f]["hi"] for f in feats])
        a.hlines(ypos + off[h], lo, hi, color=H_COLORS[h], lw=2)
        a.plot(bb, ypos + off[h], "o", ms=6, color=H_COLORS[h], mec=SURFACE, mew=1.5, label=H_LABELS[h])
    a.axvline(0, color=INK2, lw=0.8)
    a.set_yticks(ypos, [F_LABELS[f] for f in feats], color=INK)
    a.grid(axis="x", color=GRID, lw=0.6)
    a.set_xlabel("standardized coefficient (SD of log RV per SD of regressor)", color=INK2, fontsize=9)
    a.legend(fontsize=8.5, frameon=False, labelcolor=INK, loc="upper right", title="forward window",
             title_fontsize=8.5)
    a.text(0.0, -0.11, "All 9 dealer features in one model, plus the controls: log ATM IV (front, 0DTE), 0DTE-day flag,\n"
           "HAR RV (30 min, 1 day, 5 days), time-of-day and weekday dummies. Negative = more dealer\n"
           "long gamma goes with lower forward vol.",
           transform=a.transAxes, fontsize=8, color=INK2, va="top")

    _style(b, "b  Out-of-sample R² gain over controls\n    (expanding walk-forward, 95% day-block CI)")
    marks = [("dr2", "horizons", "o", True, "all 9 dealer features"),
             ("dr2_classic", "horizons", "o", False, "GEX regime only"),
             ("dr2_classic", "robust_leverage", "D", False, "GEX regime only, + leverage controls (post hoc)")]
    marks = [m for m in marks if m[1] == "horizons" or rob]
    dx = np.linspace(-0.22, 0.22, len(marks))
    tops, bots = [], []
    for i, h in enumerate(hs):
        for (key, src, mk, fill, _), x0 in zip(marks, dx):
            r = res[src][h]
            v, lo, hi = 100 * r[key], 100 * r[f"{key}_ci"][0], 100 * r[f"{key}_ci"][1]
            tops.append(hi)
            bots.append(lo)
            b.vlines(i + x0, lo, hi, color=H_COLORS[h], lw=2)
            b.plot(i + x0, v, mk, ms=7 if mk == "o" else 6, color=H_COLORS[h] if fill else SURFACE,
                   mec=H_COLORS[h], mew=1.5 if fill else 2)
        r = res["horizons"][h]
        b.plot([i - 0.3, i + 0.3], [100 * r["null_p95"]] * 2, color=INK2, lw=1.2, ls=(0, (1, 1.5)))
        p_txt = "\n".join(f"{res[src][h][('p_perm' if key == 'dr2' else 'p_perm_classic')]:.3f}" for key, src, *_ in marks)
        b.text(i, 0.985, f"R² ctrl {100 * r['r2_ctrl']:.1f}%\np:\n{p_txt}", transform=b.get_xaxis_transform(),
               ha="center", va="top", fontsize=7.5, color=INK, linespacing=1.25)
    b.axhline(0, color=INK2, lw=0.8)
    b.set_xticks(np.arange(len(hs)), [H_LABELS[h] for h in hs], color=INK)
    b.set_xlim(-0.6, len(hs) - 0.4)
    lo_all, hi_all = min(min(bots), 0.0), max(tops)
    span = hi_all - lo_all
    b.set_ylim(lo_all - 0.06 * span, hi_all + 0.42 * span)
    b.grid(axis="y", color=GRID, lw=0.6)
    b.set_ylabel("ΔR² out of sample (percentage points)", color=INK2, fontsize=9)
    handles = [Line2D([], [], ls="", marker=mk, ms=7 if mk == "o" else 6, color=INK2 if fill else SURFACE,
                      mec=INK2, mew=1.5 if fill else 2, label=lab) for _, _, mk, fill, lab in marks]
    handles.append(Line2D([], [], color=INK2, lw=1.2, ls=(0, (1, 1.5)),
                          label="95th pct of session-shifted null (all 9)"))
    b.legend(handles=handles, fontsize=8, frameon=False, labelcolor=INK, loc="upper left",
             bbox_to_anchor=(0.0, -0.08), ncol=1)
    b.text(0.0, -0.275, "p = session-shift permutation p-values, top to bottom in marker order.\nColour = forward window (panel a).",
           transform=b.transAxes, fontsize=8, color=INK2, va="top")
    fig.savefig(out, dpi=150, bbox_inches="tight", facecolor=SURFACE)
    plt.close(fig)


# ---------------------------------------------------------------- main

SPECS = (("horizons", "primary"), ("robust_leverage", "post-hoc +leverage controls"))


def summary_rows(res: dict) -> list[dict]:
    rows = []
    for key, spec in SPECS:
        for h, r in res.get(key, {}).items():
            co = r["in_sample"]["coefs"]
            row = {"symbol": res["symbol"], "spec": spec, "horizon": h, "n_obs": r["n_obs"], "n_days": r["n_days"],
                   "n_oos": r["n_oos"], "n_oos_days": r["n_oos_days"],
                   "r2_ctrl_oos": r["r2_ctrl"], "r2_full_oos": r["r2_full"], "dr2": r["dr2"],
                   "dr2_lo": r["dr2_ci"][0], "dr2_hi": r["dr2_ci"][1], "p_perm": r["p_perm"],
                   "dr2_classic": r["dr2_classic"], "dr2_classic_lo": r["dr2_classic_ci"][0],
                   "dr2_classic_hi": r["dr2_classic_ci"][1], "p_perm_classic": r["p_perm_classic"],
                   "n_shifts": r["n_shifts"], "null_max": r["null_max"], "null_classic_max": r["null_classic_max"],
                   "folds_dr2_positive": int(np.sum(np.array(r["fold_dr2"]) > 0)),
                   "folds_dr2_classic_positive": int(np.sum(np.array(r["fold_dr2_classic"]) > 0)),
                   "wald_p_hac": r["in_sample"]["wald_p"]}
            for f in DEALER + ["log_iv_front", "log_rv_lag30m"]:
                row[f"b_{f}"], row[f"t_{f}"] = co[f]["beta"], co[f]["t"]
                row[f"lo_{f}"], row[f"hi_{f}"] = co[f]["lo"], co[f]["hi"]
            rows.append(row)
    return rows


def print_table(res: dict) -> None:
    for key, spec in SPECS:
        hs = res.get(key)
        if not hs:
            continue
        print(f"\n{res['symbol']} [{spec}]  (OOS = pooled walk-forward, {N_SPLITS} session folds; "
              f"ΔR² CI = {BOOT_BLOCK}-day block bootstrap; p = session-shift null)")
        print(f"{'h':>4} {'n':>6} {'days':>5} {'R2 ctrl':>8} {'R2 full':>8} {'ΔR2 all9':>9} {'95% CI':>17} "
              f"{'p':>6} {'folds+':>6} {'ΔR2 regime':>11} {'95% CI':>17} {'p':>6} {'folds+':>6} {'Wald p':>7}")
        for h, r in hs.items():
            ci, cik = r["dr2_ci"], r["dr2_classic_ci"]
            print(f"{h:>4} {r['n_obs']:>6} {r['n_days']:>5} {100 * r['r2_ctrl']:>7.2f}% {100 * r['r2_full']:>7.2f}% "
                  f"{100 * r['dr2']:>+9.3f} [{100 * ci[0]:+.3f}, {100 * ci[1]:+.3f}] {r['p_perm']:>6.3f} "
                  f"{int(np.sum(np.array(r['fold_dr2']) > 0)):>3}/{len(r['fold_dr2']):<2} "
                  f"{100 * r['dr2_classic']:>+11.3f} [{100 * cik[0]:+.3f}, {100 * cik[1]:+.3f}] {r['p_perm_classic']:>6.3f} "
                  f"{int(np.sum(np.array(r['fold_dr2_classic']) > 0)):>3}/{len(r['fold_dr2_classic']):<2} "
                  f"{r['in_sample']['wald_p']:>7.1e}")
        print(f"null ({hs[next(iter(hs))]['n_shifts']} shifts) max ΔR2 all9 / regime: "
              + ", ".join(f"{h} {100 * r['null_max']:+.3f} / {100 * r['null_classic_max']:+.3f}" for h, r in hs.items()))
        print("standardized in-sample coefficients (t, Newey-West):")
        feats = DEALER + ["log_iv_front", "log_rv_lag30m"] + [f for f in LEVERAGE if f in hs[next(iter(hs))]["in_sample"]["coefs"]]
        print(f"{'':>24}" + "".join(f"{h:>16}" for h in hs))
        for f in feats:
            print(f"{f:>24}" + "".join(f"{r['in_sample']['coefs'][f]['beta']:>+9.3f} ({r['in_sample']['coefs'][f]['t']:>+5.1f})"
                                       for r in hs.values()))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--symbol", default="QQQ")
    ap.add_argument("--perms", type=int, default=199, help="session shifts for the null (0 = all)")
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--rebuild", action="store_true", help="recompute the cached feature frame")
    ap.add_argument("--replot", action="store_true", help="only redraw the plot from the saved JSON")
    args = ap.parse_args()
    sym = args.symbol.upper()
    OUT.mkdir(parents=True, exist_ok=True)
    js = OUT / f"gex_vol_{sym.lower()}.json"
    png = PLOTS / f"gex_vol_{sym.lower()}.png"
    if args.replot:
        plot_study(json.loads(js.read_text()), png)
        print(f"Saved: {png}")
        return 0

    cache = OUT / f"frame_{sym.lower()}.parquet"
    df = pd.read_parquet(cache) if cache.exists() and not args.rebuild else None
    if df is None or not set(LEVERAGE) <= set(df.columns):
        df = load_frame(sym, args.workers)
        df.to_parquet(cache, index=False)
    assert pd.Timestamp(df["date"].max()).tz_convert(ET) < VERIFY_START

    res = {"symbol": sym, "controls": controls(df), "dealer": DEALER, "classic": CLASSIC,
           "n_splits": N_SPLITS, "embargo_sessions": EMBARGO_SESSIONS, "eps_var": EPS_VAR,
           "boot_block_days": BOOT_BLOCK, "horizons": {}}
    for h in HORIZONS:
        t0 = time.time()
        res["horizons"][h] = analyze(df, h, perms=args.perms, boot=args.boot, seed=args.seed)
        print(f"  {sym} {h}: done ({time.time() - t0:.0f}s)", flush=True)
    res["robust_leverage"] = {}  # POST-HOC, see LEVERAGE
    for h in HORIZONS:
        t0 = time.time()
        res["robust_leverage"][h] = analyze(df, h, perms=args.perms, boot=args.boot, seed=args.seed,
                                            extra_controls=LEVERAGE)
        print(f"  {sym} {h} + leverage controls (post-hoc): done ({time.time() - t0:.0f}s)", flush=True)
    js.write_text(json.dumps(res, indent=1))
    print_table(res)

    csv = OUT / "gex_vol_summary.csv"
    rows = pd.DataFrame(summary_rows(res))
    if csv.exists():
        old = pd.read_csv(csv)
        rows = pd.concat([old[old["symbol"] != sym], rows], ignore_index=True)
    rows.to_csv(csv, index=False)
    PLOTS.mkdir(parents=True, exist_ok=True)
    plot_study(res, png)
    print(f"Saved: {js}\n       {csv}\n       {png}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
