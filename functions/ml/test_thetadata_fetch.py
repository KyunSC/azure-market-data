"""Offline checks: never instantiate a real client or read credentials."""
import io
import os
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import date
from pathlib import Path
from unittest.mock import Mock, patch

import grpc
import pandas as pd

import thetadata_fetch as fetch
from thetadata.errors import NoDataFoundError

D1, D2 = date(2026, 9, 21), date(2026, 9, 22)
EXPS = [date(2026, 9, 1), D2, date(2026, 9, 25), date(2026, 10, 16), date(2026, 12, 18)]


class Rpc(grpc.RpcError):
    def __init__(self, code):
        self._code = code

    def code(self):
        return self._code


def oi_frame():
    return pd.DataFrame({"symbol": "QQQ", "expiration": ["2026-09-25", "2026-09-25", "2026-10-16"],
                         "strike": [500.0, 510.0, 500.0], "right": ["CALL", "PUT", "CALL"],
                         "open_interest": [100, 0, 50]})


def iv_frame(exp):
    return pd.DataFrame({"symbol": "QQQ", "expiration": [exp.isoformat()] * 3, "strike": [500.0, 510.0, 520.0],
                         "right": ["CALL", "PUT", "CALL"], "implied_vol": [0.2, 0.3, 0.4],
                         "underlying_price": [505.0] * 3})


def fake_client():
    c = Mock()
    c.option_history_open_interest.side_effect = lambda root, exp, date: oi_frame()
    c.option_history_greeks_implied_volatility.side_effect = lambda root, exp, **kw: iv_frame(exp)
    c.option_list_expirations.return_value = pd.DataFrame({"expiration": [e.isoformat() for e in EXPS]})
    c.calendar_year.return_value = pd.DataFrame()
    return c


