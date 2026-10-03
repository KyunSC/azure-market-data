import unittest
import numpy as np
import pandas as pd
from scipy import sparse
from flybrain import config
from flybrain.connectome import *

class ConnectomeTests(unittest.TestCase):
    def fixture(self):
        rng = np.random.default_rng(13)
        ids = np.arange(30)
        neurons = pd.DataFrame({'root_id': ids, 'top_nt': [list(SIGNS)[i % 6] for i in ids]})
        pre = np.repeat(ids, 6)
        post = np.concatenate([rng.choice(ids, 6, replace=False) for _ in ids])
        edges = pd.DataFrame({'Presynaptic_ID': pre, 'Postsynaptic_ID': post, 'Connectivity': rng.integers(1, 8, len(pre)), 'Excitatory': 1})
        return signed_weights(edges, ids, neurons), edges, neurons

    def test_signs(self):
        W, edges, neurons = self.fixture()
        for i in range(30):
            self.assertTrue(np.all(np.sign(W[:, i].data) == SIGNS[neurons.top_nt[i]]))
            if SIGNS[neurons.top_nt[i]] == 0:
                self.assertEqual(W[:, i].nnz, 0)

    def test_shuffle(self):
        W, _, _ = self.fixture()
        S = shuffle_control(W, 3)
        np.testing.assert_array_equal(W.getnnz(axis=0), S.getnnz(axis=0))
        np.testing.assert_array_equal(W.getnnz(axis=1), S.getnnz(axis=1))
        for sign in (-1, 1):
            np.testing.assert_array_equal((W * sign > 0).sum(axis=0), (S * sign > 0).sum(axis=0))
        overlap = W.astype(bool).multiply(S.astype(bool)).nnz
        self.assertGreaterEqual(1 - overlap / W.nnz, 0.5)
        np.testing.assert_array_equal(np.sort(W.data), np.sort(S.data))

    def test_random_and_radius(self):
        W, _, _ = self.fixture()
        R = random_control(W, 2)
        self.assertEqual(R.shape, W.shape)
        self.assertEqual(R.nnz, W.nnz)
        np.testing.assert_array_equal(np.sort(R.data), np.sort(W.data))
        S = scale_spectral_radius(W, 0.8)
        self.assertAlmostEqual(max(abs(np.linalg.eigvals(S.toarray()))), 0.8, places=6)

    @unittest.skipUnless((config.DATA_DIR / 'flywire' / 'manifest.json').exists(), 'No cached FlyWire data')
    def test_real_counts(self):
        _, n = load_tables()
        counts = {k: len(v) for k, v in mb_neurons(n).items()}
        print('Actual MB counts:', counts)
        for k, lo, hi in [('pn', 100, 400), ('kc', 2000, 3000), ('mbon', 30, 60), ('dan', 100, 200), ('apl', 1, 1)]:
            self.assertTrue(lo <= counts[k] <= hi, (k, counts[k]))

if __name__ == '__main__':
    unittest.main()
