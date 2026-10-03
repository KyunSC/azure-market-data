"""Offline checks for gex_vol_study on synthetic bars, snapshots and regressions."""
import unittest
from datetime import date, timedelta

import numpy as np
import pandas as pd

import gex_vol_study as gv
from holdout import split_holdout


def sessions(n, start=date(2024, 1, 2)):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def make_bars(days, n_bars=78, vol=1e-3, seed=0):
    """5-min RTH bars stamped at their start (UTC), GBM closes, opens near the prior close."""
    rng = np.random.default_rng(seed)
    rows, px = [], 100.0
    for d in days:
        t0 = pd.Timestamp(f"{d} 09:30", tz=gv.ET)
        px *= np.exp(0.01 * rng.standard_normal())  # overnight gap
        for k in range(n_bars):
            o = px * np.exp(1e-5 * rng.standard_normal())
            px = o * np.exp(vol * rng.standard_normal())
            rows.append({"date": (t0 + k * gv.BAR).tz_convert("UTC"), "open": o, "high": max(o, px),
                         "low": min(o, px), "close": px, "volume": 1000.0, "session": d})
    b = pd.DataFrame(rows)
    b["date"] = b["date"].astype("datetime64[ns, UTC]")
    return b


def ts(d, hhmm):
    return pd.Timestamp(f"{d} {hhmm}", tz=gv.ET).tz_convert("UTC")


