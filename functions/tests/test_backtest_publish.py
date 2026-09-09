import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('publish_backtest_data', ROOT / 'functions/ml/publish_backtest_data.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PublishTests(unittest.TestCase):
    def test_version_retention_and_atomic_catalog(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            first = module.publish(ROOT / 'frontend/public/backtest', out)
            second = module.publish(ROOT / 'frontend/public/backtest', out)
            self.assertEqual(first['datasets'], second['datasets'])
            self.assertEqual(2, len(first['datasets']))
            for entry in first['datasets']:
                payload = json.loads((out / (entry['id'] + '.json')).read_text())
                self.assertEqual(entry['version'], payload['version'])
            original = (out / 'index.json').read_bytes()
            source = out / 'invalid'
            source.mkdir()
            (source / 'index.json').write_text('{"datasets":[{"file":"bad.json"}]}')
            (source / 'bad.json').write_text('{"symbol":"QQQ","interval":"5m","bars":0}')
            with self.assertRaises(ValueError):
                module.publish(source, out)
            self.assertEqual(original, (out / 'index.json').read_bytes())

    def test_rejects_duplicates_invalid_prices_and_label_overlap(self):
        fixture = json.loads((ROOT / 'frontend/public/backtest/qqq_5m.json').read_text())
        for mutate in [lambda d: d['time'].__setitem__(1, d['time'][0]),
                       lambda d: d['low'].__setitem__(0, d['high'][0] + 1),
                       lambda d: d['ml'].__setitem__('purgeMinutes', 15)]:
            data = copy.deepcopy(fixture)
            mutate(data)
            with self.assertRaises(ValueError):
                module.validate(data)


if __name__ == '__main__':
    unittest.main()
