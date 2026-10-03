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

    def test_frontier_day_and_summary(self):
        costs = (0.5, 2.0)
        rows = dh.run_frontier_day("TST", "2026-01-07", 0, costs=costs)
        self.assertEqual(len(rows), len(dh.FRONTIER) * len(costs))
        by = {(r["cost_bps"], r["variant"]): r for r in rows}
        self.assertEqual(by[0.5, "5m"]["n_rebalances"], 77)  # 78 points, 77 bars
        self.assertEqual(by[0.5, "entry-only"]["n_rebalances"], 1)
        self.assertAlmostEqual(by[2.0, "5m"]["hedge_cost"], 4 * by[0.5, "5m"]["hedge_cost"])  # same trades
        self.assertTrue(np.isnan(by[0.5, "30m"]["band_mean"]))
        self.assertEqual(by[0.5, "band 5"]["band_mean"], 5.0)
        # the WW band widens with the cost by (2 / 0.5)^(1/3)
        self.assertAlmostEqual(by[2.0, "ww 1"]["band_mean"] / by[0.5, "ww 1"]["band_mean"], 4 ** (1 / 3))
        df = pd.DataFrame(rows + dh.run_frontier_day("TST", "2026-01-08", 1, costs=costs))
        s = dh.frontier_summary(df, n_boot=20, block=1)
        per = s[~s["kind"].str.endswith("@clock")]
        self.assertEqual(len(per), len(dh.FRONTIER) * len(costs))
        self.assertTrue((per["n"] == 2).all())
        self.assertEqual(set(s["cost_bps"]), set(costs))


def smile_paths(n, beta, vol=0.2, span=5 / 365, seed=3):
    """GBM whose IV follows dsigma = beta * dS / (S sqrt(T)) (spot-vol correlation), with a
    1-month ATM straddle marked at BS(r=0) on its own IV; T stays far above SMILE_MIN_T."""
    rng = np.random.default_rng(seed)
    T = 30 / 365 - np.linspace(0.0, span, BARS + 1)
    dt = span / BARS
    out = []
    for _ in range(n):
        S = 100.0 * np.exp(np.r_[0.0, np.cumsum(vol * np.sqrt(dt) * rng.standard_normal(BARS))])
        iv = vol + np.r_[0.0, np.cumsum(beta * np.diff(S) / (S[:-1] * np.sqrt(T[:-1])))]
        V = g.bs_price(S, 100.0, T, iv, "C", r=0) + g.bs_price(S, 100.0, T, iv, "P", r=0)
        out.append(dict(S=S, V=V, iv_call=iv, iv_put=iv, T=T, K=100.0))
    return out


class SmileDelta(unittest.TestCase):
    def test_stats_recover_beta_and_zero_is_bs(self):
        p = smile_paths(1, beta=-0.02)[0]
        sxy, sxx, n = dh.smile_stats({**p, "settle": False})
        self.assertAlmostEqual(sxy / sxx, -0.02, places=3)
        self.assertEqual(n, BARS)
        a = dh.hedge_pnl(**p, rebalance_every=6, r=0)
        b = dh.hedge_pnl(**p, rebalance_every=6, r=0, dsig_dS=0.0)
        self.assertEqual(a["pnl"], b["pnl"])

    def test_smile_hedge_cuts_variance_under_spot_vol_correlation(self):
        ps = smile_paths(300, beta=-0.02)
        d = [{**p, "settle": False} for p in ps]
        std = lambda xs: np.std([x["pnl"] for x in xs])  # noqa: E731
        bs = [dh.hedge_pnl(**p, rebalance_every=1, r=0) for p in ps]
        sm = [dh.hedge_pnl(**p, rebalance_every=1, r=0, dsig_dS=dh.smile_dsig_dS(q, -0.02)) for p, q in zip(ps, d)]
        self.assertLess(std(sm), std(bs))
        # The smile hedge's delta_err offsets the spot-driven vega P&L; what's left is gamma noise.
        vega_leg = lambda xs: np.std([x["vega"] + x["delta_err"] for x in xs])  # noqa: E731
        self.assertLess(vega_leg(sm), 0.1 * vega_leg(bs))

    def test_betas_are_out_of_sample(self):
        days = [f"2026-01-{i:02d}" for i in range(1, 31)]
        stats = {day: ((1.0 if i < 20 else 100.0), 1.0, 10) for i, day in enumerate(days)}
        b = dh.smile_betas(stats)
        self.assertIsNone(b[days[dh.SMILE_MIN_DAYS - 1]])
        self.assertEqual(b[days[20]], 1.0)  # day 20's own stats (100) are not used
        self.assertAlmostEqual(b[days[21]], (20 * 1.0 + 100.0) / 21)

    def test_no_adjustment_in_last_hour(self):
        T = np.array([2, 1.5, 1.0, 0.5, 0.0]) / (24 * 365)
        dsig = dh.smile_dsig_dS({"T": T, "S": np.full(5, 100.0)}, -0.02)
        self.assertTrue((dsig[:2] < 0).all() and (dsig[2:] == 0).all())


