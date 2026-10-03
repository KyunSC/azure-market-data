import unittest
import numpy as np
import pandas as pd
from flybrain.features import normalize_sessions, split_discovery_holdout

class FeatureTests(unittest.TestCase):
    def test_causal_normalization(self):
        df = pd.DataFrame({'session': np.repeat(np.arange(25), 4), 'x': np.arange(100, dtype=float)})
        a = normalize_sessions(df, ['x'])
        df.loc[df.session > 22, 'x'] *= -1000
        b = normalize_sessions(df, ['x'])
        np.testing.assert_array_equal(a.loc[a.session <= 22, 'z_x'], b.loc[b.session <= 22, 'z_x'])
        self.assertEqual(a.session.min(), 20)
        self.assertLessEqual(abs(a.z_x).max(), 5)

    def test_session_split(self):
        df = pd.DataFrame({'session': np.repeat(np.arange(10), 4)})
        a, b = split_discovery_holdout(df)
        self.assertFalse(set(a.session) & set(b.session))
        self.assertEqual(len(a) + len(b), len(df))
        self.assertEqual(a.session.nunique(), 7)

if __name__ == '__main__': unittest.main()
