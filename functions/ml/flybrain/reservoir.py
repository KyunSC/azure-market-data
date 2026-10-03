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


def pack_sessions(df, gex_off):
    """Session-batched inputs; GEX-off zeroes the dealer/wall inputs but keeps their dimensions."""
    X = input_matrix(df)
    sessions = list(df.groupby('session', sort=False).indices.values())
    width = max(map(len, sessions))
    packed = np.zeros((len(sessions), width, X.shape[1]))
    mask = np.zeros((len(sessions), width), dtype=bool)
    for i, idx in enumerate(sessions):
        packed[i, :len(idx)] = X[idx]
        mask[i, :len(idx)] = True
    if gex_off:
        packed[:, :, [i for i, c in enumerate(df.attrs['features']) if c in GEX_FEATURES]] = 0
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
    """States of the read-out group only, one row per unmasked bar."""
    group = params['readout_from']
    X = np.asarray(X_by_session, dtype=float)
    if circuit is None:
        return {group: X[mask]}
    W = scale_spectral_radius(circuit.W, params['rho'])
    Win = sparse.csr_matrix(input_weights(circuit, X.shape[2], params['seed']) * params['input_gain'])
    state = np.zeros((W.shape[0], len(X)))
    rows = np.cumsum(mask.ravel()).reshape(mask.shape) - 1
    out = np.zeros((int(mask.sum()), len(circuit.groups[group])))
    kc = circuit.groups['kc']
    leak = params['leak']
    sparsity = params.get('kc_sparsity')
    keep = None if sparsity is None else int(np.ceil(sparsity * len(kc)))
    for t in range(X.shape[1]):
        u = np.concatenate((np.maximum(X[:, t], 0), np.maximum(-X[:, t], 0)), axis=1).T
        state = (1 - leak) * state + leak * np.maximum(W @ state + Win @ u, 0)
        if keep is not None:
            values = state[kc]
            losers = np.argsort(values, axis=0, kind='stable')[:len(kc) - keep]
            np.put_along_axis(values, losers, 0, axis=0)
            state[kc] = values
        state[:, ~mask[:, t]] = 0
        if not np.isfinite(state).all():
            raise ValueError('Unstable reservoir')
        live = mask[:, t]
        out[rows[live, t]] = state[circuit.groups[group]][:, live].T
    return {group: out}


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
    X, mask = pack_sessions(df, params.get('gex_off'))
    meta = dict(circuit=circuit.hash if circuit else 'none', symbol=df.attrs.get('symbol'),
                columns=columns, params={k: params.get(k) for k in RESERVOIR_KEYS})
    h = hashlib.sha256(json.dumps(meta, sort_keys=True).encode())
    # Every source that shapes the states belongs in the key, not just this file.
    for module in (Path(__file__), Path(__file__).with_name('connectome.py'), Path(__file__).with_name('features.py')):
        h.update(module.read_bytes())
    h.update(X.tobytes()); h.update(mask.tobytes()); h.update(df.date.astype('int64').to_numpy().tobytes())
    base = config.DATA_DIR / 'states'
    base.mkdir(parents=True, exist_ok=True)
    group = params['readout_from']
    paths = {group: base / f'{h.hexdigest()}-{group}.npy'}
    shapes = {k: (int(mask.sum()), len(circuit.groups[k]) if circuit else X.shape[2]) for k in paths}
    hit = _load_valid(paths, shapes)
    if hit is not None:
        return hit
    states = run_reservoir(circuit, X, mask, params)
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
