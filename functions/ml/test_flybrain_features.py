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

    def test_gex_columns_are_distinct(self):
        from flybrain.features import GEX_FEATURES
        from build_dataset import compute_gex_features
        from gex_vol_study import dealer_features
        rng=np.random.default_rng(3)
        df=pd.DataFrame({c:rng.normal(size=100) for c in
            ('close','spot','zero_gamma','call_wall','put_wall','net_gex','net_gex_0dte_raw',
             'net_vex','net_cex','net_vex_0dte','net_cex_0dte')})
        df['atr_14']=rng.uniform(.1,2,100); df['abs_gex_total']=rng.uniform(1,10,100)
        df=compute_gex_features(df)
        for c,v in dealer_features(df).items(): df[c]=v
        for i,c in enumerate(GEX_FEATURES):
            for other in GEX_FEATURES[i+1:]:
                self.assertFalse(np.array_equal(df[c],df[other]),(c,other))

    def test_session_split(self):
        df = pd.DataFrame({'session': np.repeat(np.arange(10), 4)})
        a, b = split_discovery_holdout(df)
        self.assertFalse(set(a.session) & set(b.session))
        self.assertEqual(len(a) + len(b), len(df))
        self.assertEqual(a.session.nunique(), 7)

if __name__ == '__main__': unittest.main()
