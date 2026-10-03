"""Faithful Lucid replay port. Rule values come only from exported JS fixtures."""
from collections import Counter
from functools import lru_cache
from itertools import accumulate
import json
import math
from pathlib import Path
import numpy as np
from . import config

EPS=1e-9


@lru_cache(maxsize=None)
def _plans():
    return json.loads((Path(__file__).parent/'fixtures'/'lucid_plans.json').read_text())['plans']


def resolve_plan(plan=config.PROP['plan'], size=config.PROP['size'], dll=config.PROP['dll']):
    return dict(next(p for p in _plans() if p['plan']==plan and p['size']==size and p['dll']==dll))


def mulberry32(a):
    def rand():
        nonlocal a
        a=(a+0x6d2b79f5)&0xffffffff
        t=((a^(a>>15))*(1|a))&0xffffffff
        t=((t+(((t^(t>>7))*(61|t))&0xffffffff))&0xffffffff)^t
        return ((t^(t>>14))&0xffffffff)/4294967296
    return rand


def nth(values,k):
    return values[min(k,len(values)-1)] if values else None


def build_day_table(result, time=None, initial_capital=None):
    def get(camel,snake):
        if isinstance(result,dict): return result.get(camel)
        return getattr(result,snake)
    equity=np.asarray(get('equity','equity')); n=len(equity)
    time=np.asarray(time if time is not None else get('time','time'))
    capital=initial_capital if initial_capital is not None else get('initialCapital','initial_capital')
    # Exact time.js convention: roll at 22:00 UTC in either DST regime.
    day=np.floor((time+7200)/86400)
    starts=np.r_[0,np.flatnonzero(day[1:]!=day[:-1])+1]
    ends=np.r_[starts[1:]-1,n-1]
    # Each day's values are relative to the previous day's closing equity.
    base=np.repeat(np.r_[capital,equity[starts[1:]-1]],ends-starts+1)
    lo,hi,op,close=(np.asarray(get(camel,snake))-base for camel,snake in
                    (('barLo','bar_lo'),('barHi','bar_hi'),('barOpen','bar_open'),('equity','equity')))
    flag=(np.abs(hi-lo)>EPS)|(np.abs(close)>EPS)|(np.abs(op)>EPS)
    # Lists: run_stage indexes these per bar inside every bootstrap path.
    return dict(n=len(starts),start=starts.tolist(),end=ends.tolist(),active=np.logical_or.reduceat(flag,starts).astype(int).tolist(),
                time=time[starts].tolist(),lo=lo.tolist(),hi=hi.tolist(),open=op.tolist(),close=close.tolist(),
                min_lo=np.minimum.reduceat(lo,starts).tolist())


def run_stage(days,next_day,k0,plan,stage):
    start=plan['startBalance']; lock_at=start+plan['lockOffset']
    intraday=stage=='funded' and plan['fundedDrawdown']=='intraday'
    dll=plan['dailyLossLimit'] or 0
    bal=peak=start; locked=False; threshold=min(peak-plan['maxLoss'],lock_at)
    active_days=best_day=dll_hits=cycle_active=cycle_profit_days=cycle_best=0
    cycle_start=start; payouts=[]
    def done(status,reason,k):
        return dict(status=status,reason=reason,days=k-k0,payouts=payouts,dllHits=dll_hits,balance=bal)
    k=k0
    while True:
        d=next_day(k)
        if d<0: return done('open','end-of-data',k)
        s,e=days['start'][d],days['end'][d]
        day_base=bal; dll_level=day_base-dll if dll else -math.inf; pnl=None
        safe = not intraday and day_base + days['min_lo'][d] > max(threshold, dll_level)
        for i in (() if safe else range(s,e+1)):
            if intraday and not locked:
                peak=max(peak,day_base+days['hi'][i]); threshold=min(peak-plan['maxLoss'],lock_at)
            worst=day_base+days['lo'][i]
            if dll and worst<=dll_level and dll_level>threshold:
                frozen=min(dll_level,day_base+days['open'][i]); dll_hits+=1
                if frozen<=threshold:
                    bal=frozen
                    return done('breached','max-loss',k+1)
                pnl=frozen-day_base
                break
            if worst<=threshold:
                bal=min(threshold,day_base+days['open'][i])
                return done('breached','max-loss',k+1)
        if pnl is None: pnl=days['close'][e]
        bal=day_base+pnl; act=days['active'][d]==1
        if act: active_days+=1
        if not locked:
            peak=max(peak,bal); threshold=min(peak-plan['maxLoss'],lock_at)
        if stage=='eval':
            best_day=max(best_day,pnl); profit=bal-start
            if active_days>=plan['evalMinDays'] and profit>=plan['profitTarget'] and (not plan['evalConsistency'] or best_day<=plan['evalConsistency']*profit+EPS):
                return done('passed','target',k+1)
            k+=1
            continue
        if act: cycle_active+=1
        if act and pnl>0 and pnl>=plan['minDayProfit']: cycle_profit_days+=1
        cycle_best=max(cycle_best,pnl); cycle_profit=bal-cycle_start; idx=len(payouts)
        goal=nth(plan['profitGoal'],idx) or 0
        eligible=(cycle_active>=plan['fundedMinDays'] and cycle_profit_days>=plan['minProfitDays'] and cycle_profit>0 and cycle_profit>=goal
            and (not plan['fundedConsistency'] or cycle_best<=plan['fundedConsistency']*cycle_profit+EPS) and (not plan['buffer'] or bal>plan['buffer']))
        if eligible:
            amount=plan['payoutFraction']*(bal-start) if plan['payoutFraction'] is not None else bal-max(plan['buffer'] or 0,start)
            cap=nth(plan['payoutCap'],idx)
            if cap is not None and cap>0: amount=min(amount,cap)
            amount=math.floor(amount)
            if amount>=plan['minPayout']:
                payouts.append(amount); bal-=amount; locked=True; threshold=lock_at
                cycle_start=bal; cycle_active=cycle_profit_days=cycle_best=0
                if len(payouts)>=plan['maxPayouts']: return done('graduated','max-payouts',k+1)
        k+=1


