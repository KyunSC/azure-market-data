"""Offline checks for the historical GEX rebuild and the Databento bar loader."""
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pandas as pd

import build_dataset as bd
import greeks
import thetadata_gex as g
from gex_calculator import MIN_T_YEARS, RISK_FREE_RATE, _identify_key_levels, black_scholes_gamma

DAY = date(2026, 9, 25)


def chain(rows):
    return pd.DataFrame(rows, columns=["expiration", "strike", "right", "implied_vol", "open_interest"])


class Gamma(unittest.TestCase):
    def test_matches_live_scalar(self):
        rng = np.random.default_rng(1)
        K, T, v = rng.uniform(1, 900, 500), rng.uniform(-0.01, 0.2, 500), rng.uniform(-0.1, 1.5, 500)
        ref = [black_scholes_gamma(500.0, k, t, RISK_FREE_RATE, s) for k, t, s in zip(K, T, v)]
        np.testing.assert_allclose(g.bs_gamma(500.0, K, T, RISK_FREE_RATE, v), ref, rtol=1e-12, atol=0)


class Snapshot(unittest.TestCase):
    def test_matches_live_levels_and_sql_aggregates(self):
        c = chain([("2026-09-25", 740.0, "C", 0.20, 1000), ("2026-09-25", 750.0, "C", 0.20, 5000),
                   ("2026-09-25", 730.0, "P", 0.25, 4000), ("2026-09-28", 745.0, "P", 0.22, 800),
                   ("2026-09-28", 760.0, "C", 0.18, 300)])
        s = g.snapshot(c, 743.6, DAY)
        # Recompute the live way: per-contract loop, per-strike sum, then _identify_key_levels.
        per = {}
        for e, k, r, iv, oi in c.itertuples(index=False):
            days = (pd.Timestamp(e) - pd.Timestamp(DAY)).days
            gm = black_scholes_gamma(743.6, k, max(days / 365, MIN_T_YEARS), RISK_FREE_RATE, iv)
            per[k] = per.get(k, 0.0) + gm * oi * 100 * 743.6 * (1 if r == "C" else -1)
        levels = _identify_key_levels([{"strike_etf": k, "strike_futures": k, "gex": round(v, 2)}
                                       for k, v in sorted(per.items())], 743.6)
        lv = {x["label"]: x for x in levels}
        self.assertEqual((s["call_wall"], s["put_wall"]), (lv["call_wall"]["strike_etf"], lv["put_wall"]["strike_etf"]))
        self.assertAlmostEqual(s["zero_gamma"], lv["zero_gamma"]["strike_etf"])
        gs = np.array([x["gex"] for x in levels])
        self.assertAlmostEqual(s["net_gex"], gs.sum(), places=2)
        self.assertAlmostEqual(s["abs_gex_total"], np.abs(gs).sum(), places=2)

    def test_only_four_nearest_expirations_within_30_days(self):
        exps = ["2026-09-24", "2026-09-25", "2026-09-26", "2026-09-28", "2026-09-29", "2026-09-30", "2026-11-20"]
        c = chain([(e, 700.0 + 10 * i, "C", 0.2, 100) for i, e in enumerate(exps)])
        s = g.snapshot(c, 740.0, DAY)
        with patch.object(g, "_identify_key_levels", wraps=_identify_key_levels) as spy:
            g.snapshot(c, 740.0, DAY)
        strikes = {x["strike_etf"] for x in spy.call_args.args[0]}
        self.assertEqual(strikes, {710.0, 720.0, 730.0, 740.0})  # expired and 5th+/far-dated dropped
        self.assertIn(s["call_wall"], strikes)

    def test_skips_zero_oi_and_low_iv(self):
        c = chain([("2026-09-25", 740.0, "C", 0.005, 100), ("2026-09-25", 750.0, "C", 0.2, 0)])
        self.assertIsNone(g.snapshot(c, 740.0, DAY))


