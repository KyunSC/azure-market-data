"""Tests for shared.sanitize.sanitize_bar.

Run with: cd functions && python -m unittest tests.test_sanitize
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from shared.sanitize import sanitize_bar, DEFAULT_THRESHOLD_PCT


class TestPhantomBarFromProduction(unittest.TestCase):
    """The real phantom bar we observed on the NQ chart at 06:36 UTC 2026-04-21.

    Close was 26848.5; prior bar's close was 26848. yfinance reported an open
    of 26748.75 — a ~100pt phantom that pushed the low to match. The previous
    bar's close agrees with this bar's close, so the open/low should both be
    clamped back toward close.
    """

    def test_phantom_open_and_low_are_clamped(self):
        row = {
            'open': 26748.75,
            'high': 26849.25,
            'low': 26748.75,
            'close': 26848.5,
        }
        result = sanitize_bar(row, prev_close=26848.0)
        self.assertAlmostEqual(result['open'], 26848.0)
        self.assertLessEqual(result['low'], result['close'])
        self.assertGreaterEqual(result['low'], 26848.0 - 1)
        self.assertEqual(result['high'], 26849.25)
        self.assertEqual(result['close'], 26848.5)

    def test_invariants_hold_after_clamp(self):
        row = {
            'open': 26748.75,
            'high': 26849.25,
            'low': 26748.75,
            'close': 26848.5,
        }
        result = sanitize_bar(row, prev_close=26848.0)
        self.assertLessEqual(result['low'], result['open'])
        self.assertLessEqual(result['low'], result['close'])
        self.assertGreaterEqual(result['high'], result['open'])
        self.assertGreaterEqual(result['high'], result['close'])


class TestLegitimateGapsArePreserved(unittest.TestCase):
    """If the bar really did move (open agrees with prev_close but disagrees
    with close), that's a legitimate directional bar — don't clamp it.
    """

    def test_gap_open_matching_prev_close_is_kept(self):
        # open/low deviate ~0.4% from close (over threshold), but prev_close
        # agrees with the open, so it's a real gap — do not clamp.
        row = {
            'open': 26000.0,
            'high': 26010.0,
            'low': 25890.0,
            'close': 25900.0,
        }
        result = sanitize_bar(row, prev_close=26000.0)
        self.assertEqual(result['open'], 26000.0)
        self.assertEqual(result['low'], 25890.0)
        self.assertEqual(result['high'], 26010.0)
        self.assertEqual(result['close'], 25900.0)

    def test_large_directional_move_without_prev_close_is_still_clamped(self):
        # Without prev_close as a second witness, we only have close to anchor
        # on. Large deviation from close gets clamped — this is the trade-off:
        # first-bar-after-restart with a big real move may be over-clamped.
        row = {
            'open': 26000.0,
            'high': 26010.0,
            'low': 25890.0,
            'close': 25900.0,
        }
        result = sanitize_bar(row, prev_close=None)
        self.assertEqual(result['open'], 25900.0)


class TestCleanBarsAreUnchanged(unittest.TestCase):
    def test_normal_bar_passthrough(self):
        row = {
            'open': 100.0,
            'high': 100.5,
            'low': 99.8,
            'close': 100.2,
        }
        result = sanitize_bar(row, prev_close=100.0)
        self.assertEqual(result['open'], 100.0)
        self.assertEqual(result['high'], 100.5)
        self.assertEqual(result['low'], 99.8)
        self.assertEqual(result['close'], 100.2)

    def test_extra_fields_preserved(self):
        row = {
            'open': 100.0,
            'high': 100.5,
            'low': 99.8,
            'close': 100.2,
            'volume': 12345,
            'date': 'something',
            'interval_type': '1m',
        }
        result = sanitize_bar(row)
        self.assertEqual(result['volume'], 12345)
        self.assertEqual(result['date'], 'something')
        self.assertEqual(result['interval_type'], '1m')

    def test_returns_a_copy_not_same_dict(self):
        row = {'open': 100.0, 'high': 100.5, 'low': 99.8, 'close': 100.2}
        result = sanitize_bar(row)
        self.assertIsNot(result, row)


class TestHighOutlier(unittest.TestCase):
    def test_phantom_high_is_clamped(self):
        row = {
            'open': 100.0,
            'high': 150.0,
            'low': 99.8,
            'close': 100.2,
        }
        result = sanitize_bar(row, prev_close=100.0)
        self.assertLessEqual(result['high'], 100.5)
        self.assertGreaterEqual(result['high'], result['close'])
        self.assertGreaterEqual(result['high'], result['open'])


class TestThresholdBoundary(unittest.TestCase):
    def test_deviation_just_under_threshold_is_kept(self):
        close = 1000.0
        # 0.25% deviation — under 0.3% default threshold
        row = {'open': close * (1 - 0.0025), 'high': close, 'low': close * (1 - 0.003), 'close': close}
        result = sanitize_bar(row)
        self.assertAlmostEqual(result['open'], close * (1 - 0.0025))

    def test_deviation_just_over_threshold_is_clamped(self):
        close = 1000.0
        # 0.5% deviation — over 0.3% default threshold, no prev_close witness
        row = {'open': close * (1 - 0.005), 'high': close, 'low': close * (1 - 0.005), 'close': close}
        result = sanitize_bar(row)
        self.assertEqual(result['open'], close)

    def test_custom_threshold(self):
        close = 1000.0
        # 0.5% deviation; raise threshold to 1% so it passes
        row = {'open': close * (1 - 0.005), 'high': close, 'low': close * (1 - 0.005), 'close': close}
        result = sanitize_bar(row, threshold_pct=0.01)
        self.assertAlmostEqual(result['open'], close * (1 - 0.005))

    def test_default_threshold_constant(self):
        self.assertEqual(DEFAULT_THRESHOLD_PCT, 0.003)


class TestDefensiveInputs(unittest.TestCase):
    def test_none_close_returns_row_unchanged(self):
        row = {'open': 100.0, 'high': 150.0, 'low': 50.0, 'close': None}
        result = sanitize_bar(row)
        self.assertIs(result, row)

    def test_zero_close_returns_row_unchanged(self):
        row = {'open': 100.0, 'high': 150.0, 'low': 50.0, 'close': 0}
        result = sanitize_bar(row)
        self.assertIs(result, row)

    def test_negative_close_returns_row_unchanged(self):
        row = {'open': 100.0, 'high': 150.0, 'low': 50.0, 'close': -5.0}
        result = sanitize_bar(row)
        self.assertIs(result, row)

    def test_non_numeric_close_returns_row_unchanged(self):
        row = {'open': 100.0, 'high': 150.0, 'low': 50.0, 'close': 'oops'}
        result = sanitize_bar(row)
        self.assertIs(result, row)

    def test_missing_close_returns_row_unchanged(self):
        row = {'open': 100.0, 'high': 150.0, 'low': 50.0}
        result = sanitize_bar(row)
        self.assertIs(result, row)


class TestInvariantsAlwaysHold(unittest.TestCase):
    """Post-sanitize, low ≤ {open, close} and high ≥ {open, close} must hold,
    even when the input already violated these invariants.
    """

    def test_input_violating_low_is_repaired(self):
        # Low is above open — impossible but sometimes happens in broken feeds
        row = {'open': 99.0, 'high': 101.0, 'low': 100.0, 'close': 100.5}
        result = sanitize_bar(row)
        self.assertLessEqual(result['low'], result['open'])
        self.assertLessEqual(result['low'], result['close'])

    def test_input_violating_high_is_repaired(self):
        row = {'open': 101.0, 'high': 100.0, 'low': 99.0, 'close': 100.5}
        result = sanitize_bar(row)
        self.assertGreaterEqual(result['high'], result['open'])
        self.assertGreaterEqual(result['high'], result['close'])


class TestRecentClosesWindow(unittest.TestCase):
    """The median-window witness fixes the consecutive-bad-bars failure mode.

    With single-prev_close, a phantom bar followed by another phantom bar
    slips through: bar N's prev_close is bar N-1's bad close, so the witness
    "agrees" with the new bad value and clears it. A median over a window
    ignores the one bad neighbor as long as the rest are clean.
    """

    def test_phantom_bar_following_phantom_bar_is_still_clamped(self):
        # Prior bar was bad — its close ended up at 26730 instead of ~26840.
        # Without the window, prev_close=26730 would whitelist this bar's
        # phantom low of 26730. With the window, the median of clean prior
        # bars (~26840) overrides the one bad neighbor.
        row = {
            'open': 26840.0,
            'high': 26845.0,
            'low': 26730.0,  # phantom — 0.4% below close
            'close': 26840.0,
        }
        clean_window = [26838.0, 26841.0, 26839.0, 26842.0, 26730.0]  # last is dirty
        result = sanitize_bar(row, prev_close=26730.0, recent_closes=clean_window)
        self.assertGreaterEqual(result['low'], 26840.0 - 1)
        self.assertLessEqual(result['low'], result['close'])

    def test_median_window_preserves_legitimate_move(self):
        # All recent closes agree the price moved to ~25900 territory; the
        # bar itself is a clean directional bar with open=prev high. The
        # window's median agrees with open, so don't clamp.
        row = {
            'open': 26000.0,
            'high': 26010.0,
            'low': 25890.0,
            'close': 25900.0,
        }
        # Half the window in the old level, half in the new — the move just
        # happened. Median of [26000, 26000, 25950, 25900, 25900] = 25950,
        # within 0.3% of close=25900, so close-anchor and window agree.
        result = sanitize_bar(row, recent_closes=[26000.0, 26000.0, 25950.0, 25900.0, 25900.0])
        self.assertEqual(result['open'], 26000.0)
        self.assertEqual(result['low'], 25890.0)

    def test_empty_window_falls_back_to_prev_close(self):
        row = {
            'open': 26748.75,
            'high': 26849.25,
            'low': 26748.75,
            'close': 26848.5,
        }
        result = sanitize_bar(row, prev_close=26848.0, recent_closes=[])
        self.assertAlmostEqual(result['open'], 26848.0)

    def test_window_with_only_invalid_values_falls_back_to_prev_close(self):
        row = {
            'open': 26748.75,
            'high': 26849.25,
            'low': 26748.75,
            'close': 26848.5,
        }
        result = sanitize_bar(row, prev_close=26848.0,
                              recent_closes=[None, 0, -5.0])
        self.assertAlmostEqual(result['open'], 26848.0)

    def test_window_alone_clamps_without_prev_close(self):
        row = {
            'open': 26748.75,
            'high': 26849.25,
            'low': 26748.75,
            'close': 26848.5,
        }
        result = sanitize_bar(row, prev_close=None,
                              recent_closes=[26848.0, 26849.0, 26847.5])
        self.assertAlmostEqual(result['open'], _approx_median([26848.0, 26849.0, 26847.5]))


def _approx_median(vals):
    s = sorted(vals)
    return s[len(s) // 2] if len(s) % 2 else (s[len(s)//2 - 1] + s[len(s)//2]) / 2


if __name__ == '__main__':
    unittest.main()