def simulate_account(days,next_day,plan):
    out=dict(outcome=None,reason=None,evalDays=0,fundedDays=0,payouts=[],take=0,daysUsed=0,dllHits=0)
    k=0
    if plan['hasEval']:
        ev=run_stage(days,next_day,0,plan,'eval'); out['evalDays']=ev['days']; out['dllHits']+=ev['dllHits']; k=ev['days']
        if ev['status']!='passed':
            out.update(outcome='failed' if ev['status']=='breached' else 'eval-open',reason=ev['reason'],daysUsed=k)
            return out
    fu=run_stage(days,next_day,k,plan,'funded')
    out.update(fundedDays=fu['days'],dllHits=out['dllHits']+fu['dllHits'],payouts=fu['payouts'],
        outcome='funded-breached' if fu['status']=='breached' else 'graduated' if fu['status']=='graduated' else 'funded-open',
        reason=fu['reason'],take=plan['split']*sum(fu['payouts']),daysUsed=k+fu['days'])
    return out


def summarize_attempts(attempts,plan):
    mean=lambda a:sum(a)/len(a) if len(a) else math.nan
    pct=lambda a,q:float(np.quantile(a,q)) if len(a) else math.nan
    cost=plan['price']+(plan['activationFee'] or 0)
    resolved=[a for a in attempts if a['outcome']!='eval-open']; passed=[a for a in resolved if a['outcome']!='failed']
    outcomes=dict(Counter(a['outcome'] for a in attempts))
    days=sorted(a['evalDays'] for a in passed); rate=len(passed)/len(resolved) if resolved else math.nan
    take=mean([a['take'] for a in resolved]); nets=sorted(a['take']-cost for a in resolved)
    cash=[a for a in resolved if math.isfinite(a.get('cashPnl',math.nan))]
    return dict(attempts=len(attempts),resolved=len(resolved),censored=len(attempts)-len(resolved),fundedOpen=outcomes.get('funded-open',0),outcomes=outcomes,
        passRate=rate,medianDaysToPass=pct(days,.5),pPayout=mean([int(bool(a['payouts'])) for a in resolved]),
        meanPayouts=mean([len(a['payouts']) for a in resolved]),meanTake=take,cost=cost,ev=take-cost,
        evP05=pct(nets,.05),evP50=pct(nets,.5),evP95=pct(nets,.95),costPerFunded=cost/rate if rate>0 else math.inf,
        meanDaysUsed=mean([a['daysUsed'] for a in resolved]),meanCashPnl=mean([a['cashPnl'] for a in cash]),
        dllHitRate=mean([a['dllHits']/max(1,a['daysUsed']) for a in resolved]),nets=nets)


