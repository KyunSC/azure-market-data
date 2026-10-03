"""Preregister before loading lab holdout; freeze readouts for one-look verify."""
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
from . import config
from .connectome import build_circuit
from .features import load_research_frame, split_discovery_holdout
from .reservoir import cached_states
from .readout import fit_frozen, frozen_signals
from .engine import backtest
from .prop import resolve_plan, prop_lift
from .stats import bonferroni_ci, break_even_cost
from .search import (ledger_lock, read_ledger, refresh_deflation, complete_groups, dump, durable_write, result_metrics,
                     code_version, leaderboard, passes_edge_gates, evaluate_variant, config_hash)


def verdict(metrics,research_dsr,lift):
    if metrics['n_trades']<config.GATES['min_holdout_trades']: return 'INSUFFICIENT'
    if not metrics['total_pnl']>0: return 'NO EDGE'
    if metrics['family_ci'][0]>0 and passes_edge_gates(metrics,research_dsr,lift):
        return 'CANDIDATE'
    return 'WEAK'


def report(payload,paired):
    lines=['# Flybrain private research report','',f"Night: {payload['night']}. Family: {payload['family_size']} symbol-level tests.",
           '', 'Discovery | lab holdout | five-session gap | sealed verify (not opened)', '',
           '| Circuit | Hash | Symbol | Verdict | Sharpe | Trades | P&L |', '|---|---|---|---|---:|---:|---:|']
    for row in payload['variants']:
        for s,r in row['per_symbol'].items():
            m=r['metrics']; lines.append(f"| {row['circuit']} | {row['hash'][:12]} | {s} | {r['verdict']} | {m['inference']['sharpe']:.3f} | {m['n_trades']} | {m['total_pnl']:.2f} |")
    if not payload['variants']: lines+=['','No eligible fly variants; no holdout data was loaded. No edge established.']
    lines+=['','## Paired discovery controls','', '```json',dump(paired),'```', '',
            'ETF proxy, RTH only; basis and rolls are omitted. Lucid rules use the repository Sep 2026 snapshot.',
            'Trial deflation and family intervals do not remove serial dependence or proxy-model risk.',
            'ThetaData-derived outputs are private and must never be redistributed.']
    return '\n'.join(lines)+'\n'


def finalize(night,top=config.TOP_K,runs_dir=config.RUNS_DIR,frame_loader=load_research_frame):
    date.fromisoformat(night)
    if top<1: raise ValueError('top must be positive')
    root=Path(runs_dir)
    with ledger_lock(root):
        folder=root/'nights'/night; folder.mkdir(parents=True,exist_ok=True)
        if (folder/'finalize.lock').exists() or (folder/'preregistered.json').exists():
            raise ValueError('Night already preregistered/finalized; no second holdout look')
        rows=refresh_deflation(read_ledger(root))
        # Only fully evaluated, unrejected four-circuit groups can be frozen; checked before any lock is written.
        complete=complete_groups(rows)
        leaders=sorted([r for r in rows if r['night']==night and r['circuit']=='fly' and r['eligible'] and r['group_id'] in complete],
                       key=lambda r:r['score'],reverse=True)[:top]
        group_ids={r['group_id'] for r in leaders}
        selected=[r for r in rows if r['group_id'] in group_ids and not r.get('rejected')]
        version=code_version()
        if any(r['code_version']!=version for r in selected):
            raise ValueError('Code changed since discovery; frozen configuration is not reproducible')
        previous=[]
        for path in (root/'nights').glob('*/preregistered.json'):
            previous+=json.loads(path.read_text())['variants']
        seen={config_hash(r['params'],r['circuit'],version) for r in previous}
        for row in selected:
            identity=config_hash(row['params'],row['circuit'],version)
            if identity in seen:
                raise ValueError('Configuration already preregistered or duplicated; no second holdout look')
            seen.add(identity)
        # Guard every member of selected paired groups before opening any holdout data.
        discovery_frames=None; failed_groups=set()
        for row in selected:
            if (row.get('guard') or {}).get('ok') is True: continue
            if discovery_frames is None:
                discovery_frames={s:load_research_frame(s,discovery_only=True) for s in config.SYMBOLS}
            _,rejected,guard=evaluate_variant(row['circuit'],row['params'],discovery_frames,
                                              check_guard=True,guard_only=True)
            row['guard']=guard
            if rejected or (guard or {}).get('ok') is not True: failed_groups.add(row['group_id'])
        selected=[r for r in selected if r['group_id'] not in failed_groups]
        family=(len(previous)+len(selected))*len(config.SYMBOLS)
        prereg=dict(night=night,family_size=family,created_at=datetime.now(timezone.utc).isoformat(),variants=selected)
        # Exclusive writes and fsync make the one-look guard survive interrupted scoring.
        durable_write(folder/'preregistered.json',dump(prereg)+'\n',mode='x')
        durable_write(folder/'finalize.lock','locked\n',mode='x')
        output=dict(night=night,family_size=family,variants=[])
        if selected:
            frames={s:frame_loader(s) for s in config.SYMBOLS}
            splits={}
            for s,df in frames.items():
                discovery,holdout=split_discovery_holdout(df)
                discovery['session_end']=discovery.session.ne(discovery.session.shift(-1))
                splits[s]=(df,discovery,holdout)
            plan=resolve_plan()
            for row in selected:
                p=row['params']; circuit=build_circuit(row['circuit'],p['hemisphere'],p['seed'])
                outcome=dict(hash=row['hash'],circuit=row['circuit'],params=p,code_version=row['code_version'],per_symbol={})
                for s,(df,discovery,holdout) in splits.items():
                    fitted=fit_frozen(discovery,cached_states(circuit,discovery,p),p)
                    frozen=dict(readout=fitted,normalizer=df.attrs['normalizer'],features=df.attrs['features'],
                                params=p,circuit=row['circuit'],code_version=row['code_version'],symbol=s)
                    artifact=folder/f"{row['hash']}-{s}-frozen.json"
                    artifact.write_text(dump(frozen)+'\n')
                    signal=frozen_signals(cached_states(circuit,holdout,p),p,fitted)
                    result=backtest(holdout,signal,s,p['horizon_bars'])
                    m=result_metrics(result)
                    m['family_ci']=bonferroni_ci(m['inference'],family)
                    m['break_even']=break_even_cost(holdout,signal,s,p['horizon_bars'])
                    prop=prop_lift(result,holdout,plan,p['seed'],s,p['horizon_bars'],eval_fee=row.get('eval_fee',p.get('eval_fee',config.EVAL_FEE)))
                    outcome['per_symbol'][s]=dict(metrics=m,prop=prop,verdict=verdict(m,row['per_symbol'][s]['dsr']['dsr'],prop),
                        frozen_file=artifact.name,frozen_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
                passed=sum(v['verdict']=='CANDIDATE' for v in outcome['per_symbol'].values())
                outcome['verdict']='CANDIDATE' if passed==2 else 'LEAD' if passed==1 else 'NO EDGE'
                output['variants'].append(outcome)
        (folder/'holdout.json').write_text(dump(output)+'\n')
        (folder/'REPORT.md').write_text(report(output,leaderboard(root,True)))
        return output
