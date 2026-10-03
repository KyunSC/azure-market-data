import json
import math
from pathlib import Path
import unittest
from flybrain.prop import run_prop, mulberry32
from flybrain.stats import sharpe_inference, deflated_sharpe, norm_cdf, norm_inv

BASE=Path(__file__).parent/'flybrain'/'fixtures'

class ParityTests(unittest.TestCase):
    def equal(self,a,b,path=''):
        if b is None:
            self.assertTrue(a is None or isinstance(a,(float,int)) and not math.isfinite(a),path)
        elif isinstance(b,dict):
            self.assertEqual(set(a),set(b),path)
            for k in b: self.equal(a[k],b[k],path+'/'+k)
        elif isinstance(b,list):
            self.assertEqual(len(a),len(b),path)
            for i,(x,y) in enumerate(zip(a,b)): self.equal(x,y,f'{path}/{i}')
        elif isinstance(b,(float,int)) and not isinstance(b,bool): self.assertAlmostEqual(a,b,delta=1e-9,msg=path)
        else: self.assertEqual(a,b,path)

    def test_stats_and_rng(self):
        f=json.loads((BASE/'stats_parity.json').read_text())
        for c in f['cases']:
            inf=sharpe_inference(c['returns'])
            self.equal(inf,c['inference']); self.equal(deflated_sharpe(inf,c['trials']),c['deflated'])
        for c in f['norm']:
            self.equal(norm_inv(c['p']),c['inv']); self.equal(norm_cdf(c['inv']),c['cdf'])
        rng=mulberry32(42)
        self.equal([rng() for _ in f['rng']],f['rng'])

    def test_prop_all_plans(self):
        f=json.loads((BASE/'prop_parity.json').read_text())
        for c in f['cases']:
            with self.subTest(plan=c['plan']['plan'],size=c['plan']['size'],dll=c['plan']['dll']):
                result=run_prop(f['result'],f['time'],c['plan'],f['initialCapital'],paths=f['paths'],block_size=f['blockSize'],horizon=f['horizon'],seed=f['seed'])
                self.equal(result,c['output'])

if __name__ == '__main__': unittest.main()
