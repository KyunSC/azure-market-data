"""Offline checks for orderflow_backtest on synthetic prints."""
import unittest

import numpy as np

import orderflow_backtest as ob

DATE = "2026-07-07"


def day_from(rows):
    """rows: (seconds after 09:30 ET, price, size, side)."""
    a = np.array(rows, float)
    open_ns = ob.pd.Timestamp(f"{DATE} 09:30", tz=ob.ET).value
    return ob.build_day(DATE, 1, (open_ns + a[:, 0] * 1e9).astype(np.int64), a[:, 1], a[:, 2],
                        a[:, 3].astype(np.int8))


def short_setup(after):
    """Rally 19980 -> 20000 into a 20000 LVN, an 80-lot buy bubble there at 09:40, a drop
    to 19985 held through 09:42, then the `after` rows (from 09:42:01)."""
    rows = [(s, 19980 + 20 * s / 600, 1, 1) for s in range(0, 600)]
    rows += [(600, 20000.0, 50, 1), (600, 20000.5, 30, 1)]  # one aggressor order, two prices
    rows += [(601 + k, 19985.0, 1, -1) for k in range(120)]
    rows += list(after)
    return day_from(rows)


STATICS = [("lvn", 20000.0), ("pdl", 19950.0)]


class OrderflowTests(unittest.TestCase):
    def test_aggregates_one_sweep(self):
        ts = np.array([1, 1, 1, 2, 2])
        start, end, size, lo, hi, side = ob.aggregate_orders(
            ts, np.array([10, 10.25, 10.5, 10.5, 10.5]), np.array([5, 5, 5, 1, 2.0]), np.array([1, 1, 1, 1, -1]))
        self.assertEqual(list(size), [15, 1, 2])
        self.assertEqual((lo[0], hi[0], list(side)), (10, 10.5, [1, 1, -1]))

    def test_lvn_between_two_nodes(self):
        px = np.r_[np.full(1000, 100.0), np.full(20, 150.0), np.full(1000, 200.0)]
        px = px + np.random.default_rng(0).normal(0, 8, len(px))
        lv = ob.low_volume_nodes(px, np.ones(len(px)))
        self.assertTrue(any(125 < x < 175 for x in lv), lv)

    def test_short_absorption_hits_target(self):
        day = short_setup([(721 + k, 19985 - k, 1, -1) for k in range(60)])
        (tr,) = ob.run_day(day, STATICS, ob.Params())
        self.assertEqual((tr["direction"], tr["level_kind"], tr["exit_reason"]), (-1, "lvn", "target"))
        self.assertEqual(tr["entry"], 19984.75)  # first print after the 09:41 minute closes below 20000, 1 tick worse
        self.assertEqual(tr["stop"], 20001.0)  # bubble high + 2 ticks
        self.assertEqual(tr["target"], 19950.0)
        self.assertAlmostEqual(tr["r"], (34.75 - ob.COMMISSION_PTS) / 16.25)

    def test_short_stopped_out(self):
        day = short_setup([(721 + k, 19985 + k, 1, 1) for k in range(30)])
        (tr,) = ob.run_day(day, STATICS, ob.Params())
        self.assertEqual(tr["exit_reason"], "stop")
        self.assertLess(tr["r"], -1)

    def test_with_flow_control_ignores_absorption(self):
        day = short_setup([(721 + k, 19985 - k, 1, -1) for k in range(60)])
        self.assertEqual(ob.run_day(day, STATICS, ob.Params(trigger="with_flow")), [])

    def test_bubble_too_small(self):
        day = short_setup([(721 + k, 19985 - k, 1, -1) for k in range(60)])
        self.assertEqual(ob.run_day(day, STATICS, ob.Params(bubble_size=100)), [])

    def test_skip_when_target_under_1r(self):
        day = short_setup([(721 + k, 19985 - k, 1, -1) for k in range(60)])
        self.assertEqual(ob.run_day(day, [("lvn", 20000.0), ("pdl", 19980.0)], ob.Params()), [])

    def test_prior_levels_dropped_on_roll(self):
        prev = ob.Session(instrument=2, high=1.0, low=0.0, lvns=[0.5])
        self.assertEqual(ob.static_levels(prev, short_setup([])), [])


if __name__ == "__main__":
    unittest.main()
