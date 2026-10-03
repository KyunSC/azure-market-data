"""The only Flybrain module permitted to load sealed-period rows.

Only verify() invokes the loader, after a durable one-look attempt record.
The research feature loader never imports this module.
"""
from datetime import date, datetime, timezone
import hashlib
import json
from pathlib import Path
import numpy as np
import pandas as pd
from . import config


def _load_verify_frame(symbol,frozen):
    from holdout import VERIFY_START
    from gex_vol_study import BARS_DIR,ET,GEX_DIR,TD_ROOT,aggregate_5m,day_iv,lagged_log_rv,lagged_returns
    from .features import assemble_frame, normalize_sessions, OPTIONAL_FEATURES
    iv_root=TD_ROOT/'iv_5m'/f'symbol={symbol}'
    days=sorted(date.fromisoformat(p.name[5:]) for p in iv_root.glob('date=*') if (p/'part.parquet').exists())
    before=[d for d in days if d<VERIFY_START.date()]
    if len(before)<config.WARMUP_SESSIONS: raise ValueError('Insufficient verify warmup sessions')
    lower=pd.Timestamp(before[-config.WARMUP_SESSIONS],tz=ET).tz_convert('UTC')
    # Row-level lower-bound filters apply before any file's rows are materialized.
    files=sorted((BARS_DIR/symbol).glob('*.parquet'))
    m=pd.concat([pd.read_parquet(f,columns=['open','high','low','close','volume'],filters=[('ts_event','>=',lower)]) for f in files])
    bars=aggregate_5m(m)
    snaps=pd.read_parquet(GEX_DIR/f'{symbol.lower()}_gex_snapshots.parquet',filters=[('computed_at','>=',lower)])
    snaps['computed_at']=pd.to_datetime(snaps.computed_at,utc=True).astype('datetime64[ns, UTC]')
    assert (bars.date>=lower).all() and (snaps.computed_at>=lower).all()
    optional=None
    if any(c in OPTIONAL_FEATURES for c in frozen['features']):
        t=snaps.sort_values('computed_at').computed_at.reset_index(drop=True)
        optional=pd.concat([pd.DataFrame({'date':t}),lagged_log_rv(bars,t),lagged_returns(bars,t)],axis=1)
        if any(c.startswith('log_iv') for c in frozen['features']):
            first=lower.tz_convert(ET).date()
            rows=[r for d in days if d>=first for r in day_iv(symbol,d)]
            if not rows: raise ValueError('Verify IV features required by frozen schema are missing')
            iv=pd.DataFrame(rows).set_index('computed_at').reindex(pd.DatetimeIndex(t))
            optional['log_iv_front']=np.log(iv.iv_front.to_numpy())
            optional['log_iv_0dte']=np.nan_to_num(np.log(iv.iv_0dte.to_numpy()))
    df=assemble_frame(bars,snaps,optional)
    if any(c not in df for c in frozen['features']): raise ValueError('Frozen feature schema unavailable')
    df=normalize_sessions(df,frozen['features'],frozen=frozen['normalizer'])
    df=df[df.date>=VERIFY_START].reset_index(drop=True)
    if df.empty: raise ValueError('No sealed verify rows available')
    assert (df.date>=VERIFY_START).all()
    df.attrs.update(features=frozen['features'],symbol=symbol)
    return df


def verify(config_hash,runs_dir=config.RUNS_DIR,loader=None,scorer=None):
    from .search import ledger_lock,dump,code_version,durable_write,read_jsonl
    root=Path(runs_dir)
    with ledger_lock(root):
        log=root/'verify_log.jsonl'
        attempts=read_jsonl(log)
        if any(r['hash']==config_hash for r in attempts): raise ValueError('Verify already attempted for this hash')
        match=None; folder=None
        for path in (root/'nights').glob('*/holdout.json'):
            for row in json.loads(path.read_text())['variants']:
                if row['hash']==config_hash:
                    match=row; folder=path.parent
        if match is None or match['verdict'] not in ('CANDIDATE','LEAD') or not (folder/'finalize.lock').exists():
            raise ValueError('Verify requires a finalized CANDIDATE or LEAD')
        if match['code_version']!=code_version(): raise ValueError('Code differs from the preregistered version')
        artifacts={}
        for s,r in match['per_symbol'].items():
            path=folder/r['frozen_file']
            if path.parent!=folder or hashlib.sha256(path.read_bytes()).hexdigest()!=r['frozen_sha256']:
                raise ValueError('Frozen artifact integrity check failed')
            artifacts[s]=json.loads(path.read_text())
        def append(row): durable_write(log,dump(row)+'\n')
        append(dict(hash=config_hash,ts=datetime.now(timezone.utc).isoformat(),status='started'))
        try:
            outcomes={}
            for s,frozen in artifacts.items():
                df=(loader or _load_verify_frame)(s,frozen)
                outcomes[s]=(scorer or _score_verify)(df,frozen)
            result=dict(hash=config_hash,ts=datetime.now(timezone.utc).isoformat(),status='complete',per_symbol=outcomes)
            append(result)
            return result
        except Exception as exc:
            append(dict(hash=config_hash,ts=datetime.now(timezone.utc).isoformat(),status='failed',error_type=type(exc).__name__))
            raise


def _score_verify(df,frozen):
    from .connectome import build_circuit
    from .reservoir import cached_states
    from .readout import frozen_signals
    from .engine import backtest
    from .search import result_metrics
    from .prop import resolve_plan,run_prop
    p=frozen['params']
    c=build_circuit(frozen['circuit'],p['hemisphere'],p['seed'])
    signal=frozen_signals(cached_states(c,df,p),p,frozen['readout'])
    r=backtest(df,signal,frozen['symbol'],p['horizon_bars'])
    return dict(metrics=result_metrics(r),prop=run_prop(r,plan=resolve_plan(),seed=p['seed'],keep_attempts=False))


if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser(description=__doc__); p.add_argument('hash'); p.add_argument('--runs-dir',type=Path,default=config.RUNS_DIR)
    a=p.parse_args(); print(verify(a.hash,a.runs_dir))
