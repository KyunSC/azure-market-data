"""Validate and atomically publish exports to a versioned dataset directory.

Usage: python functions/ml/publish_backtest_data.py --source frontend/public/backtest --out API_Server/backtest-data
Upload all versioned JSON files to durable HTTPS storage before uploading index.json.
Retain old versions so shared links remain replayable. Uses only the standard library.
"""
import argparse
import hashlib
import json
import math
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def validate(data):
    n = data['bars']
    if not isinstance(n, int) or n < 2:
        raise ValueError('At least two bars required')
    columns = ['time', 'open', 'high', 'low', 'close', 'volume']
    for key in columns:
        values = data[key]
        if len(values) != n or any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in values):
            raise ValueError(f'Invalid {key} column')
    for i, t in enumerate(data['time']):
        if t <= 0 or t > datetime.now(timezone.utc).timestamp() - 300 or (i and t <= data['time'][i - 1]):
            raise ValueError('Timestamps must be increasing, unique, completed UTC seconds')
        o, h, l, c, v = (data[k][i] for k in columns[1:])
        if l <= 0 or l > min(o, c) or h < max(o, c) or v < 0:
            raise ValueError(f'Invalid OHLCV at bar {i}')
    for key, index in [('start', 0), ('end', -1)]:
        if datetime.fromisoformat(data[key]).timestamp() != data['time'][index]:
            raise ValueError(f'Incorrect {key} coverage')
    for key, values in data.get('features', {}).items():
        if len(values) != n or any(v is not None and (not isinstance(v, (int, float)) or not math.isfinite(v)) for v in values):
            raise ValueError(f'Invalid feature {key}')
    ml = data.get('ml')
    if ml:
        for key in ['pred', 'target_return', 'fold']:
            if len(ml[key]) != n or any(v is not None and (not isinstance(v, (int, float)) or not math.isfinite(v)) for v in ml[key]):
                raise ValueError(f'Invalid ML {key}')
        for i, pred in enumerate(ml['pred']):
            if pred is not None and (i < ml['oosStart'] or ml['fold'][i] is None):
                raise ValueError('Prediction outside declared OOS coverage')
        for fold in ml.get('folds', []):
            if not (0 <= fold['trainStart'] <= fold['trainEnd'] < fold['testStart'] <= fold['testEnd'] < n):
                raise ValueError('Invalid walk-forward boundaries')
            if ml.get('purgeMinutes') and data['time'][fold['trainEnd']] + ml['purgeMinutes'] * 60 >= data['time'][fold['testStart']]:
                raise ValueError('Training labels overlap the test window')
    return {'missingFeatureValues': sum(v is None for col in data.get('features', {}).values() for v in col),
            'gapsOver5Minutes': sum(b - a > 300 for a, b in zip(data['time'], data['time'][1:])),
            'predictionValidation': 'purged-walk-forward' if ml and ml.get('purgeMinutes') else 'legacy-unverified' if ml else 'none',
            'completedBarsOnly': True}


def atomic_json(path, data):
    encoded = json.dumps(data, separators=(',', ':'), allow_nan=False).encode()
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        stream.write(encoded)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def publish(source, out):
    source, out = Path(source), Path(out)
    manifest = json.loads((source / 'index.json').read_text())
    prepared = []
    for entry in manifest['datasets']:
        filename = entry['file']
        if Path(filename).name != filename:
            raise ValueError('Invalid export filename')
        data = json.loads((source / filename).read_text())
        if data['symbol'] not in ('QQQ', 'SPY') or data['interval'] != '5m':
            raise ValueError('Initial publication supports QQQ/SPY 5m only')
        data['quality'] = validate(data)
        data['schemaVersion'] = 1
        data['capabilities'] = {'gex': bool(data.get('featureGroups', {}).get('gex')), 'ml': bool(data.get('ml'))}
        version = hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()
        dataset_id = f"{data['symbol'].lower()}-5m-{version}"
        data.update(id=dataset_id, version=version)
        metadata = {k: data[k] for k in ('id', 'version', 'schemaVersion', 'symbol', 'interval', 'bars', 'start', 'end', 'generatedAt', 'capabilities', 'quality')}
        metadata['hasMl'] = data['capabilities']['ml']
        prepared.append((data, metadata))
    out.mkdir(parents=True, exist_ok=True)
    for data, _ in prepared:
        path = out / f"{data['id']}.json"
        if not path.exists():
            atomic_json(path, data)
    catalog = {'schemaVersion': 1, 'generatedAt': datetime.now(timezone.utc).isoformat(), 'datasets': [m for _, m in prepared]}
    atomic_json(out / 'index.json', catalog)
    return catalog


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    catalog = publish(args.source, args.out)
    print(f"Published {len(catalog['datasets'])} datasets to {args.out}")
