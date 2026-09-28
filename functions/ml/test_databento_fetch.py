"""Offline checks: never instantiate a real client or read credentials."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import databento_fetch as fetch


class FetchTests(unittest.TestCase):
    def test_daily_jobs_cover_each_weekday(self):
        self.assertEqual(len(fetch.chunk_dates(fetch.JOBS['fut-bbo-1s'], '2026-07-06', '2026-07-13')), 5)

    def test_no_options(self):
        # Options come from ThetaData; Databento is futures plus equity bars only.
        for j in fetch.JOBS.values():
            self.assertNotEqual(j.dataset, 'OPRA.PILLAR')
            if j.dataset == fetch.DATASET:
                self.assertIn(j.symbols, ('outrights', 'continuous'))
            else:
                self.assertEqual((j.dataset, j.symbols, j.schema), ('XNAS.ITCH', 'raw', 'ohlcv-1m'))

    def test_equity_request(self):
        job = fetch.JOBS['eq-ohlcv-1m']
        c = fetch.Chunk('eq-ohlcv-1m', 'QQQ', '2022-01-01', '2022-02-01', fetch.candidate_symbols(job, 'QQQ'))
        q = fetch.request(job, c)
        self.assertEqual((q['dataset'], q['symbols'], q['stype_in']), ('XNAS.ITCH', ['QQQ'], 'raw_symbol'))

    def test_dst(self):
        job = fetch.JOBS['fut-bbo-1s']
        self.assertEqual(fetch.request_span(job, '2026-03-06', '2026-03-07')[0].hour, 14)
        self.assertEqual(fetch.request_span(job, '2026-03-09', '2026-03-10')[0].hour, 13)

    def test_interrupted_request_cannot_spend_twice(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(fetch, 'OUT_ROOT', Path(tmp)):
            c = fetch.Chunk('fut-bbo-1s', 'NQ', '2026-07-06', '2026-07-07', ['NQ.v.0'])
            client = Mock()
            client.timeseries.get_range.side_effect = RuntimeError('interrupted')
            with self.assertRaises(RuntimeError):
                fetch.download(client, fetch.JOBS['fut-bbo-1s'], c)
            with self.assertRaises(FileExistsError):
                fetch.download(client, fetch.JOBS['fut-bbo-1s'], c)
            self.assertEqual(client.timeseries.get_range.call_count, 1)

    def test_total_cap_blocks_all_downloads(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(fetch, 'OUT_ROOT', Path(tmp)), \
             patch.object(fetch, 'load_dotenv'), patch.object(fetch.db, 'Historical') as factory, \
             patch.object(fetch, 'download') as paid, patch('sys.stdout', Mock()), \
             patch('sys.argv', ['fetch', 'fut-bbo-1s', '--start', '2026-07-06', '--end', '2026-07-07',
                                '--download', '--max-cost', '0.01']):
            factory.return_value.metadata.get_cost.return_value = 1.0
            factory.return_value.metadata.get_billable_size.return_value = 100
            self.assertEqual(fetch.main(), 3)
            paid.assert_not_called()

    def test_updated_quote_blocks_download(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(fetch, 'OUT_ROOT', Path(tmp)), \
             patch.object(fetch, 'load_dotenv'), patch.object(fetch.db, 'Historical') as factory, \
             patch.object(fetch, 'download') as paid, patch('sys.stdout', Mock()), \
             patch('sys.argv', ['fetch', 'fut-bbo-1s', '--products', 'NQ', '--start', '2026-07-06',
                                '--end', '2026-07-07', '--download', '--max-cost', '1']):
            factory.return_value.metadata.get_cost.side_effect = [0.5, 2.0]
            factory.return_value.metadata.get_billable_size.return_value = 100
            self.assertEqual(fetch.main(), 3)
            paid.assert_not_called()

    def test_month_chunks_are_clipped(self):
        self.assertEqual(fetch.chunk_dates(fetch.JOBS['fut-ohlcv-1m'], '2026-04-24', '2026-06-02'),
                         [('2026-04-24', '2026-05-01'), ('2026-05-01', '2026-06-01'), ('2026-06-01', '2026-06-02')])


if __name__ == '__main__':
    unittest.main()
