"""FlyWire v783 MB selection and matched wiring controls; no market data access."""
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import logging
from pathlib import Path
import urllib.request

import numpy as np
import pandas as pd
from scipy import sparse
from scipy.sparse.linalg import eigs
from . import config

LOG = logging.getLogger(__name__)
URLS = {
    'Connectivity_783.parquet': 'https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/Connectivity_783.parquet',
    'Completeness_783.csv': 'https://raw.githubusercontent.com/philshiu/Drosophila_brain_model/main/Completeness_783.csv',
    'Supplemental_file1_neuron_annotations.tsv': 'https://raw.githubusercontent.com/flyconnectome/flywire_annotations/main/supplemental_files/Supplemental_file1_neuron_annotations.tsv',
}
SIGNS = {'acetylcholine': 1, 'gaba': -1, 'glutamate': -1, 'dopamine': 0, 'serotonin': 0, 'octopamine': 0}
_RADIUS = {}


def fetch():
    """Populate missing files only and validate cached ones; never overwrites source data."""
    import pyarrow.parquet as pq
    base = config.DATA_DIR / 'flywire'
    base.mkdir(parents=True, exist_ok=True)
    mp = base / 'manifest.json'
    manifest = json.loads(mp.read_text()) if mp.exists() else {}
    for name, url in URLS.items():
        path = base / name
        if not path.exists():
            tmp = path.with_suffix(path.suffix + '.part')
            try:
                with urllib.request.urlopen(url, timeout=60) as response, tmp.open('wb') as out:
                    while chunk := response.read(1024 * 1024):
                        out.write(chunk)
                tmp.rename(path)
            except Exception:
                tmp.unlink(missing_ok=True)
                raise
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        old = manifest.get(name, {})
        if old.get('sha256') and old['sha256'] != digest:
            raise ValueError(f'Cached source changed: {name}; refusing to overwrite provenance')
        cols = pq.read_schema(path).names if name.endswith('.parquet') else pd.read_csv(path, sep='\t' if name.endswith('.tsv') else ',', nrows=0).columns.tolist()
        manifest[name] = dict(url=old.get('url', url), sha256=digest, bytes=path.stat().st_size,
                              downloaded_at=old.get('downloaded_at', datetime.now(timezone.utc).isoformat()), columns=cols)
    mp.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def load_tables():
    base = config.DATA_DIR / 'flywire'
    if not all((base / name).exists() for name in URLS):
        raise FileNotFoundError('FlyWire cache incomplete. Run python -m flybrain.connectome first.')
    return (pd.read_parquet(base / 'Connectivity_783.parquet', columns=['Presynaptic_ID', 'Postsynaptic_ID', 'Connectivity', 'Excitatory']),
            pd.read_csv(base / 'Supplemental_file1_neuron_annotations.tsv', sep='\t', low_memory=False))


def mb_neurons(neurons, hemisphere='right'):
    if hemisphere not in ('right', 'left'):
        raise ValueError('hemisphere must be right or left')
    n = neurons.loc[neurons.side.eq(hemisphere)]
    masks = {'pn': n.cell_class.eq('ALPN') & n.cell_sub_class.eq('uniglomerular'),
             'kc': n.cell_class.eq('Kenyon_Cell'), 'apl': n.cell_type.eq('APL'),
             'mbon': n.cell_class.eq('MBON'), 'dan': n.cell_class.eq('DAN')}
    groups = {key: n.loc[mask, 'root_id'].to_numpy(dtype=np.int64) for key, mask in masks.items()}
    LOG.info('%s MB counts: %s', hemisphere, {k: len(v) for k, v in groups.items()})
    if any(not len(v) for v in groups.values()):
        raise ValueError('Missing MB group')
    return groups


def signed_weights(edges, ids, neurons):
    ids = np.asarray(ids)
    lookup = pd.Series(np.arange(len(ids)), index=ids)
    e = edges.loc[edges.Presynaptic_ID.isin(ids) & edges.Postsynaptic_ID.isin(ids)]
    nts = neurons.set_index('root_id').top_nt.reindex(e.Presynaptic_ID)
    if not nts.isin(SIGNS).all():
        raise ValueError('Missing or unknown presynaptic neurotransmitter')
    sign = nts.map(SIGNS).to_numpy()
    disagreements = int(np.count_nonzero(sign != e.Excitatory.to_numpy()))
    LOG.info('Connectivity sign disagreements: %d / %d (annotation signs take precedence)', disagreements, len(e))
    W = sparse.csr_matrix((e.Connectivity.to_numpy(float) * sign,
          (lookup.loc[e.Postsynaptic_ID].to_numpy(), lookup.loc[e.Presynaptic_ID].to_numpy())), shape=(len(ids), len(ids)))
    W.eliminate_zeros()
    return W


