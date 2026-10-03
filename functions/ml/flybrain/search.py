"""Bounded, append-only, paired circuit study. No sealed verification imports."""
import argparse
from contextlib import contextmanager
from datetime import date, datetime, timezone
import fcntl
import hashlib
import json
import math
from functools import partial
from pathlib import Path
import time
import numpy as np
from . import config
from .connectome import build_circuit
from .features import load_research_frame, GEX_FEATURES
from .reservoir import cached_states, run_reservoir, pack_sessions
from .readout import fold_schedule, oos_signals
from .engine import backtest
from .stats import sharpe_inference, deflated_sharpe, break_even_cost
from .prop import resolve_plan, prop_lift


def clean(value):
    if isinstance(value,dict): return {str(k):clean(v) for k,v in value.items()}
    if isinstance(value,(list,tuple,np.ndarray)): return [clean(v) for v in value]
    if isinstance(value,(float,np.floating)) and not math.isfinite(value):
        return 'Infinity' if value==math.inf else '-Infinity' if value==-math.inf else None
    if isinstance(value,np.generic): return value.item()
    return value


def dump(value):
    return json.dumps(clean(value),sort_keys=True,allow_nan=False)


def code_version():
    base=Path(__file__).parent
    h=hashlib.sha256()
    sources=list(base.glob('*.py'))+list((base/'fixtures').glob('*.json'))
    sources += [config.ML_DIR/f for f in ('gex_vol_study.py','build_dataset.py','eval.py','holdout.py')]
    for path in sorted(sources):
        h.update(path.name.encode()); h.update(path.read_bytes())
    return h.hexdigest()


def config_hash(params,circuit,version=None):
    return hashlib.sha256(dump(dict(params=params,circuit=circuit,code_version=version or code_version())).encode()).hexdigest()


@contextmanager
def ledger_lock(runs_dir):
    root=Path(runs_dir); root.mkdir(parents=True,exist_ok=True)
    with (root/'.writer.lock').open('a') as f:
        try: fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: raise RuntimeError('Another Flybrain writer is active') from None
        try: yield
        finally: fcntl.flock(f,fcntl.LOCK_UN)


def read_ledger(runs_dir):
    p=Path(runs_dir)/'ledger.jsonl'
    return [json.loads(line) for line in p.read_text().splitlines() if line.strip()] if p.exists() else []


def append_record(runs_dir,row,cap=None):
    import os
    cap=config.MAX_TRIALS_LIFETIME if cap is None else cap
    rows=read_ledger(runs_dir)
    if len(rows)>=cap: raise ValueError('Lifetime trial cap exhausted')
    if any(r['hash']==row['hash'] for r in rows): raise ValueError('Duplicate configuration hash')
    root=Path(runs_dir); root.mkdir(parents=True,exist_ok=True)
    with (root/'ledger.jsonl').open('a') as f:
        f.write(dump(row)+'\n'); f.flush(); os.fsync(f.fileno())


def lookahead_check(df,signal_fn,probes=config.LOOKAHEAD_PROBES):
    full=np.asarray(signal_fn(df))
    for cut in np.unique(np.linspace(1,len(df)-2,probes,dtype=int)):
        part=np.asarray(signal_fn(df.iloc[:cut+1].copy()))
        mismatch=np.flatnonzero(part!=full[:cut+1])
        if len(mismatch): return dict(ok=False,bar=int(mismatch[0]),truncated_at=int(cut))
    return dict(ok=True)


def result_metrics(result,fold_id):
    mask=fold_id>=0
    inference=sharpe_inference(result.returns[mask])
    entries=np.array([t['entry_idx'] for t in result.trades],dtype=int)
    folds=[]
    for k in np.unique(fold_id[mask]):
        idx=np.flatnonzero(fold_id==k)
        # Folds end at session close, so the account is flat on both edges and the
        # equity change is exactly the fold's realised P&L.
        before=result.equity[idx[0]-1] if idx[0]>0 else result.initial_capital
        curve=result.equity[idx]
        peak=np.maximum.accumulate(np.r_[before,curve])[1:]
        folds.append(dict(fold=int(k),**sharpe_inference(result.returns[idx]),
                          n_trades=int(np.isin(entries,idx).sum()),total_pnl=float(curve[-1]-before),
                          max_drawdown=float(np.max(peak-curve))))
    peak=np.maximum.accumulate(np.r_[result.initial_capital,result.equity])[1:]
    return dict(inference=inference,folds=folds,pos_folds=sum(f['sharpe']>0 for f in folds),
                n_trades=len(result.trades),total_pnl=float(result.equity[-1]-result.initial_capital),
                max_drawdown=float(np.max(peak-result.equity)))


