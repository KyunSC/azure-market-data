"""Purged walk-forward readouts. Frozen fold schedules survive prefix probes."""
from bisect import insort
import hashlib
import numpy as np
import pandas as pd
from sklearn.linear_model import Ridge
from build_dataset import compute_target, TARGET_COL
from eval import session_folds
from . import config


def fold_schedule(df, horizon):
    target = compute_target(df, horizon)
    folds = session_folds(target, n_splits=config.WF_SPLITS, embargo_sessions=config.EMBARGO_SESSIONS)
    return [{'train_end': df.date.iloc[tr[-1]].isoformat(), 'start': df.date.iloc[te[0]].isoformat(),
             'end': df.date.iloc[te[-1]].isoformat()} for tr, te in folds]


def fold_indices(df, params):
    target = compute_target(df, params['horizon_bars'])
    schedule = df.attrs.get('fold_schedule') or fold_schedule(df, params['horizon_bars'])
    folds = []
    for f in schedule:
        train = np.flatnonzero(((df.date <= pd.Timestamp(f['train_end'])) &
            (target.target_time < pd.Timestamp(f['start'])) & target[TARGET_COL].notna()).to_numpy())
        test = np.flatnonzero(((df.date >= pd.Timestamp(f['start'])) & (df.date <= pd.Timestamp(f['end']))).to_numpy())
        if len(test):
            folds.append((train, test))
    return target, folds


def fit_ridge(X, y, params):
    model = Ridge(alpha=params['ridge_lambda'], solver='lsqr', tol=1e-6).fit(X, y)
    threshold = float(np.quantile(np.abs(model.predict(X)), params['threshold_q']))
    return model, threshold


def signals_from_predictions(pred, threshold):
    return np.where(pred > threshold, 1, np.where(pred < -threshold, -1, 0)).astype(np.int8)


def dan_path(df, X, params, initial=None):
    """Reward arrives only at an actual next-open trade's closing bar.

    Seeded small initial weights break the zero-weight/no-trade fixed point.
    The reward is signed ETF points divided by entry ATR. No future target is used.
    Reinforcement strengthens the association between the entry pattern and the action
    taken, so the update is lr * side * pattern * reward: a winning short pushes w.s
    further negative and a losing long weakens w.s, with no side-dependent asymmetry.
    """
    w = np.random.default_rng(params['seed']).normal(0, 1e-4, X.shape[1]) if initial is None else initial.copy()
    predictions = np.zeros(len(df)); signal = np.zeros(len(df), dtype=np.int8)
    position = None
    pending = 0
    close = df.close.to_numpy(); op = df.open.to_numpy(); sid = df.session.to_numpy()
    atr = df.atr_14.to_numpy() if 'atr_14' in df else np.ones(len(df))
    history = []
    ends = df.session_end.to_numpy(bool) if 'session_end' in df else np.r_[sid[:-1] != sid[1:], True]
    for i in range(len(df)):
        end = bool(ends[i])
        if pending and i and sid[i] == sid[i - 1]:
            position = (i, op[i], pending, X[i - 1].copy(), max(float(atr[i - 1]), 1e-8))
        pending = 0
        if position is not None:
            entry, price, side, pattern, scale = position
            if i - entry + 1 >= params['horizon_bars'] or end:
                reward = side * (close[i] - price) / scale
                w = (1 - config.DAN_DECAY) * w + params['dan_lr'] * side * pattern * reward
                position = None
        predictions[i] = X[i] @ w
        if history:
            q = (len(history) - 1) * params['threshold_q']
            lo = int(q); hi = min(lo + 1, len(history) - 1)
            thr = history[lo] + (q - lo) * (history[hi] - history[lo])
        else:
            thr = 0.
        action = int(signals_from_predictions(predictions[i], thr))
        signal[i] = action
        if position is None and not end:
            pending = action
        insort(history, abs(predictions[i]))
    return predictions, signal, w


def oos_signals(df, states, params, diagnostics=None, model_cache=None):
    X = np.asarray(states[params['readout_from']])
    target, folds = fold_indices(df, params)
    signal = np.zeros(len(df), dtype=np.int8)
    fold_id = np.full(len(df), -1, dtype=int)
    if params['readout'] == 'dan':
        _, all_signals, _ = dan_path(df, X, params)
        for k, (_, te) in enumerate(folds):
            signal[te], fold_id[te] = all_signals[te], k
        return signal, fold_id
    for k, (tr, te) in enumerate(folds):
        if not len(tr):
            continue
        train_X = np.ascontiguousarray(X[tr], dtype=float)
        train_y = np.ascontiguousarray(target[TARGET_COL].to_numpy()[tr], dtype=float)
        digest = hashlib.sha256(train_X.tobytes() + train_y.tobytes()).hexdigest()
        key = (train_X.shape, digest, params['ridge_lambda'], params['threshold_q'])
        if model_cache is not None and key in model_cache:
            model, thr = model_cache[key]
        else:
            model, thr = fit_ridge(X[tr], target[TARGET_COL].to_numpy()[tr], params)
            if model_cache is not None:
                model_cache[key] = (model, thr)
        signal[te] = signals_from_predictions(model.predict(X[te]), thr)
        fold_id[te] = k
        if diagnostics is not None:
            diagnostics.append(dict(threshold=thr, train=tr, test=te))
    return signal, fold_id


def fit_frozen(df, states, params):
    X = np.asarray(states[params['readout_from']])
    if params['readout'] == 'dan':
        _, _, w = dan_path(df, X, params)
        return dict(coef=w, intercept=0., threshold=float(np.quantile(abs(X @ w), params['threshold_q'])))
    target = compute_target(df, params['horizon_bars'])
    valid = target[TARGET_COL].notna().to_numpy()
    model, thr = fit_ridge(X[valid], target[TARGET_COL].to_numpy()[valid], params)
    return dict(coef=model.coef_, intercept=float(model.intercept_), threshold=thr)


def frozen_signals(states, params, fitted):
    pred = np.asarray(states[params['readout_from']]) @ np.asarray(fitted['coef']) + fitted['intercept']
    return signals_from_predictions(pred, fitted['threshold'])
