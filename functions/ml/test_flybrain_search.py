import json
from pathlib import Path
import tempfile
import unittest
import numpy as np
from flybrain import config
from flybrain.search import append_record, read_ledger, run, lookahead_check, refresh_deflation, result_metrics
from flybrain.readout import oos_signals, fold_schedule
from flybrain.engine import backtest
from flybrain.stats import sharpe_inference, deflated_sharpe
from flybrain.prop import random_entry_signal
from test_flybrain_reservoir import frame, params

class SearchTests(unittest.TestCase):
    def test_configuration_identity_ignores_fee_and_seed(self):
        from flybrain.search import config_hash
        p=params()
        self.assertEqual(config_hash(dict(p,eval_fee=0),'fly','v'),
                         config_hash(dict(p,seed=999,eval_fee=.01),'fly','v'))
        self.assertNotEqual(config_hash(p,'fly','v'),config_hash(dict(p,rho=1.1),'fly','v'))

    def test_group_seeds_are_distinct_and_reproducible(self):
        def evaluator(*args,**kwargs): return {},'test',None
        outputs=[]
        for _ in range(2):
            with tempfile.TemporaryDirectory() as d:
                outputs.append(run(2,'2000-01-01',42,d,frame_loader=lambda s:frame(),evaluator=evaluator))
        seeds=[r['params']['seed'] for r in outputs[0]]
        self.assertEqual(len(set(seeds)),2)
        self.assertEqual(seeds,[r['params']['seed'] for r in outputs[1]])
        self.assertEqual(len(set(seeds[:4])),1)

    def test_duplicate_draw_resamples_with_bound(self):
        from unittest.mock import patch
        space={k:[v] for k,v in dict(params(),hemisphere='right').items() if k!='seed'}
        space['rho']=[.5,.8]
        class Rng:
            draws=iter([0]*len(space)+[0]*len(space)+[1]+[0]*(len(space)-1))
            def integers(self,n): return next(self.draws)
        with tempfile.TemporaryDirectory() as d, patch.object(config,'SEARCH_SPACE',space), patch('flybrain.search.np.random.default_rng',return_value=Rng()):
            rows=run(2,'2000-01-01',42,d,frame_loader=lambda s:None,evaluator=lambda *a,**k:({},'test',None))
            self.assertEqual(len(rows),8)

    def test_guard_detects_completed_session_state_leak(self):
        from unittest.mock import patch
        from flybrain.search import evaluate_variant
        df=frame(); p=dict(params(),hemisphere='right',eval_fee=0)
        # The cache contains a future-dependent value in an already completed session.
        leaked=df[['z_x']].to_numpy().copy(); leaked[0]+=df.close.iloc[-1]
        def signal(d,states,p,**kw):
            return (states['kc'][:,0]>10).astype(int),np.zeros(len(d),dtype=int)
        def probe(d,f):
            full=f(d); prefix=f(d.iloc[:len(d)//2].copy())
            return dict(ok=bool(np.array_equal(full[:len(prefix)],prefix)))
        with patch('flybrain.search.cached_states',return_value={'kc':leaked}), patch('flybrain.search.oos_signals',side_effect=signal), patch('flybrain.search.lookahead_check',side_effect=probe), patch('flybrain.search.backtest',side_effect=AssertionError('leak passed guard')):
            _,rejected,guard=evaluate_variant('none',p,{'QQQ':df},circuit_factory=lambda *a:None,check_guard=True)
        self.assertEqual(rejected,'lookahead')
        self.assertFalse(guard['ok'])

    def test_finalize_guards_before_holdout(self):
        from unittest.mock import patch
        from flybrain.finalize import finalize
        from flybrain.search import code_version
        rows=[dict(hash=k,group_id='g',night='2000-01-01',circuit=k,params=dict(params(),hemisphere='right'),
                   eligible=True,score=1.,rejected=None,guard=None,code_version=code_version()) for k in config.CIRCUITS]
        with tempfile.TemporaryDirectory() as d, patch('flybrain.finalize.read_ledger',return_value=rows), patch('flybrain.finalize.refresh_deflation',side_effect=lambda r:r):
            with patch('flybrain.finalize.load_research_frame',return_value=frame()) as discovery, patch('flybrain.finalize.evaluate_variant',return_value=({},'lookahead',{'ok':False}),create=True) as guard:
                out=finalize('2000-01-01',1,d,frame_loader=lambda s:self.fail('holdout loaded before guard passed'))
            self.assertEqual(out['variants'],[])
            self.assertTrue(guard.called)
            self.assertTrue(all(c.kwargs.get('discovery_only') for c in discovery.call_args_list))

    def test_finalize_rejects_legacy_second_look(self):
        from unittest.mock import patch
        from flybrain.finalize import finalize
        from flybrain.search import code_version, dump
        rows=[dict(hash=k,group_id='g',night='2000-01-01',circuit=k,params=dict(params(),hemisphere='right'),
                   eligible=True,score=1.,rejected=None,guard={'ok':True},code_version=code_version()) for k in config.CIRCUITS]
        with tempfile.TemporaryDirectory() as d, patch('flybrain.finalize.read_ledger',return_value=rows), patch('flybrain.finalize.refresh_deflation',side_effect=lambda r:r):
            previous=dict(rows[0],hash='legacy',params=dict(rows[0]['params'],seed=99,eval_fee=.01))
            folder=Path(d)/'nights'/'1999-01-01'; folder.mkdir(parents=True)
            (folder/'preregistered.json').write_text(dump(dict(variants=[previous])))
            with self.assertRaisesRegex(ValueError,'no second holdout'):
                finalize('2000-01-01',1,d,frame_loader=lambda s:self.fail('second holdout load'))
            self.assertFalse((Path(d)/'nights'/'2000-01-01'/'preregistered.json').exists())

    def test_legacy_fee_seed_duplicates_exhaust_retries(self):
        from unittest.mock import patch
        space={k:[v] for k,v in dict(params(),hemisphere='right').items() if k!='seed'}
        with tempfile.TemporaryDirectory() as d, patch.object(config,'SEARCH_SPACE',space):
            old=dict(params(),hemisphere='right',eval_fee=0)
            append_record(d,dict(hash='legacy',params=old,circuit='fly',group_id='old',night='1999-01-01',per_symbol={},rejected='test'))
            before=(Path(d)/'ledger.jsonl').read_bytes()
            with self.assertRaisesRegex(ValueError,'100 attempts'):
                run(1,'2000-01-01',99,d,frame_loader=lambda s:None,eval_fee=.01,
                    evaluator=lambda *a,**k:self.fail('duplicate evaluated'))
            self.assertEqual(before,(Path(d)/'ledger.jsonl').read_bytes())

    def test_evaluation_reuses_full_signals_for_guard(self):
        from unittest.mock import patch
        from flybrain.search import evaluate_variant
        df=frame(); p=dict(params(),hemisphere='right'); frames={'QQQ':df}; cache={}
        with patch('flybrain.search.cached_states',return_value={'kc':df[['z_x']].to_numpy()}) as states, patch('flybrain.search.oos_signals',wraps=oos_signals) as signals, patch('flybrain.search.backtest',wraps=backtest) as bt, patch('flybrain.search.break_even_cost',return_value=0), patch('flybrain.search.prop_lift',return_value=dict(lift=0.)):
            first=evaluate_variant('none',p,frames,circuit_factory=lambda *a:None,evaluation_cache=cache)
            before=(states.call_count,signals.call_count,bt.call_count)
            with patch('flybrain.search.guard_signals',return_value={'ok':True}) as guard:
                second=evaluate_variant('none',p,frames,circuit_factory=lambda *a:None,evaluation_cache=cache,check_guard=True)
            self.assertEqual(before,(states.call_count,signals.call_count,bt.call_count))
            self.assertEqual(first[0],second[0]); self.assertEqual(second[2],{'ok':True})
            self.assertEqual(guard.call_count,1)

    def test_uncached_guard_accepts_causal_readouts(self):
        from flybrain.search import guard_signals
        from flybrain.reservoir import pack_sessions, run_reservoir
        from test_flybrain_reservoir import ReservoirTests
        df=frame(n=20,bars=6); df.attrs['fold_schedule']=fold_schedule(df,1)
        for readout in ('ridge','dan'):
            p=dict(params(),readout=readout)
            c=ReservoirTests().circuit()
            X,mask=pack_sessions(df,False); states=run_reservoir(c,X,mask,p)
            signal,_=oos_signals(df,states,p)
            self.assertTrue(guard_signals(df,states,signal,c,p)['ok'])

    def test_deflation_uses_memory_and_all_trials(self):
        from unittest.mock import patch
        from flybrain.search import dump
        m,_,_=self.signals(0,False)
        def evaluator(*a,**kw):
            return {s:dict(metrics=m,prop=dict(lift=0.,lift_ci=[-.1,.1])) for s in config.SYMBOLS},None,{'ok':True}
        with tempfile.TemporaryDirectory() as d, patch('flybrain.search.read_ledger',wraps=read_ledger) as reads, patch('flybrain.search.refresh_deflation',wraps=refresh_deflation) as refresh:
            out=run(2,'2000-01-01',42,d,frame_loader=lambda s:None,evaluator=evaluator,eval_fee=.01)
            self.assertEqual(reads.call_count,1)
            self.assertEqual(refresh.call_count,1)
            rows=read_ledger(d)
            for i,row in enumerate(rows):
                expected=refresh_deflation(rows[:i+1])[-1]
                self.assertEqual(dump(row),dump(expected))
                self.assertNotIn('eval_fee',row['params']); self.assertEqual(row['eval_fee'],.01)
            self.assertTrue(all(r['per_symbol']['QQQ']['dsr']['trials']==8 for r in out))

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
        result=backtest(df,signal,'QQQ',1,n_contracts=2)
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
            more=run(1,'2000-01-02',42,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=8)
            self.assertEqual(len({r['hash'] for r in more}),8)
            self.assertNotEqual(more[0]['params']['seed'],more[4]['params']['seed'])
            lock=Path(d)/'nights'/'2000-01-01'/'finalize.lock'; lock.parent.mkdir(parents=True); lock.touch()
            with self.assertRaisesRegex(ValueError,'finalized'): run(1,'2000-01-01',7,d,frame_loader=lambda s:frame(),evaluator=evaluator,cap=12)

    def test_control_matches_trade_count_and_holds(self):
        _,df,r=self.signals(2,True)
        for seed in range(5):
            signal,holds=random_entry_signal(df,r.trades,seed)
            c=backtest(df,signal,'QQQ',1,n_contracts=2,entry_holds=holds)
            self.assertEqual(len(c.trades),len(r.trades))
            self.assertEqual(sorted(t['hold'] for t in c.trades),sorted(t['hold'] for t in r.trades))


    def test_finalize_lock_before_load_and_one_look_verify(self):
        from unittest.mock import patch
        from flybrain.finalize import finalize
        from flybrain.verify import verify
        from flybrain.search import code_version, dump
        from flybrain.features import normalize_sessions
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
                    rejected=None,guard=None,score=m['inference']['sharpe'],code_version=code_version())
                append_record(d,row)
            def loader(symbol):
                folder=Path(d)/'nights'/'2000-01-01'
                self.assertTrue((folder/'preregistered.json').exists())
                self.assertTrue((folder/'finalize.lock').exists())
                registered=json.loads((folder/'preregistered.json').read_text())
                self.assertTrue(all(r['guard']['ok'] for r in registered['variants']))
                self.assertEqual(guard.call_count,4)
                result=df.copy(); result.attrs['symbol']=symbol
                return result
            with patch('flybrain.finalize.build_circuit',return_value=None), patch('flybrain.finalize.prop_lift',return_value=dict(lift=.5,lift_ci=[.4,.6])), patch('flybrain.finalize.load_research_frame',return_value=df), patch('flybrain.finalize.evaluate_variant',return_value=({},None,{'ok':True})) as guard:
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
