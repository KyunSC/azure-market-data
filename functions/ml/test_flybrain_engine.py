import unittest
import numpy as np
import pandas as pd
from flybrain.engine import backtest

class EngineTests(unittest.TestCase):
    def test_fills_costs_extremes_and_session_flat(self):
        df=pd.DataFrame(dict(date=pd.to_datetime(['2024-01-02T14:30Z','2024-01-02T14:35Z','2024-01-02T14:40Z','2024-01-03T14:30Z','2024-01-03T14:35Z']),
            session=[0,0,0,1,1],open=[100,101,102,104,105],high=[101,103,104,105,107],low=[99,100,101,103,104],close=[100,102,103,104,106]))
        r=backtest(df,[1,0,1,-1,0],'QQQ',10,n_contracts=2)
        t=r.trades[0]
        self.assertEqual(t['entry_idx'],1)
        self.assertAlmostEqual(t['entry_price'],101*41.2+.25)
        self.assertAlmostEqual(t['pnl'],(103-101)*41.2*2*2 - 2*(.5*2+.25*2*2))
        self.assertEqual(t['exit_idx'],2)
        self.assertEqual(r.position[2],0); self.assertEqual(r.position[-1],0)
        self.assertTrue(np.all(r.bar_lo<=r.equity)); self.assertTrue(np.all(r.bar_hi>=r.equity))
        self.assertAlmostEqual(r.bar_open[1],50000-2.)
        self.assertEqual(len(r.trades),2)
        self.assertEqual(r.trades[1]['side'],-1)

if __name__ == '__main__': unittest.main()