class DeltaBands(unittest.TestCase):
    SCALARS = ("pnl", "hedge_pnl", "hedge_cost", "n_rebalances", *dh.ATTR, "delta_err_charm", "res1", "res2")

    @classmethod
    def setUpClass(cls):
        cls.fair = paths(300, 0.2, 0.2, seed=11)

    def assert_same(self, a, b):
        for k in self.SCALARS:
            self.assertEqual(a[k], b[k], k)
        for k in ("hedge", "cost", "delta_err", "delta_err_charm"):
            np.testing.assert_array_equal(a["bars"][k], b["bars"][k], k)

    def test_zero_band_is_the_clock_and_infinite_band_is_entry_only(self):
        p = self.fair[3]
        kw = dict(hedge_cost_bps=1.0, fills=(p["V"][0] - 0.02, p["V"][-1] + 0.03), r=0)
        for every in (1, 6):
            self.assert_same(dh.hedge_pnl(**p, rebalance_every=every, band=0.0, **kw),
                             dh.hedge_pnl(**p, rebalance_every=every, **kw))
        self.assert_same(dh.hedge_pnl(**p, rebalance_every=1, band=np.inf, **kw),
                         dh.hedge_pnl(**p, rebalance_every=dh.ENTRY_ONLY, **kw))
        self.assert_same(dh.hedge_pnl(**p, rebalance_every=1, ww_scale=0.0, **kw),
                         dh.hedge_pnl(**p, rebalance_every=1, **kw))
        dsig = np.full(len(p["S"]), -0.001)  # the smile target is banded the same way
        self.assert_same(dh.hedge_pnl(**p, rebalance_every=1, band=0.0, dsig_dS=dsig, **kw),
                         dh.hedge_pnl(**p, rebalance_every=1, dsig_dS=dsig, **kw))

    def test_band_holds_inside_and_resets_outside(self):
        p = self.fair[5]
        r = dh.hedge_pnl(**p, rebalance_every=1, band=3.0, hedge_cost_bps=1.0, r=0)
        b = r["bars"]
        tgt = b["hedge"] - b["delta_err"] / np.diff(p["S"])  # 100 * Delta from the attribution
        moved = np.r_[True, np.diff(b["hedge"]) != 0]
        np.testing.assert_allclose(b["hedge"][moved], tgt[moved], atol=1e-6)  # resets go to the target
        self.assertTrue((np.abs(b["hedge"] - tgt)[~moved] <= 3.0 + 1e-6).all())  # held only inside the band
        self.assertEqual(r["n_rebalances"], moved.sum())
        attributed = sum(r[k] for k in dh.ATTR) + r["res2"]
        self.assertAlmostEqual(attributed, r["option_pnl"] + r["hedge_pnl"], places=9)
        with self.assertRaises(ValueError):
            dh.hedge_pnl(**p, rebalance_every=1, band=1.0, ww_scale=1.0)
        with self.assertRaises(ValueError):
            dh.hedge_pnl(**p, rebalance_every=12, charm_adjust=True, band=1.0)

    def test_ww_band_formula(self):
        # c * (3/2 * kappa * S * (100 Gamma)^2)^(1/3) with kappa = 1 bp, S = 400, Gamma = 0.3
        self.assertAlmostEqual(float(dh.ww_band(400.0, 0.3, 1.0, 2.0)), 2 * (1.5e-4 * 400 * 900) ** (1 / 3))
        # the WW band widens with the cost (kappa^(1/3)); a fixed band does not
        self.assertAlmostEqual(float(dh.ww_band(400.0, 0.3, 8.0, 1.0) / dh.ww_band(400.0, 0.3, 1.0, 1.0)), 2.0)

    def test_band_cost_not_pathwise_monotone(self):
        # Neither cost nor trade count is monotone in the band on a single path: the wider band
        # keeps the stale entry hedge, so a later move crosses its edge while the narrower band had
        # already re-centred close enough to hold. Targets in shares, one check per bar.
        tgt = np.array([0.0, 2.1, 2.9, 0.3])
        h2, reb2 = dh.band_schedule(tgt, 2.0)
        h25, reb25 = dh.band_schedule(tgt, 2.5)
        np.testing.assert_array_equal(h2, [0.0, 2.1, 2.1, 2.1])
        np.testing.assert_array_equal(h25, [0.0, 0.0, 2.9, 0.3])
        self.assertLess(reb2.sum(), reb25.sum())  # 2 vs 3 resets incl. entry
        traded = lambda h: np.abs(np.diff(np.r_[0.0, h, 0.0])).sum()  # noqa: E731
        self.assertLess(traded(h2), traded(h25))  # 4.2 vs 5.8 shares incl. the unwind
        h, reb = dh.band_schedule(tgt, 0.0, every=2)  # checks on bars 0, 2 only
        np.testing.assert_array_equal(h, [0.0, 0.0, 2.9, 2.9])

    def test_mean_cost_and_trades_fall_with_band_width(self):
        # Monotone on AVERAGE over paths (not pathwise, see above), for fixed and WW bands.
        for key, grid in (("band", (0, 1, 2, 5, 10, 20, np.inf)), ("ww_scale", (0, 0.5, 1, 2, 4))):
            res = [run(self.fair, 1, hedge_cost_bps=1.0, **{key: b}) for b in grid]
            cost = [col(r, "hedge_cost").mean() for r in res]
            trades = [col(r, "n_rebalances").mean() for r in res]
            self.assertTrue(np.all(np.diff(cost) < 0), (key, cost))
            self.assertTrue(np.all(np.diff(trades) < 0), (key, trades))

    def test_bands_beat_clocks_at_matched_cost_on_gbm(self):
        # BS-marked 0DTE ATM straddle, realized = implied. A clock spends trades on bars where delta
        # barely moved and leaves large gaps unhedged until the next tick; a band trades exactly
        # when the mismatch is large, so at the same mean cost its P&L std is lower. Both families
        # sit below the interpolated clock frontier at every matched clock and at every band
        # inside the clock cost range (chord interpolation flatters bands a little, which is why
        # the clock grid is dense: 9 clocks from 5m to 120m).
        bands, scales = (2, 5, 10, 20, 30), (0.5, 1, 2, 4, 6)
        names = [*dh.FRONTIER_CLOCKS, *(f"band {b:g}" for b in bands), *(f"ww {c:g}" for c in scales)]
        kinds = ["clock"] * len(dh.FRONTIER_CLOCKS) + ["band"] * len(bands) + ["ww"] * len(scales)
        kws = [{"rebalance_every": e} for e in dh.FRONTIER_CLOCKS.values()]
        kws += [{"rebalance_every": 1, "band": b} for b in bands]
        kws += [{"rebalance_every": 1, "ww_scale": c} for c in scales]
        res = [[dh.hedge_pnl(**p, hedge_cost_bps=1.0, r=0, **kw) for kw in kws] for p in self.fair]
        pnl = np.array([[x["pnl"] for x in day] for day in res])
        cost = np.array([[x["hedge_cost"] for x in day] for day in res])
        gaps = dh.frontier_gaps(pnl, cost, names, kinds, match=("10m", "15m", "30m"))
        std_gaps = {k: v for k, v in gaps.items() if k.startswith("std|") and np.isfinite(v)}
        self.assertEqual(len(std_gaps), 10 + 6 + 3)  # every band in the clock range, 2 families + WW-band x 3 clocks
        self.assertTrue(all(v < 0 for k, v in std_gaps.items() if "ww-band" not in k), std_gaps)
        clock_sd = pnl[:, names.index("30m")].std(ddof=1)
        self.assertLess(gaps["std|band@30m"], -0.05 * clock_sd)  # >5% less std at the 30m clock's cost
        self.assertLess(gaps["std|ww@30m"], -0.05 * clock_sd)
        self.assertAlmostEqual(gaps["std|ww-band@30m"], gaps["std|ww@30m"] - gaps["std|band@30m"])