class TestTargets(unittest.TestCase):
    def setUp(self):
        self.days = sessions(8)
        self.bars = make_bars(self.days)
        self.t = pd.Series([ts(self.days[6], "11:00")])

    def test_target_matches_hand_computation(self):
        b = self.bars
        i = int(np.flatnonzero(b["date"] == self.t[0])[0])
        r = [np.log(b["close"][i] / b["open"][i])] + [np.log(b["close"][k] / b["close"][k - 1]) for k in range(i + 1, i + 6)]
        y, tt = gv.forward_log_rv(b, self.t, 6)
        self.assertAlmostEqual(y[0], np.log(np.mean(np.square(r))), places=12)
        self.assertEqual(tt[0], self.t[0] + 6 * gv.BAR)

    def test_prices_at_or_before_t_do_not_move_target(self):
        b = self.bars.copy()
        before = b["date"] < self.t[0]  # every bar that ends by t, including the one closing at t
        for h in gv.HORIZONS.values():
            y0, _ = gv.forward_log_rv(b, self.t, h)
            p = b.copy()
            p.loc[before, ["open", "high", "low", "close"]] *= np.exp(np.random.default_rng(1).normal(0, .05, before.sum()))[:, None]
            y1, _ = gv.forward_log_rv(p, self.t, h)
            self.assertAlmostEqual(y0[0], y1[0], places=8)  # equal up to cumsum rounding
        # and prices after t do move it (the check above is not vacuous)
        p = b.copy()
        p.loc[b["date"] == self.t[0] + gv.BAR, "close"] *= 1.01
        self.assertNotEqual(gv.forward_log_rv(p, self.t, 6)[0][0], gv.forward_log_rv(b, self.t, 6)[0][0])

    def test_prices_after_t_do_not_move_features(self):
        b = self.bars
        f0 = gv.lagged_log_rv(b, self.t)
        p = b.copy()
        after = b["date"] >= self.t[0]
        p.loc[after, ["open", "high", "low", "close"]] *= 1.3
        pd.testing.assert_frame_equal(f0, gv.lagged_log_rv(p, self.t))
        # the bar closing at t is used (the last 30 min end at t)
        p = b.copy()
        p.loc[b["date"] == self.t[0] - gv.BAR, "close"] *= 1.01
        self.assertNotEqual(gv.lagged_log_rv(p, self.t).iloc[0, 0], f0.iloc[0, 0])

    def test_leverage_returns_use_bars_ending_by_t(self):
        b = self.bars
        f0 = gv.lagged_returns(b, self.t)
        i = int(np.flatnonzero(b["date"] == self.t[0])[0])
        self.assertAlmostEqual(f0["ret_30m"][0], np.log(b["close"][i - 1] / b["close"][i - 7]))
        self.assertAlmostEqual(f0["ret_1d"][0], np.log(b["close"][i - 1] / b["close"][i - 79]))
        self.assertEqual(f0["neg_ret_5d"][0], min(f0["ret_5d"][0], 0.0))
        p = b.copy()
        p.loc[b["date"] >= self.t[0], ["open", "high", "low", "close"]] *= 1.3
        pd.testing.assert_frame_equal(f0, gv.lagged_returns(p, self.t))
        early = gv.lagged_returns(b, pd.Series([ts(self.days[2], "10:00")]))  # < 390 bars of history
        self.assertTrue(np.isnan(early["ret_5d"][0]) and np.isfinite(early["ret_1d"][0]))

    def test_session_edges(self):
        d = self.days[3]
        times = pd.Series([ts(d, "15:30"), ts(d, "15:35"), ts(d, "15:00"), ts(d, "15:05"),
                           ts(d, "15:55"), ts(d, "16:00")])
        y30, _ = gv.forward_log_rv(self.bars, times, 6)
        y60, _ = gv.forward_log_rv(self.bars, times, 12)
        yr, tr = gv.forward_log_rv(self.bars, times, 0)
        np.testing.assert_array_equal(np.isfinite(y30), [True, False, True, True, False, False])
        np.testing.assert_array_equal(np.isfinite(y60), [False, False, True, False, False, False])
        np.testing.assert_array_equal(np.isfinite(yr), [True, True, True, True, True, False])
        self.assertTrue((tr[:5] == ts(d, "16:00")).all())  # rest-of-session ends at the close, never later
        # 15:55 rest-of-session = the single bar's own open -> close
        b = self.bars[self.bars["date"] == ts(d, "15:55")].iloc[0]
        self.assertAlmostEqual(yr[4], np.log(np.log(b["close"] / b["open"]) ** 2), places=10)

    def test_gap_inside_window_drops_target(self):
        b = self.bars[self.bars["date"] != ts(self.days[2], "11:10")].reset_index(drop=True)
        y, _ = gv.forward_log_rv(b, pd.Series([ts(self.days[2], "11:00"), ts(self.days[2], "11:15")]), 6)
        self.assertTrue(np.isnan(y[0]) and np.isfinite(y[1]))

    def test_half_day_rest_of_session(self):
        days = sessions(3)
        full, half = make_bars(days[:2]), make_bars(days[2:], n_bars=42, seed=3)  # 13:00 close
        b = pd.concat([full, half], ignore_index=True)
        y, tt = gv.forward_log_rv(b, pd.Series([ts(days[2], "12:30")]), 0)
        self.assertTrue(np.isfinite(y[0]))
        self.assertEqual(tt[0], ts(days[2], "13:00"))

    def test_zero_rv_is_floored(self):
        b = self.bars.copy()
        win = (b["date"] >= self.t[0]) & (b["date"] < self.t[0] + 6 * gv.BAR)
        b.loc[win | (b["date"] == self.t[0] - gv.BAR), ["open", "close"]] = 100.0
        y, _ = gv.forward_log_rv(b, self.t, 6)
        self.assertEqual(y[0], np.log(gv.EPS_VAR))

    def test_overnight_gap_not_in_lagged_rv(self):
        d = self.days[4]
        t = pd.Series([ts(d, "09:45")])  # last 6 bars: 4 from yesterday's close, 2 today
        f0 = gv.lagged_log_rv(self.bars, t)
        b = self.bars.copy()
        today = b["session"] == d
        b.loc[today, ["open", "high", "low", "close"]] *= 1.2  # a 20% gap at the open
        pd.testing.assert_frame_equal(f0, gv.lagged_log_rv(b, t))