def eligible_symbol(row):
    m=row['metrics']; p=row['prop']; g=config.GATES
    return (m['n_trades']>=g['min_trades'] and m['pos_folds']>=g['min_pos_folds']
        and float(m['break_even'])>config.SLIPPAGE_TICKS and (row['dsr'].get('dsr') or 0)>=g['dsr_min']
        and p['lift_ci'][0] is not None and p['lift_ci'][0]>0)


def refresh_deflation(rows):
    """Derived view; original ledger lines are never rewritten as trial count grows."""
    rows=json.loads(dump(rows))
    srs={s:[r['per_symbol'][s]['metrics']['inference']['sr'] for r in rows
            if s in r.get('per_symbol',{}) and r['per_symbol'][s]['metrics']['inference']['sr'] is not None]
         for s in config.SYMBOLS}
    for row in rows:
        for s,r in row.get('per_symbol',{}).items():
            r['dsr']=deflated_sharpe(r['metrics']['inference'],srs[s])
        row['eligible']=not row.get('rejected') and len(row.get('per_symbol',{}))==len(config.SYMBOLS) and all(eligible_symbol(r) for r in row['per_symbol'].values())
    return rows


def evaluate_variant(kind,params,frames,circuit_factory=build_circuit,check_guard=False,prop_settings=None,metric_cache=None):
    circuit=None if kind=='none' else circuit_factory(kind,params['hemisphere'],params.get('seed',0))
    per_symbol={}; plan=resolve_plan(config.PROP['plan'],config.PROP['size'],config.PROP['dll'])
    for symbol,frame in frames.items():
        df=frame.copy(); df.attrs=frame.attrs.copy()
        df['session_end']=df.session.ne(df.session.shift(-1))
        df.attrs['fold_schedule']=fold_schedule(df,params['horizon_bars'])
        stage=time.monotonic()
        states=cached_states(circuit,df,params)
        print(f'  {kind} {symbol}: states ready ({time.monotonic()-stage:.1f}s)',flush=True)
        model_cache={}
        signal,fold_id=oos_signals(df,states,params,model_cache=model_cache)
        if check_guard:
            def signal_fn(prefix):
                if len(prefix)==len(df): return signal
                # Completed sessions are unchanged cache entries. Recompute the partial session.
                start=int(np.flatnonzero(prefix.session.to_numpy()==prefix.session.iloc[-1])[0])
                partial=prefix.iloc[start:].copy()
                X,mask=pack_sessions(partial)
                p=dict(params,gex_indices=[i for i,c in enumerate(df.attrs['features']) if c in GEX_FEATURES])
                tail=run_reservoir(circuit,X,mask,p)
                st={k:np.concatenate((states[k][:start],tail[k])) for k in states}
                return oos_signals(prefix,st,params,model_cache=model_cache)[0]
            guard=lookahead_check(df,signal_fn)
            if not guard['ok']: return {},'lookahead',guard
        print(f'  {kind} {symbol}: readout/guard ready ({time.monotonic()-stage:.1f}s)',flush=True)
        cache_key=(kind,symbol,dump(params))
        if metric_cache is not None and cache_key in metric_cache:
            per_symbol[symbol]=metric_cache[cache_key]
            continue
        result=backtest(df,signal,symbol,config.SYMBOLS[symbol],config.N_CONTRACTS,params['horizon_bars'])
        metrics=result_metrics(result,fold_id)
        metrics['break_even']=break_even_cost(df,signal,symbol,config.SYMBOLS[symbol],config.N_CONTRACTS,params['horizon_bars'])
        # Prop replay uses only the stitched OOS period, including genuinely flat OOS days.
        first=int(np.flatnonzero(fold_id>=0)[0])
        oos=df.iloc[first:].reset_index(drop=True)
        scored=backtest(oos,signal[first:],symbol,config.SYMBOLS[symbol],config.N_CONTRACTS,params['horizon_bars'])
        lift=prop_lift(scored,oos,plan,params.get('seed',0),symbol,params['horizon_bars'],
                       eval_fee=params.get('eval_fee',config.EVAL_FEE),settings=prop_settings)
        per_symbol[symbol]=dict(metrics=metrics,prop=lift)
        if metric_cache is not None: metric_cache[cache_key]=per_symbol[symbol]
        print(f"  {kind:7} {symbol}: SR={metrics['inference']['sharpe']:.3f} trades={metrics['n_trades']} P&L={metrics['total_pnl']:.2f} lift={lift['lift']:.3f}",flush=True)
    return per_symbol,None,{'ok':True} if check_guard else None


