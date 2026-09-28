"""Offline checks for greeks.py: every Greek against central finite differences, parity, guards."""
import unittest

import numpy as np

import greeks as gk
import thetadata_gex as g

RNG = np.random.default_rng(7)
N = 400
S = RNG.uniform(50, 800, N)
K = S * RNG.uniform(0.8, 1.2, N)
T = RNG.uniform(0.002, 1.5, N)
V = RNG.uniform(0.08, 0.9, N)
RIGHT = np.where(RNG.random(N) < 0.5, "C", "P")
R, Q = 0.05, 0.013


def fd(f, x, h):
    return (f(x + h) - f(x - h)) / (2 * h)


class FiniteDifferences(unittest.TestCase):
    def check(self, got, want, rtol=1e-4, atol=1e-7):
        np.testing.assert_allclose(got, want, rtol=rtol, atol=atol)

    def test_delta_gamma(self):
        h = S * 1e-4
        p = lambda s: gk.bs_price(s, K, T, V, RIGHT, R, Q)  # noqa: E731
        self.check(gk.delta(S, K, T, V, RIGHT, R, Q), fd(p, S, h))
        d = lambda s: gk.delta(s, K, T, V, RIGHT, R, Q)  # noqa: E731
        self.check(gk.gamma(S, K, T, V, R, Q), fd(d, S, h))

    def test_vega_volga_vanna(self):
        h = 1e-5
        p = lambda v: gk.bs_price(S, K, T, v, RIGHT, R, Q)  # noqa: E731
        self.check(gk.vega(S, K, T, V, R, Q), fd(p, V, h))
        vg = lambda v: gk.vega(S, K, T, v, R, Q)  # noqa: E731
        self.check(gk.volga(S, K, T, V, R, Q), fd(vg, V, h), atol=1e-5)
        d = lambda v: gk.delta(S, K, T, v, RIGHT, R, Q)  # noqa: E731
        self.check(gk.vanna(S, K, T, V, R, Q), fd(d, V, h), atol=1e-6)
        # vanna is also dVega/dS
        vs = lambda s: gk.vega(s, K, T, V, R, Q)  # noqa: E731
        self.check(gk.vanna(S, K, T, V, R, Q), fd(vs, S, S * 1e-4), atol=1e-6)

    def test_theta_charm_are_per_calendar_year(self):
        h = T * 1e-4
        p = lambda t: gk.bs_price(S, K, t, V, RIGHT, R, Q)  # noqa: E731
        self.check(gk.theta(S, K, T, V, RIGHT, R, Q), -fd(p, T, h), atol=1e-5)
        d = lambda t: gk.delta(S, K, t, V, RIGHT, R, Q)  # noqa: E731
        self.check(gk.charm(S, K, T, V, RIGHT, R, Q), -fd(d, T, h), atol=1e-5)

    def test_long_atm_theta_negative_without_carry(self):
        self.assertTrue((gk.theta(S, S, T, V, RIGHT, 0.0, 0.0) < 0).all())


class Parity(unittest.TestCase):
    def test_call_put_relations(self):
        c = dict(right="C")
        dc, dp = gk.delta(S, K, T, V, "C", R, Q), gk.delta(S, K, T, V, "P", R, Q)
        np.testing.assert_allclose(dc - dp, np.exp(-Q * T), rtol=1e-12)
        np.testing.assert_allclose(gk.delta(S, K, T, V, "CALL", 0.0, 0.0) - gk.delta(S, K, T, V, "put", 0.0, 0.0),
                                   1.0, rtol=1e-12)
        pc, pp = gk.bs_price(S, K, T, V, "C", R, Q), gk.bs_price(S, K, T, V, "P", R, Q)
        np.testing.assert_allclose(pc - pp, S * np.exp(-Q * T) - K * np.exp(-R * T), rtol=1e-9, atol=1e-9)
        cc, cp = gk.charm(S, K, T, V, "C", R, Q), gk.charm(S, K, T, V, "P", R, Q)
        np.testing.assert_allclose(cc - cp, Q * np.exp(-Q * T), rtol=1e-9, atol=1e-12)
        self.assertEqual(c["right"], "C")

    def test_boolean_mask_equals_labels(self):
        mask = RIGHT == "C"
        np.testing.assert_array_equal(gk.delta(S, K, T, V, mask), gk.delta(S, K, T, V, RIGHT))
        np.testing.assert_array_equal(gk.is_call(["CALL", "P", "c", "PUT"]), [True, False, True, False])

    def test_gamma_matches_research_gex(self):
        np.testing.assert_allclose(gk.gamma(S, K, T, V, R, 0.0), g.bs_gamma(S, K, T, R, V), rtol=1e-12)


class Guards(unittest.TestCase):
    def test_zero_where_input_nonpositive(self):
        bad = [(0.0, 100, 0.1, 0.2), (100, 0.0, 0.1, 0.2), (100, 100, 0.0, 0.2), (100, 100, -1, 0.2),
               (100, 100, 0.1, 0.0), (-5, 100, 0.1, 0.2)]
        for s, k, t, v in bad:
            for f in (gk.bs_price, gk.delta, gk.theta, gk.charm):
                self.assertEqual(float(f(s, k, t, v, "C")), 0.0, (f.__name__, s, k, t, v))
            for f in (gk.gamma, gk.vega, gk.vanna, gk.volga):
                self.assertEqual(float(f(s, k, t, v)), 0.0, (f.__name__, s, k, t, v))

    def test_scalar_in_scalar_out_and_broadcast(self):
        self.assertIsInstance(float(gk.gamma(100.0, 100.0, 0.1, 0.2)), float)
        out = gk.delta(100.0, np.array([90.0, 100.0, 110.0]), 0.1, 0.2, "C")
        self.assertEqual(out.shape, (3,))
        self.assertTrue(np.all(np.diff(out) < 0))


if __name__ == "__main__":
    unittest.main()
