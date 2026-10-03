"""Session-batched sparse rate reservoir with fixed ON/OFF PN encoding."""
import hashlib
import json
import os
from pathlib import Path
from scipy import sparse
import numpy as np
from . import config
from .connectome import scale_spectral_radius
from .features import GEX_FEATURES, input_matrix

RESERVOIR_KEYS = ('rho', 'leak', 'input_gain', 'kc_sparsity', 'gex_off', 'hemisphere', 'seed')


def pack_sessions(df):
    X = input_matrix(df)
    sessions = list(df.groupby('session', sort=False).indices.values())
    width = max(map(len, sessions))
    packed = np.zeros((len(sessions), width, X.shape[1]))
    mask = np.zeros((len(sessions), width), dtype=bool)
    for i, idx in enumerate(sessions):
        packed[i, :len(idx)] = X[idx]
        mask[i, :len(idx)] = True
    return packed, mask


def input_weights(circuit, n_features, seed):
    rng = np.random.default_rng(seed)
    pn = rng.permutation(circuit.groups['pn'])
    if len(pn) < 2:
        raise ValueError('Need two disjoint PN pools')
    pools = np.array_split(pn, 2)
    W = np.zeros((circuit.W.shape[0], n_features * 2))
    for polarity, pool in enumerate(pools):
        for j in range(n_features):
            pick = rng.choice(pool, max(1, len(pool) // n_features), replace=False)
            W[pick, polarity * n_features + j] = 1 / np.sqrt(len(pick))
    return W


def run_reservoir(circuit, X_by_session, mask, params):
    X = np.array(X_by_session, dtype=float, copy=True)
    if params.get('gex_off'):
        X[:, :, params.get('gex_indices', [])] = 0
    if circuit is None or circuit == 'none':
        flat = X[mask]
        return {'kc': flat, 'mbon': flat}
    W = scale_spectral_radius(circuit.W, params['rho'])
    Win = sparse.csr_matrix(input_weights(circuit, X.shape[2], params.get('seed', 0)) * params['input_gain'])
    state = np.zeros((W.shape[0], len(X)))
    outputs = {k: np.zeros((*mask.shape, len(circuit.groups[k]))) for k in ('kc', 'mbon')}
    kc = circuit.groups['kc']
    leak = params['leak']
    for t in range(X.shape[1]):
        u = np.concatenate((np.maximum(X[:, t], 0), np.maximum(-X[:, t], 0)), axis=1).T
        state = (1 - leak) * state + leak * np.maximum(W @ state + Win @ u, 0)
        if params.get('kc_sparsity') is not None:
            keep = int(np.ceil(params['kc_sparsity'] * len(kc)))
            values = state[kc].copy()
            losers = np.argsort(values, axis=0, kind='stable')[:len(kc) - keep]
            values[losers, np.arange(len(X))[None, :]] = 0
            state[kc] = values
        state[:, ~mask[:, t]] = 0
        if not np.isfinite(state).all():
            raise ValueError('Unstable reservoir')
        for k in outputs:
            outputs[k][:, t] = state[circuit.groups[k]].T
    return {k: v[mask] for k, v in outputs.items()}


def _load_valid(paths, shapes):
    """Return mmapped states only if every file is complete; otherwise None."""
    if not all(path.exists() for path in paths.values()):
        return None
    try:
        loaded = {k: np.load(path, mmap_mode='r') for k, path in paths.items()}
    except (ValueError, OSError, EOFError):
        return None
    return loaded if all(loaded[k].shape == shapes[k] for k in loaded) else None


def cached_states(circuit, df, params):
    columns = df.attrs['features']
    p = dict(params, gex_indices=[i for i, c in enumerate(columns) if c in GEX_FEATURES])
    X, mask = pack_sessions(df)
    meta = dict(circuit=circuit.hash if circuit else 'none', symbol=df.attrs.get('symbol'),
                columns=columns, params={k: params.get(k) for k in RESERVOIR_KEYS})
    h = hashlib.sha256(json.dumps(meta, sort_keys=True).encode())
    # Every source that shapes the states belongs in the key, not just this file.
    for module in (Path(__file__), Path(__file__).with_name('connectome.py'), Path(__file__).with_name('features.py')):
        h.update(module.read_bytes())
    h.update(X.tobytes()); h.update(mask.tobytes()); h.update(df.date.astype('int64').to_numpy().tobytes())
    base = config.DATA_DIR / 'states'
    base.mkdir(parents=True, exist_ok=True)
    paths = {k: base / f'{h.hexdigest()}-{k}.npy' for k in ('kc', 'mbon')}
    width = {k: (len(circuit.groups[k]) if circuit else X.shape[2]) for k in paths}
    shapes = {k: (int(mask.sum()), width[k]) for k in paths}
    hit = _load_valid(paths, shapes)
    if hit is not None:
        return hit
    states = run_reservoir(circuit, X, mask, p)
    for k, path in paths.items():
        # Write beside the target and rename: an interrupted run never leaves a truncated cache file.
        tmp = path.with_name(path.name + f'.{os.getpid()}.tmp')
        try:
            with tmp.open('wb') as f:
                np.save(f, states[k], allow_pickle=False)
            os.replace(tmp, path)
        finally:
            tmp.unlink(missing_ok=True)
    return {k: np.load(path, mmap_mode='r') for k, path in paths.items()}