def run(trials=config.TRIALS_PER_NIGHT,night=None,seed=42,runs_dir=config.RUNS_DIR,
        frame_loader=None,evaluator=None,circuit_factory=build_circuit,cap=None,eval_fee=config.EVAL_FEE):
    night=night or date.today().isoformat(); date.fromisoformat(night)
    if trials<1: raise ValueError('trials must be positive')
    root=Path(runs_dir); cap=config.MAX_TRIALS_LIFETIME if cap is None else cap
    frame_loader=frame_loader or (lambda s:load_research_frame(s,discovery_only=True))
    evaluator=evaluator or partial(evaluate_variant,metric_cache={})
    with ledger_lock(root):
        rows=read_ledger(root)
        if len(rows)+len(config.CIRCUITS)>cap: raise ValueError('Lifetime cap cannot fit a paired trial group')
        if (root/'nights'/night/'finalize.lock').exists(): raise ValueError('Night already finalized')
        frames={s:frame_loader(s) for s in config.SYMBOLS}
        rng=np.random.default_rng(seed); version=code_version()
        for group in range(trials):
            if len(rows)+len(config.CIRCUITS)>cap: break
            params={k:values[int(rng.integers(len(values)))] for k,values in config.SEARCH_SPACE.items()}
            params.update(seed=seed,eval_fee=eval_fee)
            hashes=[config_hash(params,k,version) for k in config.CIRCUITS]
            if any(r['hash'] in hashes for r in rows): raise ValueError('Duplicate sampled paired group; use a different seed')
            group_id=hashlib.sha256(dump(dict(params=params,version=version)).encode()).hexdigest()[:16]
            start=time.monotonic(); first=not any(r['night']==night for r in rows)
            for kind,h in zip(config.CIRCUITS,hashes):
                guarded=first
                try:
                    per,rejected,guard=evaluator(kind,params,frames,circuit_factory=circuit_factory,check_guard=guarded)
                    score=min((v['metrics']['inference']['sharpe'] for v in per.values()),default=-math.inf)
                    # All potential top-five configurations receive a prefix guard before ledger acceptance.
                    previous=sorted((r['score'] for r in rows if not r.get('rejected') and isinstance(r.get('score'),(int,float))),reverse=True)
                    if not rejected and not guarded and (len(previous)<5 or score>=previous[4]):
                        per,rejected,guard=evaluator(kind,params,frames,circuit_factory=circuit_factory,check_guard=True)
                        guarded=True
                        score=min((v['metrics']['inference']['sharpe'] for v in per.values()),default=-math.inf)
                    row=dict(id=len(rows)+1,hash=h,group_id=group_id,night=night,circuit=kind,params=params,
                             per_symbol=per,score=score,eligible=False,rejected=rejected,guard=guard,code_version=version,
                             created_at=datetime.now(timezone.utc).isoformat())
                    # Deflate against every earlier recorded variant, not merely the night's winners.
                    row=refresh_deflation(rows+[row])[-1]
                    append_record(root,row,cap); rows.append(row)
                except (Exception, KeyboardInterrupt) as exc:
                    # An interrupted or failed variant still spends one lifetime slot, so aborting
                    # after peeking at partial progress cannot reset the budget.
                    if not any(r['hash']==h for r in read_ledger(root)):
                        failed=dict(id=len(rows)+1,hash=h,group_id=group_id,night=night,circuit=kind,params=params,
                            per_symbol={},score=None,eligible=False,rejected='error:'+type(exc).__name__,
                            code_version=version,created_at=datetime.now(timezone.utc).isoformat())
                        try: append_record(root,failed,cap)
                        except ValueError: pass
                    raise
            elapsed=time.monotonic()-start
            print(f'Group {group_id}: {elapsed:.2f}s; lifetime {len(rows)}/{cap}',flush=True)
            if any(r['eligible'] for r in refresh_deflation(rows) if r['group_id']==group_id): break
    return refresh_deflation(rows)


def complete_groups(rows):
    groups={}
    for r in rows:
        if not r.get('rejected'): groups.setdefault(r['group_id'],{})[r['circuit']]=r
    return {k:v for k,v in groups.items() if all(c in v for c in config.CIRCUITS)}


def group_value(row,metric,symbol=None):
    """Sharpe or prop lift of one variant: the symbol's value, or the median across both symbols."""
    symbols=[symbol] if symbol else list(config.SYMBOLS)
    vals=[row['per_symbol'][s]['metrics']['inference']['sharpe'] if metric=='sharpe' else row['per_symbol'][s]['prop']['lift']
          for s in symbols if s in row['per_symbol']]
    ok=len(vals)==len(symbols) and all(x is not None and math.isfinite(x) for x in vals)
    return float(np.median(vals)) if ok else math.nan


