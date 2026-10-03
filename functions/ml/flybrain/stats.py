"""Numerical port of frontend/lib/backtest/stats.js."""
import math
import numpy as np
from . import config


def norm_cdf(x):
    if x == math.inf: return 1.
    if x == -math.inf: return 0.
    t = 1 / (1 + 0.3275911 * abs(x) / math.sqrt(2))
    y = 1 - ((((1.061405429*t - 1.453152027)*t + 1.421413741)*t - .284496736)*t + .254829592)*t*math.exp(-x*x/2)
    return .5*(1+y) if x >= 0 else .5*(1-y)


def norm_inv(p):
    if p <= 0: return -math.inf
    if p >= 1: return math.inf
    a=[-39.69683028665376,220.9460984245205,-275.9285104469687,138.357751867269,-30.66479806614716,2.506628277459239]
    b=[-54.47609879822406,161.5858368580409,-155.6989798598866,66.80131188771972,-13.28068155288572]
    c=[-.007784894002430293,-.3223964580411365,-2.400758277161838,-2.549732539343734,4.374664141464968,2.938163982698783]
    d=[.007784695709041462,.3224671290700398,2.445134137142996,3.754408661907416]
    if p < .02425:
        q=math.sqrt(-2*math.log(p))
        return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
    if p > 1-.02425: return -norm_inv(1-p)
    q=p-.5; r=q*q
    return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1)


def moments(returns):
    n=len(returns)
    if n<2: return dict(n=n,mean=0.,sd=0.,skew=0.,kurt=3.)
    m=sum(returns)/n
    m2=m3=m4=0.
    for x in returns:
        d=x-m; d2=d*d
        m2+=d2; m3+=d2*d; m4+=d2*d2
    m2/=n; m3/=n; m4/=n
    sd=math.sqrt(m2)
    return dict(n=n,mean=m,sd=math.sqrt(m2*n/(n-1)),skew=m3/sd**3 if sd>0 else 0.,kurt=m4/m2**2 if sd>0 else 3.)


def sharpe_se(sr,n,skew,kurt):
    return math.sqrt(max(1-skew*sr+(kurt-1)/4*sr*sr,0)/(n-1)) if n>=2 else math.nan


def sharpe_inference(returns, ppy=config.PPY, z=1.959963984540054):
    m=moments(returns); sr=m['mean']/m['sd'] if m['sd']>0 else 0
    se=sharpe_se(sr,m['n'],m['skew'],m['kurt']); ann=math.sqrt(ppy)
    return dict(n=m['n'],sr=sr,se=se,skew=m['skew'],kurt=m['kurt'],sharpe=sr*ann,
                ci=[(sr-z*se)*ann,(sr+z*se)*ann],psr=norm_cdf(sr/se) if math.isfinite(se) and se>0 else math.nan)


def expected_max_sharpe(trials, trial_var):
    if not trials>1 or not trial_var>0: return 0.
    gamma=.5772156649015329
    return math.sqrt(trial_var)*((1-gamma)*norm_inv(1-1/trials)+gamma*norm_inv(1-1/(trials*math.e)))


def deflated_sharpe(inference, trial_srs):
    n=len(trial_srs); var=0.
    if n>1:
        mean=sum(trial_srs)/n; var=sum((s-mean)**2 for s in trial_srs)/(n-1)
    sr0=expected_max_sharpe(n,var)
    se=sharpe_se(inference['sr'],inference['n'],inference['skew'],inference['kurt'])
    return dict(trials=n,sr0=sr0,dsr=norm_cdf((inference['sr']-sr0)/se) if math.isfinite(se) and se>0 else math.nan)


def bonferroni_ci(inference, family_size, alpha=config.GATES['family_alpha']):
    z=norm_inv(1-alpha/(2*max(1,family_size)))
    return [(inference['sr']+s*z*inference['se'])*math.sqrt(config.PPY) for s in (-1,1)]


def break_even_cost(df, signal, symbol, contract, n_contracts, max_hold):
    from .engine import backtest
    curve=[]
    for ticks in range(5):
        r=backtest(df,signal,symbol,contract,n_contracts,max_hold,slippage_ticks=ticks)
        pnl=float(r.equity[-1]-r.initial_capital)
        curve.append(pnl)
        if not pnl>0:
            if ticks==0: return 0.
            if not math.isfinite(pnl): return float(ticks-1)
            return ticks-1+curve[-2]/(curve[-2]-pnl)
    return math.inf