class VannaCharm(unittest.TestCase):
    C = chain([("2026-09-25", 740.0, "C", 0.20, 1000), ("2026-09-25", 750.0, "C", 0.20, 5000),
               ("2026-09-25", 730.0, "P", 0.25, 4000), ("2026-09-28", 745.0, "P", 0.22, 800),
               ("2026-09-28", 760.0, "C", 0.18, 300), ("2026-10-02", 700.0, "P", 0.30, 2500)])

    @staticmethod
    def manual(c, spot, same_day_only=False):
        vex = cex = 0.0
        for e, k, r, iv, oi in c.itertuples(index=False):
            days = (pd.Timestamp(e) - pd.Timestamp(DAY)).days
            if same_day_only and days > 0:
                continue
            T, sign = max(days / 365, MIN_T_YEARS), (1 if r == "C" else -1)
            vex += float(greeks.vanna(spot, k, T, iv)) * oi * 100 * spot * sign
            cex += float(greeks.charm(spot, k, T, iv, r)) * oi * 100 * sign
        return vex, cex

    def test_whole_chain_matches_manual_loop(self):
        s = g.snapshot(self.C, 743.6, DAY)
        vex, cex = self.manual(self.C, 743.6)
        self.assertAlmostEqual(s["net_vex"], vex, delta=1e-9 * abs(vex))
        self.assertAlmostEqual(s["net_cex"], cex, delta=1e-9 * abs(cex))
        # Dealer long OTM calls (vanna > 0) and short OTM puts (vanna < 0, negated): both add positive VEX.
        self.assertGreater(s["net_vex"], 0)
        self.assertLess(s["net_cex"], 0)  # OTM call deltas and short-put deltas decay toward 0

    def test_otm_calls_positive_vex(self):
        c = chain([("2026-09-28", k, "C", 0.2, 500) for k in (750.0, 760.0, 780.0)])
        s = g.snapshot(c, 740.0, DAY)
        self.assertGreater(s["net_vex"], 0)
        self.assertLess(s["net_cex"], 0)

    def test_0dte_split_sums_same_day_only(self):
        s = g.snapshot(self.C, 743.6, DAY)
        vex0, cex0 = self.manual(self.C, 743.6, same_day_only=True)
        self.assertAlmostEqual(s["net_vex_0dte"], vex0, delta=1e-9 * abs(vex0))
        self.assertAlmostEqual(s["net_cex_0dte"], cex0, delta=1e-9 * abs(cex0))
        self.assertNotAlmostEqual(s["net_vex_0dte"], s["net_vex"], delta=1.0)
        s0 = g.snapshot(self.C, 743.6, DAY, expiries="0dte")
        self.assertAlmostEqual(s0["net_vex"], vex0, delta=1e-9 * abs(vex0))
        self.assertEqual(s0["net_vex_0dte"], s0["net_vex"])

    def test_columns_appended(self):
        self.assertEqual(g.COLUMNS[-4:], ["net_vex", "net_cex", "net_vex_0dte", "net_cex_0dte"])
        self.assertLessEqual(set(g.COLUMNS) - {"computed_at"}, set(g.snapshot(self.C, 743.6, DAY)))


class Bars(unittest.TestCase):
    def test_rth_5min_bars_stamped_at_start(self):
        idx = pd.date_range("2024-06-10 13:25", "2024-06-10 20:05", freq="1min", tz="UTC")  # 09:25-16:05 EDT
        m = pd.DataFrame({"open": np.arange(len(idx), dtype=float), "high": np.arange(len(idx)) + 1.0,
                          "low": np.arange(len(idx)) - 1.0, "close": np.arange(len(idx)) + 0.5,
                          "volume": np.ones(len(idx), dtype=np.uint64)}, index=idx.rename("ts_event"))
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "QQQ").mkdir()
            m.to_parquet(Path(tmp) / "QQQ" / "2024-06-01_2024-07-01.parquet")
            with patch.object(bd, "DATABENTO_BARS_DIR", Path(tmp)):
                bars = bd.load_databento_bars("QQQ")
        self.assertEqual(len(bars), 78)
        self.assertEqual(str(bars.date.iloc[0]), "2024-06-10 13:30:00+00:00")
        self.assertEqual(str(bars.date.iloc[-1]), "2024-06-10 19:55:00+00:00")
        first = m.loc["2024-06-10 13:30":"2024-06-10 13:34"]
        row = bars.iloc[0]
        self.assertEqual((row.open, row.close, row.volume), (first.open.iloc[0], first.close.iloc[-1], 5.0))
        self.assertEqual((row.high, row.low), (first.high.max(), first.low.min()))


