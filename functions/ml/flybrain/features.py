"""Bounded research reads and prior-session-only feature normalization."""
import logging
import numpy as np
import pandas as pd
from . import config
from eval import session_ids

PRICE_FEATURES = ['log_return_5m', 'log_return_15m', 'log_return_30m', 'log_return_60m',
    'realized_vol_60m', 'range_atr', 'volume_zscore_20', 'close_position', 'close_vs_sma20',
    'rsi_14', 'minutes_since_open', 'hour_sin', 'hour_cos']
OPTIONAL_FEATURES = ['log_iv_front', 'log_iv_0dte', 'log_rv_lag30m', 'log_rv_lag1d', 'log_rv_lag5d', 'ret_1d', 'ret_5d']
GEX_FEATURES = ['gex_regime', 'gex_slog', 'above_zero_gamma', 'zero_gamma_dist', 'gex_0dte_slog',
    'vex_slog', 'cex_slog', 'vex_0dte_slog', 'cex_0dte_slog', 'dist_call_wall_atr',
    'dist_put_wall_atr', 'dist_zero_gamma_atr', 'gamma_regime_strength']


def normalize_sessions(df, columns, warmup=config.WARMUP_SESSIONS, frozen=None):
    """Keep OHLC/raw features intact; normalized inputs are named z_<feature>."""
    out = df.copy()
    x = out[columns].replace([np.inf, -np.inf], np.nan).to_numpy(float)
    z = np.zeros_like(x)
    count = np.zeros(len(columns)); total = count.copy(); square = count.copy()
    sessions = pd.unique(out.session)
    for i, sid in enumerate(sessions):
        idx = np.flatnonzero(out.session.to_numpy() == sid)
        if frozen is None:
            mean = np.divide(total, count, out=np.zeros_like(total), where=count > 0)
            var = np.divide(square, count, out=np.zeros_like(square), where=count > 0) - mean ** 2
            scale = np.sqrt(np.maximum(var, 0))
            scale[scale < 1e-12] = 1
        else:
            mean, scale = np.array(frozen['mean']), np.array(frozen['scale'])
        z[idx] = np.nan_to_num(np.clip((x[idx] - mean) / scale, -5, 5))
        valid = np.isfinite(x[idx])
        count += valid.sum(axis=0)
        total += np.nansum(x[idx], axis=0)
        square += np.nansum(x[idx] ** 2, axis=0)
    for j, c in enumerate(columns):
        out['z_' + c] = z[:, j]
    mean = np.divide(total, count, out=np.zeros_like(total), where=count > 0)
    scale = np.sqrt(np.maximum(np.divide(square, count, out=np.zeros_like(square), where=count > 0) - mean ** 2, 0))
    scale[scale < 1e-12] = 1
    out.attrs['normalizer'] = dict(columns=columns, mean=mean.tolist(), scale=scale.tolist())
    out.attrs['features'] = columns
    if frozen is None:
        out = out[out.session.isin(sessions[warmup:])].copy()
    return out.reset_index(drop=True)


def assemble_frame(bars, snaps, optional=None):
    from build_dataset import compute_baseline_features, asof_join_gex, compute_gex_features
    from gex_vol_study import dealer_features
    df = compute_gex_features(asof_join_gex(compute_baseline_features(bars), snaps))
    dealer = dealer_features(df)
    for c in dealer:
        df[c] = dealer[c]
    df['range_atr'] = (df.high - df.low) / df.atr_14.replace(0, np.nan)
    local = df.date.dt.tz_convert('America/New_York')
    df['minutes_since_open'] = local.dt.hour * 60 + local.dt.minute - 570
    if optional is not None:
        cols = [c for c in OPTIONAL_FEATURES if c in optional]
        df = pd.merge_asof(df.sort_values('date'), optional[['date'] + cols].sort_values('date'),
                           on='date', direction='backward', tolerance=pd.Timedelta(minutes=15))
    df['session'] = session_ids(df.date)
    assert (df.computed_at <= df.date).all(), 'Future GEX joined'
    assert df.groupby('session').size().max() <= config.BARS_PER_SESSION
    return df


def research_bounds(symbol):
    from gex_vol_study import research_cutoff
    from holdout import VERIFY_START
    days, cutoff = research_cutoff(symbol)
    assert cutoff < VERIFY_START
    # Reserve 20 initial sessions for normalization before splitting.
    split = config.WARMUP_SESSIONS + int((len(days) - config.WARMUP_SESSIONS) * config.DISCOVERY_FRAC)
    discovery_end = pd.Timestamp(days[split], tz='America/New_York').tz_convert('UTC')
    return days, cutoff, discovery_end


def load_research_frame(symbol, discovery_only=False):
    from gex_vol_study import load_bars, load_snapshots
    if symbol not in config.SYMBOLS:
        raise ValueError(symbol)
    _, cutoff, discovery_end = research_bounds(symbol)
    end = min(cutoff, discovery_end) if discovery_only else cutoff
    bars, snaps = load_bars(symbol, end), load_snapshots(symbol, end)
    assert (bars.date < end).all() and (snaps.computed_at < end).all()
    path = config.ML_DIR / 'data' / 'gex_vol' / f'frame_{symbol.lower()}.parquet'
    optional = None
    if path.exists():
        import pyarrow.parquet as pq
        cols = [c for c in OPTIONAL_FEATURES if c in pq.read_schema(path).names]
        optional = pd.read_parquet(path, columns=['date'] + cols, filters=[('date', '<', end)])
        assert (optional.date < end).all()
    else:
        logging.warning('%s optional IV/RV cache absent; omitting those inputs', symbol)
    df = assemble_frame(bars, snaps, optional)
    columns = PRICE_FEATURES + [c for c in OPTIONAL_FEATURES if c in df] + GEX_FEATURES
    df = normalize_sessions(df, columns)
    assert (df.date < cutoff).all()
    df.attrs.update(symbol=symbol, cutoff=cutoff.isoformat(), discovery_end=discovery_end.isoformat())
    return df


def split_discovery_holdout(df):
    if 'discovery_end' in df.attrs:
        mask = df.date < pd.Timestamp(df.attrs['discovery_end'])
    else:
        sessions = pd.unique(df.session)
        mask = df.session.isin(sessions[:int(len(sessions) * config.DISCOVERY_FRAC)])
    return df[mask].reset_index(drop=True), df[~mask].reset_index(drop=True)


def input_matrix(df):
    return df[['z_' + c for c in df.attrs['features']]].to_numpy(float)