def run_prop(result,time=None,plan=None,initial_capital=None,paths=config.PROP['paths'],block_size=config.PROP['block'],
             horizon=config.PROP['horizon'],seed=config.PROP['seed'],keep_attempts=True,replay_history=True):
    """replay_history=False skips the per-start-day replay; the bootstrap is unaffected."""
    plan=plan or resolve_plan()
    days=build_day_table(result,time,initial_capital)
    cum=[0.,*accumulate(days['close'][e] for e in days['end'])]
    historical=[]
    for s in range(days['n']) if replay_history else ():
        a=simulate_account(days,lambda k:s+k if s+k<days['n'] else -1,plan)
        a.update(startDay=s,startTime=days['time'][s],cashPnl=cum[min(days['n'],s+max(1,a['daysUsed']))]-cum[s])
        historical.append(a)
    boot=None
    if days['n']>=2:
        rng=mulberry32(seed); bl=max(1,min(block_size,days['n'])); attempts=[]
        for _ in range(paths):
            seq=[]
            def next_day(k):
                while len(seq)<=k:
                    if len(seq)>=horizon: return -1
                    b=math.floor(rng()*max(1,days['n']-bl+1))
                    for j in range(bl):
                        if len(seq)<horizon: seq.append((b+j)%days['n'])
                return seq[k]
            attempts.append(simulate_account(days,next_day,plan))
        boot=summarize_attempts(attempts,plan); boot.update(paths=paths,blockSize=bl,horizon=horizon)
    hist=summarize_attempts(historical,plan) if replay_history else None
    if replay_history and keep_attempts:
        keys=['startDay','startTime','outcome','reason','evalDays','fundedDays','payouts','take','cashPnl','dllHits']
        hist['list']=[{k:a[k] for k in keys} for a in historical]
    return dict(plan=plan,days=days['n'],activeDays=sum(days['active']),meanDayPnl=cum[-1]/days['n'],cashPnl=cum[-1],historical=hist,bootstrap=boot)


def random_entry_signal(df,trades,seed):
    """Match each session's count and realized holds without overlapping positions."""
    rng=np.random.default_rng(seed); signal=np.zeros(len(df),dtype=np.int8); entry_holds=np.zeros(len(df),dtype=int)
    by_session={}
    sid=df.session.to_numpy()
    for trade in trades:
        by_session.setdefault(sid[trade['entry_idx']],[]).append(trade['hold'])
    # Gap composition gives a uniform placement of fixed-length intervals, shuffled holds.
    for session, idx in df.groupby('session',sort=False).indices.items():
        holds=by_session.get(session,[]).copy()
        if not holds: continue
        rng.shuffle(holds)
        slack=len(idx)-1-sum(holds)
        if slack<0: raise ValueError('Control trade count cannot fit session')
        cuts=np.sort(rng.choice(slack+len(holds),len(holds),replace=False))
        gaps=np.diff(np.r_[-1,cuts,slack+len(holds)])-1
        cursor=int(idx[0])+int(gaps[0])
        for j,h in enumerate(holds):
            signal[cursor]=rng.choice([-1,1]); entry_holds[cursor]=h; cursor+=h+int(gaps[j+1])
    return signal,entry_holds


def prop_lift(result,df,plan,seed,symbol,max_hold,eval_fee=config.EVAL_FEE):
    from .engine import backtest
    opts=dict(plan=plan,seed=seed,keep_attempts=False,replay_history=False)
    nan=dict(p_pass_eval=math.nan,p_payout=math.nan,e_take=math.nan,lift=math.nan,lift_ci=[math.nan,math.nan])
    if not result.trades: return nan
    actual=run_prop(result,**opts)['bootstrap']
    if actual is None or not math.isfinite(actual['passRate']): return nan
    controls=[]
    for k in range(config.CONTROL_SEEDS):
        signal,holds=random_entry_signal(df,result.trades,seed+k+1)
        control=backtest(df,signal,symbol,max_hold,entry_holds=holds)
        assert len(control.trades)==len(result.trades)
        assert sorted(t['hold'] for t in control.trades)==sorted(t['hold'] for t in result.trades)
        replay=run_prop(control,**opts)['bootstrap']
        controls.append(replay['passRate'])
    if not np.isfinite(controls).all():
        ci=[math.nan,math.nan]; lift=math.nan
    else:
        lift=actual['passRate']-float(np.mean(controls))
        rng=np.random.default_rng(seed)
        means=np.mean(rng.choice(controls,size=(config.BOOTSTRAP_SAMPLES,len(controls)),replace=True),axis=1)
        ci=np.quantile(actual['passRate']-means,[.025,.975]).tolist()
    return dict(p_pass_eval=actual['passRate'],p_payout=actual['pPayout'],e_take=actual['meanTake']-eval_fee,lift=lift,lift_ci=ci)