def matrix_hash(W):
    W = W.tocsr(copy=True)
    W.sort_indices()
    h = hashlib.sha256(str(W.shape).encode())
    for a in (W.indptr, W.indices, W.data):
        h.update(a.tobytes())
    return h.hexdigest()


def scale_spectral_radius(W, rho):
    if rho <= 0:
        raise ValueError('rho must be positive')
    key = matrix_hash(W)
    if key not in _RADIUS:
        if W.shape[0] <= 3:
            radius = np.max(np.abs(np.linalg.eigvals(W.toarray())))
        else:
            radius = abs(eigs(W.astype(float), k=1, which='LM', return_eigenvectors=False,
                              v0=np.random.default_rng(0).normal(size=W.shape[0]), tol=1e-12, maxiter=50000)[0])
        if radius < 1e-12:
            raise ValueError('Cannot scale a zero spectral radius')
        _RADIUS[key] = float(radius)
    return (W * (rho / _RADIUS[key])).tocsr()


def shuffle_control(W, seed):
    """Swap destinations, keeping the weights and signs with each source."""
    rng = np.random.default_rng(seed)
    c = W.tocoo()
    rows, cols, weights = c.row.copy(), c.col.copy(), c.data.copy()
    occupied = set(zip(rows.tolist(), cols.tolist()))
    target, accepted, attempts = 10 * len(rows), 0, 0
    while accepted < target:
        attempts += 1
        if attempts > max(10000, target * 100):
            raise ValueError('Graph cannot support requested degree-preserving swaps')
        a, b = rng.integers(len(rows), size=2)
        r1, r2, c1, c2 = int(rows[a]), int(rows[b]), int(cols[a]), int(cols[b])
        if r1 == r2 or c1 == c2 or (r2, c1) in occupied or (r1, c2) in occupied:
            continue
        occupied.remove((r1, c1)); occupied.remove((r2, c2))
        occupied.add((r2, c1)); occupied.add((r1, c2))
        rows[a], rows[b] = r2, r1
        accepted += 1
    return sparse.csr_matrix((weights, (rows, cols)), shape=W.shape)


def random_control(W, seed):
    """Uniform G(n,m) locations, preserving the exact signed weight multiset."""
    rng = np.random.default_rng(seed)
    n = W.shape[0]
    slots = rng.choice(n * n, size=W.nnz, replace=False)
    return sparse.csr_matrix((rng.permutation(W.data), (slots // n, slots % n)), shape=W.shape)


@dataclass
class Circuit:
    W: sparse.csr_matrix
    groups: dict
    kind: str
    hash: str


def build_circuit(kind, hemisphere='right', seed=0):
    """The circuit for one variant kind; the no-reservoir control has none."""
    if kind not in config.CIRCUITS:
        raise ValueError(kind)
    if kind == 'none':
        return None
    base = config.DATA_DIR / 'circuits'
    base.mkdir(parents=True, exist_ok=True)
    provenance = (config.DATA_DIR / 'flywire' / 'manifest.json').read_bytes()
    key = hashlib.sha256(provenance + Path(__file__).read_bytes() + f'{hemisphere}|{seed}|{kind}|v1'.encode()).hexdigest()
    path = base / f'{key}.npz'
    meta = path.with_suffix('.json')
    if path.exists() and meta.exists():
        m = json.loads(meta.read_text())
        W = sparse.load_npz(path)
        return Circuit(W, {k: np.array(v, dtype=int) for k, v in m['groups'].items()}, kind, matrix_hash(W))
    edges, neurons = load_tables()
    selected = mb_neurons(neurons, hemisphere)
    ids = np.concatenate(list(selected.values()))
    if len(np.unique(ids)) != len(ids):
        raise ValueError('MB groups overlap')
    # ids concatenates the groups in order, so each group is a contiguous index range.
    offsets = np.cumsum([0] + [len(v) for v in selected.values()])
    groups = {k: np.arange(a, b) for k, a, b in zip(selected, offsets, offsets[1:])}
    W = signed_weights(edges, ids, neurons)
    if kind == 'shuffle':
        W = shuffle_control(W, seed)
    elif kind == 'random':
        W = random_control(W, seed)
    sparse.save_npz(path, W)
    meta.write_text(json.dumps({'groups': {k: v.tolist() for k, v in groups.items()}}))
    return Circuit(W, groups, kind, matrix_hash(W))


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    fetch()
    circuit = build_circuit('fly')
    print({k: len(v) for k, v in circuit.groups.items()})
