"""Offline checks for delta_hedge on synthetic GBM paths marked at Black-Scholes prices."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

import delta_hedge as dh
import greeks as g

T_0DTE = 6.5 / (24 * 365)  # 09:30 -> 16:00 on the calendar clock
BARS = 78


def paths(n, real_vol, imp_vol, T0=T_0DTE, span=None, k_rel=1.0, vol_of_vol=0.0, seed=0):
    """Zero-drift GBM on the calendar clock; options marked at BS(r=0) with the (possibly random-walk)
    IV; an expiring option's last mark is intrinsic."""
    rng = np.random.default_rng(seed)
    span = T0 if span is None else span
    T = T0 - np.linspace(0.0, span, BARS + 1)
    dt, S0 = span / BARS, 100.0
    K = S0 * k_rel
    out = []
    for _ in range(n):
        z = rng.standard_normal(BARS)
        S = S0 * np.exp(np.r_[0.0, np.cumsum(real_vol * np.sqrt(dt) * z - 0.5 * real_vol ** 2 * dt)])
        iv = np.full(BARS + 1, imp_vol)
        if vol_of_vol:
            iv = imp_vol * np.exp(np.r_[0.0, np.cumsum(vol_of_vol * rng.standard_normal(BARS))])
        V = g.bs_price(S, K, T, iv, "C", r=0) + g.bs_price(S, K, T, iv, "P", r=0)
        if T[-1] <= 0:
            V[-1] = abs(S[-1] - K)
        out.append(dict(S=S, V=V, iv_call=iv, iv_put=iv, T=T, K=K))
    return out


def run(ps, every, charm=False, **kw):
    return [dh.hedge_pnl(**p, rebalance_every=every, charm_adjust=charm, r=0, **kw) for p in ps]


def col(res, key):
    return np.array([x[key] for x in res])


class HedgePnlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fair = paths(300, 0.2, 0.2, seed=1)

    def test_fair_vol_mean_near_zero(self):
        res = run(self.fair, 1)
        self.assertLess(abs(col(res, "pnl").mean()) / col(res, "premium").mean(), 0.03)

    def test_sign_follows_implied_minus_realized(self):
        rich = run(paths(300, 0.1, 0.2, seed=2), 1)  # implied > realized: short vol wins
        cheap = run(paths(300, 0.3, 0.2, seed=3), 1)
        self.assertGreater(col(rich, "pnl").mean(), 0)
        self.assertLess(col(cheap, "pnl").mean(), 0)
        self.assertGreater(col(rich, "theo_vol_pnl").mean(), 0)
        self.assertLess(col(cheap, "theo_vol_pnl").mean(), 0)
        self.assertLess(col(rich, "rv").mean(), 0.2)
        self.assertGreater(col(cheap, "rv").mean(), 0.2)

    def test_std_falls_with_rebalance_frequency(self):
        sd = [col(run(self.fair, e), "pnl").std() for e in (1, 6, 12, dh.ENTRY_ONLY, None)]
        self.assertTrue(sd[0] < sd[1] < sd[2], sd)
        self.assertGreater(sd[-1], 2 * sd[2], sd)
        # an ATM straddle's entry delta is ~0, so hedging once at entry is ~no hedge
        self.assertAlmostEqual(sd[3] / sd[-1], 1.0, delta=0.05)

    def test_second_order_terms_shrink_residual(self):
        # one day of a 30-day option while IV random-walks ~4.4 vol points a day
        res = run(paths(200, 0.2, 0.2, T0=30 / 365, span=1 / 365, vol_of_vol=0.01, seed=4), 1)
        r1, r2 = col(res, "res1_absbar").mean(), col(res, "res2_absbar").mean()
        self.assertLess(r2, 0.5 * r1, (r1, r2))
        self.assertGreater(np.abs(col(res, "vega")).mean(), r1)  # vol moves dominate this setup

    def test_charm_adjust_helps_only_when_spot_is_pinned(self):
        # Off-ATM 0DTE. Under GBM at realized = implied, E[delta] barely drifts (the charm at fixed
        # spot is offset by the diffusion of spot through a convex delta), so pre-shifting by charm
        # adds error; when realized << implied, delta decays roughly at the charm rate and it helps.
        pinned = paths(300, 0.1, 0.2, k_rel=1.004, seed=5)
        self.assertLess(col(run(pinned, 12, True), "pnl").std(), col(run(pinned, 12), "pnl").std())
        fair = paths(300, 0.2, 0.2, k_rel=1.004, seed=5)
        self.assertGreater(col(run(fair, 12, True), "pnl").std(), col(run(fair, 12), "pnl").std())

    def test_implied_vol_round_trip(self):
        S, K = 100.0, np.array([95.0, 100.0, 104.0, 100.0])
        T = np.array([0.1, dh.MIN_T_INTRADAY, 0.002, 0.5])
        right = np.array(["P", "C", "C", "P"])
        vol = np.array([0.35, 0.18, 0.25, 0.6])
        iv = dh.implied_vol(g.bs_price(S, K, T, vol, right), S, K, T, right)
        np.testing.assert_allclose(iv, vol, atol=1e-8)
        self.assertTrue(np.isnan(dh.implied_vol([0.0, 200.0], 100.0, 100.0, 0.1, "C")).all())

    def test_unhedged_has_no_hedge_component(self):
        p = self.fair[0]
        r = dh.hedge_pnl(**p, rebalance_every=None, hedge_cost_bps=5.0, r=0)
        self.assertEqual(r["hedge_pnl"], 0.0)
        self.assertEqual(r["hedge_cost"], 0.0)
        self.assertEqual(r["n_rebalances"], 0)
        self.assertAlmostEqual(r["pnl"], r["option_pnl"])
        self.assertAlmostEqual(r["delta_err_charm"], 0.0)

    def test_accounting_identities(self):
        p = self.fair[7]
        fills = (p["V"][0] - 0.02, p["V"][-1] + 0.03)
        for every, charm in ((1, False), (6, False), (12, True), (dh.ENTRY_ONLY, False)):
            r = dh.hedge_pnl(**p, rebalance_every=every, charm_adjust=charm, hedge_cost_bps=1.0,
                             fills=fills, r=0)
            b = r["bars"]
            attributed = sum(r[k] for k in dh.ATTR) + r["res2"]
            self.assertAlmostEqual(attributed, r["option_pnl"] + r["hedge_pnl"], places=9)
            self.assertAlmostEqual(r["pnl"], 100 * (fills[0] - fills[1]) + r["hedge_pnl"] - r["hedge_cost"], places=9)
            self.assertAlmostEqual(r["spread_cost"], 100 * 0.05, places=9)
            trades = np.diff(np.r_[0.0, b["hedge"], 0.0])
            self.assertAlmostEqual(r["hedge_cost"], (np.abs(trades) * p["S"]).sum() * 1e-4, places=9)
        self.assertEqual(dh.hedge_pnl(**p, rebalance_every=1, r=0)["delta_err"], 0.0)  # hedged every bar
        self.assertEqual(dh.hedge_pnl(**p, rebalance_every=dh.ENTRY_ONLY, r=0)["n_rebalances"], 1)
        self.assertEqual(dh.hedge_pnl(**p, rebalance_every=6, r=0)["n_rebalances"], 13)


def write_day(root: Path, day: str, expirations: list[str], spot: float = 100.3):
    """A tiny iv_5m partition: strikes 99/100/101, both rights, 09:30..16:00. Strike 100's put has
    no bid at 09:35 (so 101 must be picked over 99), 101's call has an un-invertible (above the
    IV_HI price) quote at 10:00 and 101's put is missing the 11:00 row."""
    ts = pd.date_range(f"{day} 09:30", f"{day} 16:00", freq="5min", tz=dh.ET)
    rows = []
    for exp in expirations:
        close = pd.Timestamp(f"{exp} 16:00", tz=dh.ET)
        for i, t in enumerate(ts):
            S = spot + 0.05 * np.sin(i)
            T = (close - t).total_seconds() / dh.YEAR_S
            for K in (99.0, 100.0, 101.0):
                for right in ("CALL", "PUT"):
                    if (K, right, t.strftime("%H:%M")) == (101.0, "PUT", "11:00"):
                        continue
                    iv = 0.2 + 0.001 * i
                    mid = float(g.bs_price(S, K, max(T, dh.MIN_T_INTRADAY), iv, right))
                    bid, ask = max(mid - 0.01, 0.0), mid + 0.01
                    if i == 0:
                        bid = ask = np.nan
                    if (K, right, i) == (100.0, "PUT", 1):
                        bid = 0.0
                    if (K, right, t.strftime("%H:%M")) == (101.0, "CALL", "10:00"):
                        bid, ask = 50.0, 50.02
                    rows.append(dict(symbol="TST", expiration=exp, strike=K, right=right, timestamp=t,
                                     bid=bid, ask=ask, implied_vol=iv, underlying_price=S))
    d = root / "symbol=TST" / f"date={day}"
    d.mkdir(parents=True)
    pd.DataFrame(rows).to_parquet(d / "part.parquet", index=False)


class LoadDayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        root = Path(cls.tmp.name)
        write_day(root, "2026-01-07", ["2026-01-07", "2026-01-09"])  # a Wednesday with a 0DTE
        write_day(root, "2026-01-08", ["2026-01-09"])  # no same-day expiry
        cls.patch = mock.patch.object(dh, "IV_ROOT", root)
        cls.patch.start()

    @classmethod
    def tearDownClass(cls):
        cls.patch.stop()
        cls.tmp.cleanup()

    def test_picks_same_day_expiry_and_quoted_strike(self):
        d = dh.load_day("TST", "2026-01-07", 0)
        self.assertEqual((d["expiration"], d["strike"], d["settle"], d["dte"]), ("2026-01-07", 101.0, True, 0))
        self.assertEqual(len(d["S"]), 78)
        self.assertEqual(d["ts"][0].strftime("%H:%M"), "09:35")
        self.assertAlmostEqual(d["T"][0], 385 / (365 * 24 * 60))
        self.assertEqual(d["T"][-1], 0.0)
        i10 = list(d["ts"].strftime("%H:%M")).index("10:00")
        self.assertEqual(d["iv_call"][i10], d["iv_put"][i10])  # un-invertible IV borrowed from the put
        self.assertAlmostEqual(d["iv_put"][12], 0.2 + 0.001 * 13, places=4)  # re-implied from the mid
        i11 = list(d["ts"].strftime("%H:%M")).index("11:00")
        self.assertEqual(d["put_bid"][i11], d["put_bid"][i11 - 1])  # missing row forward-filled
        # borrowed: the 10:00 call, and the ITM put at 16:00 whose mid is its intrinsic (no time value)
        self.assertEqual((d["n_borrow_iv"], d["n_ffill_iv"], d["n_ffill_quote"]), (2, 0, 1))

    def test_settlement_path(self):
        d = dh.load_day("TST", "2026-01-07", 0)
        p = dh.straddle_path(d)
        self.assertAlmostEqual(p["V"][-1], abs(d["S"][-1] - 101.0))
        self.assertEqual(p["fills"], (d["call_bid"][0] + d["put_bid"][0], p["V"][-1]))
        self.assertEqual(p["iv_call"][-1], p["iv_call"][-2])
        self.assertIsNone(dh.straddle_path(d, mid=True)["fills"])

    def test_dte_selection(self):
        self.assertEqual(dh.load_day("TST", "2026-01-07", 1)["expiration"], "2026-01-09")
        self.assertIsNone(dh.load_day("TST", "2026-01-08", 0))
        d = dh.load_day("TST", "2026-01-08", 1)
        self.assertEqual((d["expiration"], d["settle"]), ("2026-01-09", False))
        p = dh.straddle_path(d)
        self.assertAlmostEqual(p["fills"][1], d["call_ask"][-1] + d["put_ask"][-1])  # buy back at the ask
        self.assertIsNone(dh.load_day("TST", "2026-01-09", 0))  # no file

    def test_run_day_and_summary(self):
        rows = dh.run_day("TST", "2026-01-07", 0, bps=0.5)
        self.assertEqual([r["variant"] for r in rows], list(dh.VARIANTS))
        s = dh.summarize(pd.DataFrame(rows + dh.run_day("TST", "2026-01-07", 1, bps=0.5)))
        self.assertEqual(list(s.index), list(dh.VARIANTS))
        self.assertTrue((s["n"] == 2).all())


if __name__ == "__main__":
    unittest.main()