def paired_table(rows,symbol=None):
    """Median per circuit and bootstrap CI of the fly-minus-control paired difference over complete groups."""
    groups=complete_groups(rows); out=[]; rng=np.random.default_rng(42)
    for metric in ('sharpe','lift'):
        for circuit in config.CIRCUITS:
            vals=[]; diffs=[]
            for group in groups.values():
                v=group_value(group[circuit],metric,symbol); fly=group_value(group['fly'],metric,symbol)
                if math.isfinite(v) and math.isfinite(fly): vals.append(v); diffs.append(fly-v)
            ci=[math.nan,math.nan]
            if diffs:
                boot=np.median(rng.choice(diffs,size=(2000,len(diffs)),replace=True),axis=1)
                ci=np.quantile(boot,[.025,.975]).tolist()
            out.append(dict(metric=metric,circuit=circuit,groups=len(vals),median=float(np.median(vals)) if vals else math.nan,
                            fly_minus_control_ci=ci))
    return out


def group_rows(rows):
    """One entry per complete trial group: all four circuits side by side, both symbols and their median."""
    out=[]
    for gid,group in complete_groups(rows).items():
        p=group['fly']['params']
        out.append(dict(group_id=gid,night=group['fly']['night'],
            params={k:p[k] for k in ('gex_off','readout','readout_from','horizon_bars','kc_sparsity','rho','leak','input_gain')},
            **{metric:{c:dict(median=group_value(group[c],metric),**{s:group_value(group[c],metric,s) for s in config.SYMBOLS})
                       for c in config.CIRCUITS} for metric in ('sharpe','lift')}))
    return out


def matched_gex_ablation(rows):
    """Groups whose sampled parameters match except gex_off: GEX-on minus GEX-off, per circuit and metric.

    With random sampling matched pairs are rare; an empty result means no pair exists, not no effect.
    """
    keyed={}
    for g in complete_groups(rows).values():
        p=g['fly']['params']
        keyed.setdefault(dump({k:v for k,v in p.items() if k!='gex_off'}),{})[bool(p['gex_off'])]=g
    pairs=[v for v in keyed.values() if True in v and False in v]
    out=dict(pairs=len(pairs),differences={})
    for metric in ('sharpe','lift'):
        for c in config.CIRCUITS:
            d=[group_value(v[True][c],metric)-group_value(v[False][c],metric) for v in pairs]
            d=[x for x in d if math.isfinite(x)]
            out['differences'][f'{metric}:{c}']=float(np.median(d)) if d else math.nan
    return out


def leaderboard(runs_dir=config.RUNS_DIR,all_rows=False):
    rows=refresh_deflation(read_ledger(runs_dir))
    ranked=sorted((r for r in rows if not r.get('rejected') and (all_rows or r['eligible'])),key=lambda r:r['score'],reverse=True)
    complete=[r for r in rows if r.get('params')]
    return dict(variants=ranked,paired=paired_table(rows),paired_by_symbol={s:paired_table(rows,s) for s in config.SYMBOLS},
                groups=group_rows(rows),
                gex_ablation=dict(strata={str(off):paired_table([r for r in complete if r['params']['gex_off']==off]) for off in (False,True)},
                                  matched=matched_gex_ablation(rows)))


def status(runs_dir=config.RUNS_DIR):
    rows=refresh_deflation(read_ledger(runs_dir))
    return dict(trials=len(rows),cap=config.MAX_TRIALS_LIFETIME,nights=sorted(set(r['night'] for r in rows)),
                eligible=sum(r['eligible'] for r in rows),best_score=max((r['score'] for r in rows if isinstance(r.get('score'),(int,float))),default=None))


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    sub=parser.add_subparsers(dest='command',required=True)
    for name in ('run','leaderboard','status','finalize','verify'):
        p=sub.add_parser(name); p.add_argument('--runs-dir',type=Path,default=config.RUNS_DIR)
        if name=='run':
            p.add_argument('--trials',type=int,default=config.TRIALS_PER_NIGHT); p.add_argument('--night',default=date.today().isoformat()); p.add_argument('--seed',type=int,default=42); p.add_argument('--eval-fee',type=float,default=config.EVAL_FEE)
        if name=='leaderboard': p.add_argument('--all',action='store_true')
        if name=='finalize': p.add_argument('--night',required=True); p.add_argument('--top',type=int,default=5)
        if name=='verify': p.add_argument('hash')
    args=parser.parse_args()
    if args.command=='run': run(args.trials,args.night,args.seed,args.runs_dir,eval_fee=args.eval_fee)
    elif args.command=='leaderboard': print(dump(leaderboard(args.runs_dir,args.all)))
    elif args.command=='status': print(dump(status(args.runs_dir)))
    elif args.command=='finalize':
        from .finalize import finalize
        print(dump(finalize(args.night,args.top,args.runs_dir)))
    else:
        from .verify import verify
        print(dump(verify(args.hash,args.runs_dir)))

if __name__=='__main__': main()
