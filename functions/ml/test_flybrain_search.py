import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from flybrain import config
from flybrain.search import append_record, read_ledger, run, lookahead_check, refresh_deflation, result_metrics, config_hash
from flybrain.readout import oos_signals, fold_schedule
from flybrain.engine import backtest
from flybrain.stats import sharpe_inference, deflated_sharpe
from flybrain.prop import random_entry_signal
from test_flybrain_reservoir import frame, params

class SearchTests(unittest.TestCase):
    def test_append_duplicate_cap(self):
        with tempfile.TemporaryDirectory() as d:
            append_record(d,{'hash':'a'},cap=2)
            before=(Path(d)/'ledger.jsonl').read_bytes()
            with self.assertRaisesRegex(ValueError,'Duplicate'): append_record(d,{'hash':'a'},cap=2)
            append_record(d,{'hash':'b'},cap=2)
            self.assertTrue((Path(d)/'ledger.jsonl').read_bytes().startswith(before))
            with self.assertRaisesRegex(ValueError,'cap'): append_record(d,{'hash':'c'},cap=2)

    def test_leak_rejected(self):
        df=frame()
        self.assertFalse(lookahead_check(df,lambda d:np.sign(d.close.shift(-1).fillna(0)-d.close))['ok'])
        self.assertTrue(lookahead_check(df,lambda d:np.sign(d.close-d.open))['ok'])

    def test_dsr_deflates(self):
        inf=sharpe_inference(np.random.default_rng(0).normal(.03,1,5000))
        values=np.linspace(-.1,.1,10).tolist()
        self.assertGreater(deflated_sharpe(inf,values)['dsr'],deflated_sharpe(inf,values*20)['dsr'])

    def signals(self,seed,planted):
        df=frame(n=60,bars=20,seed=seed); rng=np.random.default_rng(seed)
        x=df.z_x.to_numpy()
        ret=np.r_[0,x[:-1]*.4] if planted else rng.normal(0,.1,len(df))
        df['open']=100.; df['close']=100+ret; df['high']=np.maximum(df.open,df.close)+.01; df['low']=np.minimum(df.open,df.close)-.01
        p=params(); p['horizon_bars']=1
        df.attrs['fold_schedule']=fold_schedule(df,1)
        signal,fold=oos_signals(df,{'kc':x[:,None]},p)
        result=backtest(df,signal,'QQQ','MNQ',2,1)
        m=result_metrics(result,fold); m['break_even']=2.
        return m,df,result

    def test_planted_and_noise(self):
        m,_,_=self.signals(2,True)
        self.assertGreater(m['inference']['sharpe'],0)
        rows=[]
        for seed in range(20):
            m,_,_=self.signals(seed,False)
            per={s:dict(metrics=m,prop=dict(lift_ci=[.1,.2],lift=.15)) for s in config.SYMBOLS}
            rows.append(dict(hash=str(seed),per_symbol=per,rejected=None))
        self.assertFalse(any(r['eligible'] for r in refresh_deflation(rows)))

    def test_paired_run_injected_and_finalize_lock(self):
        def evaluator(kind,p,frames,**kwargs):
            m,_,_=self.signals(0,False)
            return {s:dict(metrics=m,prop=dict(lift=0.,lift_ci=[-.1,.1])) for s in config.SYMBOLS},None,dict(ok=True)
        with tempfile.TemporaryDirectory() as d:
            rows=run(1,'2000-01-01',42,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=8)
            self.assertEqual(len(rows),4)
            self.assertEqual({r['circuit'] for r in rows},set(config.CIRCUITS))
            with self.assertRaisesRegex(ValueError,'Duplicate'): run(1,'2000-01-01',42,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=8)
            lock=Path(d)/'nights'/'2000-01-01'/'finalize.lock'; lock.parent.mkdir(parents=True); lock.touch()
            with self.assertRaisesRegex(ValueError,'finalized'): run(1,'2000-01-01',7,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=8)

    def test_control_matches_trade_count_and_holds(self):
        _,df,r=self.signals(2,True)
        for seed in range(5):
            signal,holds=random_entry_signal(df,r.trades,seed,return_holds=True)
            c=backtest(df,signal,'QQQ','MNQ',2,1,entry_holds=holds)
            self.assertEqual(len(c.trades),len(r.trades))
            self.assertEqual(sorted(t['hold'] for t in c.trades),sorted(t['hold'] for t in r.trades))


    def test_finalize_lock_before_load_and_one_look_verify(self):
        from unittest.mock import patch
        from flybrain.finalize import finalize
        from flybrain.verify import verify
        from flybrain.search import code_version, dump
        from flybrain.features import normalize_sessions
        from flybrain.readout import fit_frozen
        with tempfile.TemporaryDirectory() as d:
            df=frame(n=60,bars=20)
            df['x']=df.z_x
            df=normalize_sessions(df,['x'],warmup=0)
            m,_,_=self.signals(3,True)
            m['break_even']=10.
            p=dict(params(),hemisphere='right',gex_off=False)
            for k in config.CIRCUITS:
                row=dict(id=len(read_ledger(d))+1,hash=k,group_id='g',night='2000-01-01',circuit=k,params=p,
                    per_symbol={s:dict(metrics=m,prop=dict(lift=.5,lift_ci=[.4,.6])) for s in config.SYMBOLS},
                    rejected=None,score=m['inference']['sharpe'],code_version=code_version())
                append_record(d,row)
            def loader(symbol):
                folder=Path(d)/'nights'/'2000-01-01'
                self.assertTrue((folder/'preregistered.json').exists())
                self.assertTrue((folder/'finalize.lock').exists())
                result=df.copy(); result.attrs['symbol']=symbol
                return result
            with patch('flybrain.finalize.build_circuit',return_value=None), patch('flybrain.finalize.prop_lift',return_value=dict(lift=.5,lift_ci=[.4,.6])):
                output=finalize('2000-01-01',1,d,frame_loader=loader)
            self.assertEqual(len(output['variants']),4)
            with self.assertRaisesRegex(ValueError,'already'): finalize('2000-01-01',1,d,frame_loader=loader)
            # Make a synthetic eligible result for verify lifecycle testing only.
            path=Path(d)/'nights'/'2000-01-01'/'holdout.json'
            output['variants'][0]['verdict']='CANDIDATE'
            path.write_text(dump(output))
            h=output['variants'][0]['hash']
            def sealed_loader(symbol,frozen):
                log=[json.loads(line) for line in (Path(d)/'verify_log.jsonl').read_text().splitlines()]
                self.assertEqual(log[0]['status'],'started')
                raise RuntimeError('synthetic load failure')
            with self.assertRaisesRegex(RuntimeError,'synthetic'): verify(h,d,loader=sealed_loader)
            with self.assertRaisesRegex(ValueError,'already attempted'): verify(h,d,loader=sealed_loader)

    def test_fold_entries_report_trades_pnl_and_drawdown(self):
        m,df,r=self.signals(2,True)
        self.assertTrue(m['folds'])
        for f in m['folds']:
            for key in ('n_trades','total_pnl','max_drawdown','sharpe'): self.assertIn(key,f)
        self.assertEqual(sum(f['n_trades'] for f in m['folds']),m['n_trades'])
        self.assertAlmostEqual(sum(f['total_pnl'] for f in m['folds']),m['total_pnl'],places=6)

    def test_interrupt_in_second_guard_is_recorded(self):
        calls={'n':0}
        def evaluator(kind,p,frames,check_guard=False,**kw):
            m,_,_=self.signals(0,False)
            calls['n']+=1
            if kind=='shuffle' and check_guard: raise KeyboardInterrupt
            return {s:dict(metrics=m,prop=dict(lift=0.,lift_ci=[-.1,.1])) for s in config.SYMBOLS},None,dict(ok=True)
        with tempfile.TemporaryDirectory() as d:
            # Night already has a row, so only the top-five guard (second evaluation) can fire.
            append_record(d,dict(hash='seed',night='2000-01-01',group_id='x',circuit='fly',params={},per_symbol={},score=None,rejected='error:x'))
            with self.assertRaises(KeyboardInterrupt):
                run(1,'2000-01-01',42,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=20)
            rows=read_ledger(d)
            self.assertEqual([r['circuit'] for r in rows[1:]],['fly','shuffle'])
            self.assertEqual(rows[-1]['rejected'],'error:KeyboardInterrupt')

    def test_finalize_ignores_group_with_rejected_control(self):
        from flybrain.finalize import finalize
        from flybrain.search import code_version
        with tempfile.TemporaryDirectory() as d:
            m,_,_=self.signals(3,True); m['break_even']=10.
            p=dict(params(),hemisphere='right',gex_off=False)
            for k in config.CIRCUITS:
                append_record(d,dict(id=1,hash=k,group_id='g',night='2000-01-01',circuit=k,params=p,
                    per_symbol={} if k=='random' else {s:dict(metrics=m,prop=dict(lift=.5,lift_ci=[.4,.6])) for s in config.SYMBOLS},
                    rejected='lookahead' if k=='random' else None,score=m['inference']['sharpe'],code_version=code_version()))
            def loader(symbol): raise AssertionError('no holdout may load')
            out=finalize('2000-01-01',1,d,frame_loader=loader)
            self.assertEqual(out['variants'],[])

if __name__=='__main__': unittest.main()
