"""Fixed-size ETF-to-futures replay; next-open entry and session-close exit."""
from dataclasses import dataclass
import numpy as np
from . import config

@dataclass
class Result:
    equity: np.ndarray
    bar_lo: np.ndarray
    bar_hi: np.ndarray
    bar_open: np.ndarray
    trades: list
    time: np.ndarray
    position: np.ndarray
    initial_capital: float

    @property
    def returns(self):
        return np.r_[0., np.divide(self.equity[1:], self.equity[:-1], out=np.ones(len(self.equity)-1), where=self.equity[:-1] > 0) - 1]


def backtest(df, signal, symbol, contract, n_contracts, max_hold, slippage_ticks=config.SLIPPAGE_TICKS, initial_capital=None, entry_holds=None):
    if len(df) != len(signal) or max_hold < 1 or n_contracts < 1:
        raise ValueError('Invalid signal length, hold or contract count')
    if initial_capital is None:
        from .prop import resolve_plan
        initial_capital = resolve_plan(config.PROP['plan'], config.PROP['size'], config.PROP['dll'])['startBalance']
    spec = config.CONTRACTS[contract]
    scale = config.RATIO[symbol]
    qty = spec['point_value'] * n_contracts
    slip = slippage_ticks * spec['tick']
    fee = config.COMMISSION_PER_SIDE * n_contracts
    n = len(df)
    arrays = [np.zeros(n) for _ in range(4)]
    equity, lo, hi, opening = arrays
    positions = np.zeros(n, dtype=np.int8)
    O,H,L,C = [df[c].to_numpy(float) * scale for c in ('open','high','low','close')]
    sessions = df.session.to_numpy()
    cash, side, pending, entry, entry_price = initial_capital, 0, 0, -1, 0.
    trades=[]
    for i in range(n):
        end = i == n-1 or sessions[i+1] != sessions[i]
        if pending and i and sessions[i] == sessions[i-1]:
            side, entry = pending, i
            entry_price = O[i] + side * slip
            trade_hold = int(entry_holds[i-1]) if entry_holds is not None else max_hold
            cash -= side * qty * entry_price + fee
        pending = 0
        opening[i] = cash + side * qty * O[i]
        low = min(opening[i], cash + side * qty * (L[i] if side > 0 else H[i]))
        high = max(opening[i], cash + side * qty * (H[i] if side > 0 else L[i]))
        if side and (i-entry+1 >= trade_hold or end):
            exit_price = C[i] - side * slip
            cash += side * qty * exit_price - fee
            trades.append(dict(entry_idx=entry, exit_idx=i, entry_price=entry_price, exit_price=exit_price,
                               raw_entry_price=O[entry]/scale, raw_exit_price=C[i]/scale, side=side,
                               pnl=side*qty*(exit_price-entry_price)-2*fee, hold=i-entry+1))
            side=0
        equity[i] = cash + side * qty * C[i]
        lo[i], hi[i] = min(low,equity[i]), max(high,equity[i])
        positions[i]=side
        if not side and not end:
            pending=int(signal[i])
    return Result(equity,lo,hi,opening,trades,df.date.astype('int64').to_numpy()/1e9,positions,initial_capital)