class TestOptionFeatures(unittest.TestCase):
    def test_atm_iv_picks_front_and_0dte(self):
        day = date(2024, 3, 6)
        rows = []
        for exp, base in (("2024-03-06", 0.30), ("2024-03-07", 0.20), ("2024-03-08", 0.10)):
            for k in (99.0, 100.0, 101.0):
                for right in ("C", "P"):
                    rows.append({"expiration": exp, "strike": k, "right": right,
                                 "implied_vol": base + (0.01 if right == "C" else 0) + abs(k - 100) * 0.1,
                                 "midpoint": 1.0})
        chain = pd.DataFrame(rows)
        front, zero = gv.atm_iv(chain, 100.2, day)
        self.assertAlmostEqual(front, 0.205)
        self.assertAlmostEqual(zero, 0.305)
        front, zero = gv.atm_iv(chain[chain["expiration"] != "2024-03-06"], 100.2, day)
        self.assertTrue(np.isnan(zero))
        # an unquoted strike is skipped: nearest valid strike wins
        c = chain.copy()
        c.loc[(c["expiration"] == "2024-03-07") & (c["strike"] == 100.0), "midpoint"] = 0.0
        self.assertAlmostEqual(gv.atm_iv(c, 100.2, day)[0], 0.305)

    def test_dealer_features(self):
        s = pd.DataFrame({"spot": [100.0, 100.0], "zero_gamma": [98.0, np.nan], "net_gex": [5e9, -1e9],
                          "abs_gex_total": [1e10, 2e9], "net_gex_0dte_raw": [0.0, np.nan],
                          "net_vex": [1e6, -1e6], "net_cex": [0.0, 1.0], "net_vex_0dte": [0.0, 0.0],
                          "net_cex_0dte": [0.0, 0.0]})
        f = gv.dealer_features(s)
        np.testing.assert_allclose(f["gex_regime"], [0.5, -0.5])
        np.testing.assert_allclose(f["above_zero_gamma"], [1.0, 0.0])
        np.testing.assert_allclose(f["zero_gamma_dist"], [0.02, 0.0])
        np.testing.assert_allclose(f["vex_slog"], [np.log1p(1e6), -np.log1p(1e6)])
        self.assertFalse(f.isna().any().any())


class TestHoldout(unittest.TestCase):
    def test_research_sessions_match_split_holdout(self):
        days = sessions(60, start=date(2026, 7, 1))
        df = pd.DataFrame({"date": [ts(d, "10:00") for d in days]})
        research, _ = split_holdout(df, verify_start=pd.Timestamp("2026-08-24", tz=gv.ET), gap_sessions=5)
        want = sorted(pd.to_datetime(research["date"]).dt.tz_convert(gv.ET).dt.date)
        self.assertEqual(gv.research_sessions(days, pd.Timestamp("2026-08-24", tz=gv.ET), 5), want)
        self.assertLess(want[-1], date(2026, 8, 17))