class FrontierStats(unittest.TestCase):
    def test_interp_frontier(self):
        cost, val = np.array([4.0, 1.0, 2.0]), np.array([1.0, 5.0, 3.0])  # unsorted on purpose
        np.testing.assert_allclose(dh.interp_frontier(cost, val, [np.sqrt(2.0), 2.0, 4.0]), [4.0, 3.0, 1.0])
        self.assertTrue(np.isnan(dh.interp_frontier(cost, val, [0.5, 5.0])).all())  # no extrapolation

    def test_frontier_gaps_hand_computed(self):
        # clocks at costs 1 and 4 with std 2 and 1 -> the clock frontier at cost 2 is 1.5
        rng = np.random.default_rng(0)
        z = rng.standard_normal(400)
        z = (z - z.mean()) / z.std(ddof=1)
        pnl = np.c_[2 * z, 1 * z, 1.2 * z, 9 * z]
        cost = np.tile([1.0, 4.0, 2.0, 1.0], (400, 1))
        g = dh.frontier_gaps(pnl, cost, ["a", "b", "band 1", "entry-only"], ["clock", "clock", "band", "clock"],
                             match=("a",))
        self.assertAlmostEqual(g["std|band 1"], 1.2 - 1.5)  # entry-only is not on the clock frontier
        self.assertTrue(np.isnan(g["std|band@a"]))  # a single band point spans no cost range

    def test_block_boot_idx(self):
        idx = dh.block_boot_idx(45, 7, 10, np.random.default_rng(1))
        self.assertEqual(idx.shape, (7, 45))
        self.assertTrue(((idx >= 0) & (idx < 45)).all())
        self.assertTrue((np.diff(idx[:, :10], axis=1) == 1).all())  # the first block is consecutive days


class TailStats(unittest.TestCase):
    def test_hand_computed(self):
        pnl = np.array([10.0, -30.0, 5.0, -20.0, 40.0] + [1.0] * 15)
        t = dh.tail_stats(pnl)
        self.assertEqual(t["worst"], -30.0)
        self.assertEqual(t["max_dd"], 45.0)  # peak 10 -> trough -35
        self.assertEqual(t["cvar5"], -30.0)  # 5% of 20 days = 1 day
        self.assertAlmostEqual(dh.tail_stats(np.r_[pnl, -25.0])["cvar5"], -27.5)  # ceil(1.05) = 2 days

    def test_skew_sign_and_no_drawdown(self):
        self.assertLess(dh.tail_stats(np.r_[np.ones(50), -40.0])["skew"], 0)
        self.assertEqual(dh.tail_stats(np.ones(10))["max_dd"], 0.0)


if __name__ == "__main__":
    unittest.main()