class Finish(unittest.TestCase):
    def test_features_from_level_aggregates(self):
        raw = pd.DataFrame([{"computed_at": "2026-09-25 13:35:00+00:00", "call_wall": 750.0, "put_wall": 730.0,
                             "zero_gamma": 749.2, "call_wall_gex": 60.0, "put_wall_gex": -40.0,
                             "call_wall_0dte_gex": 30.0, "put_wall_0dte_gex": -10.0, "net_gex": 20.0,
                             "abs_gex_total": 100.0, "sum_gex_squared": 5200.0,
                             "net_gex_0dte_raw": 20.0, "abs_gex_0dte_total": 40.0}])
        f = bd.finish_gex_snapshots(raw).iloc[0]
        self.assertAlmostEqual(f.call_wall_strength, 0.6)
        self.assertAlmostEqual(f.put_wall_strength, 0.4)
        self.assertAlmostEqual(f.gex_concentration, 0.52)
        self.assertTrue(np.isnan(f.pcr_volume))

    RAW = {"computed_at": "2026-09-25 13:35:00+00:00", "call_wall": 750.0, "put_wall": 730.0,
           "zero_gamma": 749.2, "call_wall_gex": 60.0, "put_wall_gex": -40.0, "call_wall_0dte_gex": 30.0,
           "put_wall_0dte_gex": -10.0, "net_gex": 20.0, "abs_gex_total": 100.0, "sum_gex_squared": 5200.0,
           "net_gex_0dte_raw": 20.0, "abs_gex_0dte_total": 40.0}

    @staticmethod
    def features(gex):
        bars = pd.DataFrame({"date": pd.to_datetime(["2026-09-25 13:40:00+00:00"]), "close": [745.0],
                             "atr_14": [2.0]})
        return bd.compute_gex_features(bd.asof_join_gex(bars, gex)).iloc[0]

    def test_vex_cex_signed_log(self):
        raw = pd.DataFrame([{**self.RAW, "net_vex": -1e9, "net_cex": "2.5e6", "net_vex_0dte": 0.0,
                             "net_cex_0dte": None}])
        f = self.features(bd.finish_gex_snapshots(raw))
        self.assertAlmostEqual(f.vex_signed_log, -np.log1p(1e9))
        self.assertAlmostEqual(f.cex_signed_log, np.log1p(2.5e6))
        self.assertEqual(f.vex_0dte_signed_log, 0.0)
        self.assertTrue(np.isnan(f.cex_0dte_signed_log))

    def test_old_sources_without_vex_cex_give_nan(self):
        f = self.features(bd.finish_gex_snapshots(pd.DataFrame([self.RAW])))  # old parquet / REST rows
        self.assertTrue(all(np.isnan(f[c]) for c in bd.FEATURE_COLS_VEX_CEX))
        self.assertAlmostEqual(f.gamma_regime_strength, 0.2)
        sql = pd.DataFrame([{"computed_at": pd.Timestamp("2026-09-25 13:35", tz="UTC"), "call_wall": 750.0,
                             "put_wall": 730.0, "zero_gamma": 749.2, "net_gex": 20.0, "abs_gex_total": 100.0}])
        f = self.features(sql)  # fetch_gex_snapshots (SQL) skips finish_gex_snapshots entirely
        self.assertTrue(all(np.isnan(f[c]) for c in bd.FEATURE_COLS_VEX_CEX))


if __name__ == "__main__":
    unittest.main()
