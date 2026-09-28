"""Offline checks: the Azure SDK is replaced by an in-memory container; no network, no credentials."""
import contextlib
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import sync_to_azure as sync


class FakeContainer:
    """Just enough of azure.storage.blob.ContainerClient: list_blobs + upload_blob."""

    def __init__(self):
        self.blobs = {}  # name -> (bytes, metadata)
        self.uploads = []

    def list_blobs(self, name_starts_with=None, include=None):
        return [SimpleNamespace(name=n, size=len(d), metadata=dict(m))
                for n, (d, m) in self.blobs.items() if n.startswith(name_starts_with or "")]

    def upload_blob(self, name, data, length=None, overwrite=False, metadata=None, **_):
        assert overwrite
        self.blobs[name] = (data.read(), dict(metadata or {}))
        self.uploads.append(name)


class SyncTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.write("ledger.jsonl", b'{"cost": 1}\n')
        self.write("fut-ohlcv-1m/NQ/2026-07-01_2026-08-01.dbn.zst", b"dbn-bytes")
        self.write("iv_5m/symbol=QQQ/date=2026-07-06/part.parquet", b"parquet-bytes")
        self.container = FakeContainer()

    def tearDown(self):
        self._tmp.cleanup()

    def write(self, rel, data):
        path = self.root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def run_quiet(self, fn, *args):
        with contextlib.redirect_stdout(io.StringIO()) as out:
            code = fn(self.container, self.root, *args)
        return code, out.getvalue()

    def upload(self, prefix=""):
        self.container.uploads.clear()
        return self.run_quiet(sync.sync, prefix, True)

    def test_dry_run_uploads_nothing(self):
        code, out = self.run_quiet(sync.sync, "", False)
        self.assertEqual(code, 0)
        self.assertEqual(self.container.blobs, {})
        self.assertFalse((self.root / sync.MANIFEST).exists())
        self.assertIn("3 of 3 files to upload", out)

    def test_upload_mirrors_hive_paths_and_manifest_last(self):
        self.upload()
        self.assertIn("iv_5m/symbol=QQQ/date=2026-07-06/part.parquet", self.container.blobs)
        self.assertEqual(self.container.uploads[-1], sync.MANIFEST)
        data, meta = self.container.blobs["ledger.jsonl"]
        self.assertEqual(meta[sync.HASH_KEY], sync.sha256_of(self.root / "ledger.jsonl"))

    def test_prefix_is_prepended(self):
        self.upload(prefix="backup/")
        self.assertIn("backup/ledger.jsonl", self.container.blobs)
        self.assertEqual(self.run_quiet(sync.verify, "backup/")[0], 0)

    def test_unchanged_files_are_skipped(self):
        self.upload()
        code, out = self.upload()
        self.assertEqual(code, 0)
        self.assertEqual(self.container.uploads, [])
        self.assertIn("0 of 3 files to upload", out)

    def test_changed_file_is_reuploaded(self):
        self.upload()
        self.write("ledger.jsonl", b'{"cost": 1}\n{"cost": 2}\n')
        self.upload()
        self.assertEqual(self.container.uploads, ["ledger.jsonl", sync.MANIFEST])
        self.assertEqual(self.container.blobs["ledger.jsonl"][0], b'{"cost": 1}\n{"cost": 2}\n')

    def test_same_size_different_content_is_reuploaded(self):
        self.upload()
        self.write("fut-ohlcv-1m/NQ/2026-07-01_2026-08-01.dbn.zst", b"DBN-BYTES")
        self.upload()
        self.assertIn("fut-ohlcv-1m/NQ/2026-07-01_2026-08-01.dbn.zst", self.container.uploads)

    def test_remote_blobs_are_never_deleted(self):
        self.upload()
        (self.root / "ledger.jsonl").unlink()
        self.upload()
        self.assertIn("ledger.jsonl", self.container.blobs)

    def test_verify_passes_after_upload(self):
        self.upload()
        self.assertEqual(self.run_quiet(sync.verify, "")[0], 0)

    def test_verify_catches_missing_blob(self):
        self.upload()
        del self.container.blobs["ledger.jsonl"]
        code, out = self.run_quiet(sync.verify, "")
        self.assertEqual(code, 3)
        self.assertIn("MISSING   ledger.jsonl", out)

    def test_verify_catches_size_and_hash_mismatch(self):
        self.upload()
        name = "fut-ohlcv-1m/NQ/2026-07-01_2026-08-01.dbn.zst"
        self.container.blobs[name] = (b"short", self.container.blobs[name][1])
        self.container.blobs["ledger.jsonl"] = (b"x" * 12, {sync.HASH_KEY: "0" * 64})
        code, out = self.run_quiet(sync.verify, "")
        self.assertEqual(code, 3)
        self.assertIn(f"SIZE      {name}", out)
        self.assertIn("HASH      ledger.jsonl", out)

    def test_verify_fails_before_first_upload(self):
        self.assertEqual(self.run_quiet(sync.verify, "")[0], 3)

    def test_tmp_and_partial_files_are_ignored(self):
        self.write("fut-bbo-1s/NQ/2026-07-06_2026-07-07.dbn.zst.tmp", b"half")
        self.write("fut-bbo-1s/NQ/2026-07-06_2026-07-07.parquet.tmp", b"half")
        self.write("big.part", b"half")
        self.upload()
        self.assertFalse(any(n.endswith((".tmp", ".part")) for n in self.container.blobs))
        self.assertEqual(self.run_quiet(sync.verify, "")[0], 0)

    def test_hash_cache_reuses_manifest_but_verify_rehashes(self):
        self.upload()
        with patch.object(sync, "sha256_of", side_effect=AssertionError("rehashed")):
            sync.scan(self.root)  # sizes + mtimes unchanged: hashes come from the manifest
        with patch.object(sync, "sha256_of", wraps=sync.sha256_of) as h:
            sync.scan(self.root, rehash=True)
        self.assertEqual(h.call_count, 3)

    def test_missing_account_is_usage_error(self):
        with patch.dict("os.environ", {}, clear=True), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as cm:
                sync.main([str(self.root), "databento"])
        self.assertEqual(cm.exception.code, 2)

    def test_main_uses_account_from_env_and_defaults_to_dry_run(self):
        with patch.dict("os.environ", {"RESEARCH_STORAGE_ACCOUNT": "acct"}), \
                patch.object(sync, "container_client", return_value=self.container) as cc, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(sync.main([str(self.root), "databento"]), 0)
        cc.assert_called_once_with("acct", "databento")
        self.assertEqual(self.container.blobs, {})


if __name__ == "__main__":
    unittest.main()