class TestEstimation(unittest.TestCase):
    @staticmethod
    def panel(n_days=120, per_day=40, beta_g=0.0, seed=0):
        """y = log-RV-like: persistent daily level + control + optional dealer effect + AR noise."""
        rng = np.random.default_rng(seed)
        days = sessions(n_days)
        rows = []
        level = 0.0
        for d in days:
            level = 0.9 * level + 0.3 * rng.standard_normal()
            g_day = rng.standard_normal()
            e = 0.0
            for k in range(per_day):
                t = ts(d, "09:35") + k * gv.BAR
                ctrl = level + 0.2 * rng.standard_normal()
                g = g_day + 0.3 * rng.standard_normal()
                e = 0.7 * e + rng.standard_normal() * 0.5
                rows.append({"date": t, "target_time": t + gv.BAR, "c": ctrl, "g": g,
                             "y": -14 + 1.0 * ctrl + beta_g * g + e})
        return pd.DataFrame(rows).astype({"date": "datetime64[ns, UTC]", "target_time": "datetime64[ns, UTC]"})

    def fit(self, df):
        folds = gv.session_folds(df, n_splits=5, embargo_sessions=1)
        te = np.concatenate([t for _, t in folds])
        y, Xc, Xg = df["y"].to_numpy(), df[["c"]].to_numpy(), df[["g"]].to_numpy()
        pb, pc = gv.bench_predict(y, folds), gv.oos_predict(Xc, y, folds)
        pf = gv.oos_predict(np.hstack([Xc, Xg]), y, folds)
        return gv.oos_r2(y[te], pc, pb), gv.oos_r2(y[te], pf, pb), (te, y[te], pc, pf, pb)

    def test_noise_dealer_block_adds_nothing(self):
        df = self.panel(beta_g=0.0)
        r2c, r2f, _ = self.fit(df)
        self.assertGreater(r2c, 0.3)
        self.assertLess(abs(r2f - r2c), 0.005)

    def test_planted_effect_is_recovered(self):
        df = self.panel(beta_g=-0.4, seed=1)
        r2c, r2f, (te, y, pc, pf, pb) = self.fit(df)
        self.assertGreater(r2f - r2c, 0.05)
        sid = gv.session_ids(df["date"])
        bs = gv.block_bootstrap_r2(sid[te], y, pc, pf, pb, n=300)
        self.assertGreater(np.percentile(bs[:, 2], 2.5), 0)
        ins = gv.hac_standardized(df[["c", "g"]].to_numpy(), df["y"].to_numpy(), 40, ["c", "g"], ["g"])
        self.assertLess(ins["coefs"]["g"]["hi"], 0)  # sign recovered, CI excludes 0
        raw = gv.ols(df[["c", "g"]].to_numpy(), df["y"].to_numpy())
        self.assertAlmostEqual(raw[2], -0.4, delta=0.05)  # magnitude recovered
        self.assertLess(ins["wald_p"], 1e-6)

    def test_session_shift_null(self):
        df = self.panel(beta_g=-0.4, seed=2)
        sid = gv.session_ids(df["date"])
        start = np.searchsorted(sid, np.arange(sid.max() + 1))
        Xg = df[["g"]].to_numpy()
        np.testing.assert_array_equal(gv.shift_block(Xg, start, 0), Xg)
        shifted = df.assign(g=gv.shift_block(Xg, start, 10)[:, 0])
        r2c, r2f, _ = self.fit(shifted)
        self.assertLess(r2f - r2c, 0.01)  # a misaligned planted effect is gone
        self.assertTrue(np.array_equal(np.sort(shifted["g"]), np.sort(df["g"])))

    def test_analyze_end_to_end_on_noise(self):
        rng = np.random.default_rng(5)
        days = sessions(90)
        bars = make_bars(days, seed=5)
        t = pd.Series([ts(d, "09:35") + k * gv.BAR for d in days for k in range(78)])
        n = len(t)
        snaps = pd.DataFrame({"computed_at": t, "spot": 100.0, "zero_gamma": 99.0 + rng.standard_normal(n),
                              "net_gex": rng.normal(0, 1e9, n), "abs_gex_total": 2e9,
                              "net_gex_0dte_raw": rng.normal(0, 1e8, n), "net_vex": rng.normal(0, 1e6, n),
                              "net_cex": rng.normal(0, 1e6, n), "net_vex_0dte": rng.normal(0, 1e5, n),
                              "net_cex_0dte": rng.normal(0, 1e5, n)})
        iv = pd.DataFrame({"computed_at": t, "iv_front": np.exp(rng.normal(-1.6, .1, n)),
                           "iv_0dte": np.nan, "is_0dte_day": 0.0})
        df = gv.build_frame(bars, snaps, iv)
        res = gv.analyze(df, "30m", perms=19, boot=100, n_splits=5)
        self.assertLess(abs(res["dr2"]), 0.01)
        self.assertGreater(res["p_perm"], 0.05)
        self.assertEqual(res["n_days"], 85)  # the first 5 sessions lack the weekly HAR lag
        self.assertTrue(set(gv.DEALER) <= set(res["in_sample"]["coefs"]))


class TestNeweyWest(unittest.TestCase):
    def test_lag0_is_white_and_iid_matches_classical(self):
        rng = np.random.default_rng(0)
        n = 20000
        X = np.column_stack([np.ones(n), rng.standard_normal(n)])
        u = rng.standard_normal(n)
        white = np.linalg.inv(X.T @ X) @ (X.T * u ** 2) @ X @ np.linalg.inv(X.T @ X)
        np.testing.assert_allclose(gv.newey_west(X, u, 0), white)
        classical = np.var(u) * np.linalg.inv(X.T @ X)
        ratio = np.sqrt(np.diag(gv.newey_west(X, u, 20)) / np.diag(classical))
        np.testing.assert_allclose(ratio, 1.0, atol=0.08)

    def test_positive_autocorrelation_widens_errors(self):
        rng = np.random.default_rng(1)
        n = 20000
        x = np.convolve(rng.standard_normal(n + 11), np.ones(12), "valid")  # persistent regressor
        u = np.convolve(rng.standard_normal(n + 11), np.ones(12), "valid")  # MA(11) errors
        X = np.column_stack([np.ones(n), x])
        se0 = np.sqrt(gv.newey_west(X, u, 0)[1, 1])
        se_hac = np.sqrt(gv.newey_west(X, u, 24)[1, 1])
        # true inflation sqrt(1 + 2 sum_l rho_x(l) rho_u(l)) = sqrt(8.03) = 2.83; Bartlett shrinks it a bit
        self.assertGreater(se_hac / se0, 2.3)


if __name__ == "__main__":
    unittest.main()