class Tmp(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        for p in (patch.object(fetch, "OUT_ROOT", self.root), patch.object(fetch, "_sleep", lambda s: None),
                  patch.object(fetch, "load_dotenv"), patch("sys.stdout", io.StringIO())):
            p.start()
            self.addCleanup(p.stop)

    def tearDown(self):
        self._tmp.cleanup()

    def main(self, *argv, client=None):
        client = client or fake_client()
        with patch.object(fetch, "ThetaClient", return_value=client), patch("sys.argv", ["fetch", *argv]):
            return fetch.main(), client

    def parts(self):
        return sorted(p.relative_to(self.root).as_posix() for p in self.root.rglob("*")
                      if p.name in ("part.parquet", "_empty", "part.parquet.tmp"))


class DryRun(Tmp):
    def test_dry_run_makes_no_data_calls(self):
        code, client = self.main("oi", "iv_5m", "--start", "2026-09-14", "--end", "2026-09-26")
        self.assertEqual(code, 0)
        self.assertEqual({c[0] for c in client.method_calls} - {"calendar_year"}, set())
        self.assertEqual(self.parts(), [])

    def test_needs_probe_or_start(self):
        self.assertEqual(self.main("oi", "--end", "2026-09-26")[0], 2)


class Pieces(unittest.TestCase):
    def test_dte_filter(self):
        self.assertEqual(fetch.expirations_for(EXPS, D2, 30), [D2, date(2026, 9, 25), date(2026, 10, 16)])
        self.assertEqual(fetch.expirations_for(EXPS, D2, 0), [D2])

    def test_hive_layout(self):
        with patch.object(fetch, "OUT_ROOT", Path("/x")):
            self.assertEqual(fetch.partition_dir("iv_5m", "SPXW", D1),
                             Path("/x/iv_5m/symbol=SPXW/date=2026-09-21"))

    def test_index_roots_expand(self):
        self.assertEqual(fetch.ROOTS["SPX"], ("SPX", "SPXW"))
        self.assertEqual(fetch.ROOTS["NDX"], ("NDX", "NDXP"))

    def test_trading_days_skip_weekends_and_holidays(self):
        self.assertEqual(fetch.trading_days(date(2026, 9, 4), date(2026, 9, 9), {date(2026, 9, 7)}),
                         [date(2026, 9, 4), date(2026, 9, 8)])

    def test_second_tuesday(self):
        self.assertEqual(fetch.second_tuesday(2026, 9), date(2026, 9, 8))
        self.assertEqual(fetch.second_tuesday(2026, 12), date(2026, 12, 8))


class Partitions(Tmp):
    def run_units(self, client, units, jobs=("oi", "iv_5m"), **kw):
        exps = {r: EXPS for _, r in units}
        b = fetch.Backfill(client, list(jobs), exps, **kw)
        for d, r in units:
            b.process(r, d)
        return b

    def test_existing_partitions_are_skipped(self):
        for job, marker in (("oi", "part.parquet"), ("iv_5m", "_empty")):
            p = fetch.partition_dir(job, "QQQ", D1)
            p.mkdir(parents=True)
            (p / marker).touch()
        client = fake_client()
        self.run_units(client, [(D1, "QQQ")])
        client.option_history_open_interest.assert_not_called()
        client.option_history_greeks_implied_volatility.assert_not_called()

    def test_failed_write_leaves_only_tmp(self):
        def half_write(self_df, path, **kw):
            Path(path).write_bytes(b"partial")
            raise OSError("disk")
        with patch.object(pd.DataFrame, "to_parquet", half_write), self.assertRaises(OSError):
            fetch.write_partition("oi", "QQQ", D1, oi_frame())
        self.assertEqual(self.parts(), ["oi/symbol=QQQ/date=2026-09-21/part.parquet.tmp"])
        self.assertFalse(fetch.is_done("oi", "QQQ", D1))

    def test_no_data_writes_empty_marker(self):
        client = fake_client()
        client.option_history_open_interest.side_effect = NoDataFoundError("holiday")
        self.run_units(client, [(D1, "QQQ")])
        self.assertEqual(self.parts(), ["iv_5m/symbol=QQQ/date=2026-09-21/_empty",
                                        "oi/symbol=QQQ/date=2026-09-21/_empty"])
        client.option_history_greeks_implied_volatility.assert_not_called()

    def test_transient_error_is_retried(self):
        client = fake_client()
        client.option_history_open_interest.side_effect = [Rpc(grpc.StatusCode.UNAVAILABLE),
                                                           Rpc(grpc.StatusCode.RESOURCE_EXHAUSTED), oi_frame()]
        self.run_units(client, [(D1, "QQQ")], jobs=("oi",))
        self.assertEqual(client.option_history_open_interest.call_count, 3)
        self.assertTrue((fetch.partition_dir("oi", "QQQ", D1) / "part.parquet").exists())

    def test_retries_give_up(self):
        fn = Mock(side_effect=Rpc(grpc.StatusCode.UNAVAILABLE))
        with patch.object(fetch, "_sleep", lambda s: None), self.assertRaises(grpc.RpcError):
            fetch.with_retry(fn)
        self.assertEqual(fn.call_count, 5)

    def test_permission_denied_stops_only_that_root(self):
        client = fake_client()

        def oi(root, exp, date):
            if root == "SPX":
                raise Rpc(grpc.StatusCode.PERMISSION_DENIED)
            return oi_frame()
        client.option_history_open_interest.side_effect = oi
        b = self.run_units(client, [(D2, "SPX"), (D2, "QQQ"), (D1, "SPX"), (D1, "QQQ")], jobs=("oi",))
        self.assertEqual(b.denied, {("oi", "SPX")})
        roots = [c.args[0] for c in client.option_history_open_interest.call_args_list]
        self.assertEqual(roots.count("SPX"), 1)
        self.assertEqual(roots.count("QQQ"), 2)
        self.assertEqual(self.parts(), ["oi/symbol=QQQ/date=2026-09-21/part.parquet",
                                        "oi/symbol=QQQ/date=2026-09-22/part.parquet"])

    def test_iv_drops_zero_oi_and_uses_only_live_expirations(self):
        client = fake_client()
        self.run_units(client, [(D2, "QQQ")])
        asked = [c.args[1] for c in client.option_history_greeks_implied_volatility.call_args_list]
        self.assertEqual(asked, [date(2026, 9, 25), date(2026, 10, 16)])  # D2 itself has no OI
        iv = pd.read_parquet(fetch.partition_dir("iv_5m", "QQQ", D2) / "part.parquet")
        self.assertEqual(sorted(zip(iv.expiration, iv.strike, iv.right)),
                         [("2026-09-25", 500.0, "CALL"), ("2026-10-16", 500.0, "CALL")])
        log = [r for r in b_log(self.root) if r["job"] == "iv_5m"][0]
        self.assertEqual((log["rows"], log["rows_kept"]), (6, 2))

    def test_unmatched_strikes_are_kept_unfiltered(self):
        client = fake_client()
        client.option_history_greeks_implied_volatility.side_effect = \
            lambda root, exp, **kw: iv_frame(exp).assign(strike=[499.78, 509.78, 519.78])
        self.run_units(client, [(D2, "QQQ")])
        iv = pd.read_parquet(fetch.partition_dir("iv_5m", "QQQ", D2) / "part.parquet")
        self.assertEqual(len(iv), 6)
        log = [r for r in b_log(self.root) if r["job"] == "iv_5m"][0]
        self.assertEqual((log["status"], log["rows_kept"]), ("unmatched", 6))

    def test_keep_zero_oi(self):
        client = fake_client()
        self.run_units(client, [(D2, "QQQ")], keep_zero_oi=True)
        self.assertEqual(client.option_history_greeks_implied_volatility.call_count, 3)

    def test_iv_refuses_without_oi(self):
        client = fake_client()
        self.run_units(client, [(D1, "QQQ")], jobs=("iv_5m",))
        client.option_history_greeks_implied_volatility.assert_not_called()
        self.assertEqual(self.parts(), [])
        self.assertEqual(b_log(self.root)[0]["status"], "no_oi")

    def test_disk_guard_exits_5(self):
        usage = Mock(free=1024)
        with patch.object(fetch.shutil, "disk_usage", return_value=usage):
            code, client = self.main("oi", "--symbols", "QQQ", "--start", "2026-09-21", "--end", "2026-09-23",
                                     "--download")
        self.assertEqual(code, 5)
        client.option_history_open_interest.assert_not_called()

    def test_max_gb_exits_5(self):
        (self.root / "big").write_bytes(b"x" * 2048)
        with patch.object(fetch, "MIN_FREE_BYTES", 0):
            code, _ = self.main("oi", "--symbols", "QQQ", "--start", "2026-09-21", "--end", "2026-09-23",
                                "--download", "--max-gb", "0.000001")
        self.assertEqual(code, 5)

    def test_download_newest_first_with_limit(self):
        with patch.object(fetch, "MIN_FREE_BYTES", 0):
            code, client = self.main("oi", "iv_5m", "--symbols", "QQQ", "--start", "2026-09-21",
                                     "--end", "2026-09-23", "--download", "--limit", "1", "--workers", "1")
        self.assertEqual(code, 0)
        self.assertEqual([c.kwargs["date"] for c in client.option_history_open_interest.call_args_list], [D2])
        self.assertEqual(self.parts(), ["iv_5m/symbol=QQQ/date=2026-09-22/part.parquet",
                                        "oi/symbol=QQQ/date=2026-09-22/part.parquet"])

    def test_all_denied_exits_4(self):
        client = fake_client()
        client.option_history_open_interest.side_effect = Rpc(grpc.StatusCode.PERMISSION_DENIED)
        with patch.object(fetch, "MIN_FREE_BYTES", 0):
            code, _ = self.main("oi", "--symbols", "QQQ", "--start", "2026-09-21", "--end", "2026-09-23",
                                "--download", client=client)
        self.assertEqual(code, 4)


class Secrets(Tmp):
    SENTINEL = "sentinel-key-7f3a"

    def test_key_never_printed(self):
        out, err = io.StringIO(), io.StringIO()
        leaky = RuntimeError(f"auth failed for {self.SENTINEL}")
        client = fake_client()
        client.option_history_open_interest.side_effect = Rpc(grpc.StatusCode.INTERNAL)
        client.option_history_open_interest.side_effect.details = lambda: self.SENTINEL
        with patch.dict(os.environ, {"THETADATA_API_KEY": self.SENTINEL}), \
             redirect_stdout(out), redirect_stderr(err), patch.object(fetch, "MIN_FREE_BYTES", 0):
            # 1: client construction fails with the key in its message.
            with patch.object(fetch, "ThetaClient", side_effect=leaky), \
                 patch("sys.argv", ["fetch", "oi", "--start", "2026-09-21", "--end", "2026-09-23", "--download"]):
                self.assertEqual(fetch.cli(), 1)
            # 2: a worker hits an unexpected gRPC error carrying the key.
            with patch.object(fetch, "ThetaClient", return_value=client), \
                 patch("sys.argv", ["fetch", "oi", "--symbols", "QQQ", "--start", "2026-09-21",
                                    "--end", "2026-09-23", "--download", "--workers", "1"]):
                self.assertEqual(fetch.cli(), 1)
            # 3: an exception escapes main entirely.
            with patch.object(fetch, "main", side_effect=leaky):
                self.assertEqual(fetch.cli(), 1)
        self.assertNotIn(self.SENTINEL, out.getvalue() + err.getvalue())
        self.assertIn("INTERNAL", out.getvalue())


class Probe(Tmp):
    def test_finds_earliest_month_and_caches(self):
        client = fake_client()

        def oi(root, exp, date):
            if date < pd.Timestamp("2016-05-01").date():
                raise NoDataFoundError("before history")
            return oi_frame()

        def iv(root, exp, **kw):
            raise Rpc(grpc.StatusCode.PERMISSION_DENIED)
        client.option_history_open_interest.side_effect = oi
        client.option_history_greeks_implied_volatility.side_effect = iv
        client.option_list_expirations.return_value = pd.DataFrame(
            {"expiration": pd.date_range("2012-01-06", "2026-12-31", freq="W-FRI").strftime("%Y-%m-%d")})
        code, _ = self.main("probe", "--symbols", "QQQ", client=client)
        self.assertEqual(code, 0)
        res = fetch.json.loads((self.root / "_probe.json").read_text())["results"]["QQQ"]
        self.assertEqual(res["oi"], {"status": "ok", "earliest": "2016-05-01"})
        self.assertEqual(res["iv_5m"]["status"], "denied")
        self.assertLess(client.option_history_open_interest.call_count, 15)

    def test_probe_start_is_used_and_denied_skipped(self):
        (self.root / "_probe.json").write_text(fetch.json.dumps({"results": {
            "QQQ": {"oi": {"status": "ok", "earliest": "2026-09-21"},
                    "iv_5m": {"status": "ok", "earliest": "2026-09-01"}},
            "SPY": {"oi": {"status": "denied", "earliest": None}, "iv_5m": {"status": "denied", "earliest": None}},
        }}))
        code, client = self.main("oi", "iv_5m", "--symbols", "QQQ,SPY", "--end", "2026-09-23")
        self.assertEqual(code, 0)
        out = fetch.sys.stdout.getvalue()
        self.assertIn("iv_5m  QQQ   2026-09-21", out)  # clamped to the oi start
        self.assertIn("oi/SPY: denied", out)


def b_log(root):
    return [fetch.json.loads(l) for l in (root / "fetch_log.jsonl").read_text().splitlines()]


if __name__ == "__main__":
    unittest.main()
