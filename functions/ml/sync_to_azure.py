"""Back up a local research-data folder to a private Azure Blob container, key-less.

Auth is Entra ID only: DefaultAzureCredential picks up `az login` (or a managed
identity). No account keys, connection strings or SAS tokens are used or accepted;
the storage account has shared-key access disabled. The account name comes from
--account or RESEARCH_STORAGE_ACCOUNT (not a secret, but not hardcoded).

Default mode is a DRY RUN: it lists files that would be uploaded and uploads nothing.

    python functions/ml/sync_to_azure.py functions/ml/data/databento databento             # dry run
    python functions/ml/sync_to_azure.py functions/ml/data/databento databento --upload
    python functions/ml/sync_to_azure.py functions/ml/data/databento databento --verify
    python functions/ml/sync_to_azure.py functions/ml/data/thetadata thetadata --prefix iv_5m/ --upload

Blob names mirror local relative paths exactly (prefixed by --prefix), so Hive-style
`<dataset>/symbol=<SYM>/date=<YYYY-MM-DD>/part.parquet` folders survive. Each blob
carries its sha256 as metadata; a file is skipped when the remote size and sha256
match. Remote blobs are never deleted. `*.tmp` and other in-progress partial
downloads are ignored.

--upload writes manifest.json (path, size, sha256, mtime) at the local root and
uploads it last. --verify re-hashes local files and exits 3 if any is missing
remotely or differs in size or hash, or if the manifest is missing or stale.

Exit codes: 0 ok, 1 Azure/auth failure, 2 bad usage, 3 verify mismatch.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

MANIFEST = "manifest.json"
HASH_KEY = "sha256"
# In-progress or partial downloads; `databento_fetch.py` writes `<file>.tmp` first.
SKIP_SUFFIXES = (".tmp", ".part", ".partial", ".crdownload", ".incomplete")
SKIP_NAMES = {".DS_Store"}
CHUNK = 8 * 1024 * 1024


@dataclass(frozen=True)
class LocalFile:
    rel: str  # POSIX path relative to the local root
    size: int
    sha256: str
    mtime: float


def skipped(path: Path) -> bool:
    return path.name in SKIP_NAMES or path.name.endswith(SKIP_SUFFIXES)


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(CHUNK):
            h.update(block)
    return h.hexdigest()


def load_manifest(root: Path) -> dict[str, dict]:
    try:
        return {e["path"]: e for e in json.loads((root / MANIFEST).read_text())["files"]}
    except (FileNotFoundError, ValueError, KeyError, TypeError):
        return {}


def scan(root: Path, rehash: bool = False) -> list[LocalFile]:
    """Every syncable file under root. Reuses manifest hashes when size+mtime match."""
    cached = {} if rehash else load_manifest(root)
    files = []
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if not path.is_file() or skipped(path) or rel == MANIFEST:
            continue
        st = path.stat()
        hit = cached.get(rel)
        if hit and hit.get("size") == st.st_size and hit.get("mtime") == st.st_mtime:
            digest = hit["sha256"]
        else:
            digest = sha256_of(path)
        files.append(LocalFile(rel, st.st_size, digest, st.st_mtime))
    return files


def manifest_current(root: Path, files: list[LocalFile]) -> bool:
    entries = {rel: (e.get("size"), e.get("sha256")) for rel, e in load_manifest(root).items()}
    return (root / MANIFEST).is_file() and entries == {f.rel: (f.size, f.sha256) for f in files}


def write_manifest(root: Path, files: list[LocalFile]) -> Path:
    path = root / MANIFEST
    tmp = path.with_name(MANIFEST + ".tmp")
    tmp.write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "files": [{"path": f.rel, "size": f.size, "sha256": f.sha256, "mtime": f.mtime} for f in files],
    }, indent=1) + "\n")
    tmp.replace(path)
    return path


def remote_index(container, prefix: str) -> dict[str, tuple[int, str | None]]:
    """blob name -> (size, sha256 metadata or None) for everything under prefix."""
    return {b.name: (b.size, (b.metadata or {}).get(HASH_KEY))
            for b in container.list_blobs(name_starts_with=prefix or None, include=["metadata"])}


def needs_upload(f: LocalFile, remote: dict, prefix: str) -> bool:
    return remote.get(prefix + f.rel) != (f.size, f.sha256)


def upload(container, root: Path, f: LocalFile, prefix: str) -> None:
    with (root / f.rel).open("rb") as data:
        container.upload_blob(prefix + f.rel, data, length=f.size, overwrite=True,
                              metadata={HASH_KEY: f.sha256}, max_concurrency=4)


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def sync(container, root: Path, prefix: str, do_upload: bool) -> int:
    files = scan(root)
    remote = remote_index(container, prefix)
    pending = [f for f in files if needs_upload(f, remote, prefix)]
    for f in pending:
        state = "changed" if prefix + f.rel in remote else "new"
        print(f"{'upload' if do_upload else 'would upload'}  {f.rel}  ({f.size:,} B, {state})")
        if do_upload:
            upload(container, root, f, prefix)
    total = sum(f.size for f in pending)
    print(f"\n{len(pending)} of {len(files)} files to upload, {total:,} bytes ({human(total)}); "
          f"{len(files) - len(pending)} unchanged")
    if not do_upload:
        print("Dry run — nothing uploaded. Re-run with --upload.")
        return 0
    manifest = root / MANIFEST
    if not manifest_current(root, files):
        write_manifest(root, files)
    mf = LocalFile(MANIFEST, manifest.stat().st_size, sha256_of(manifest), manifest.stat().st_mtime)
    if needs_upload(mf, remote, prefix):
        upload(container, root, mf, prefix)  # last, so it only ever describes uploaded data
        print(f"uploaded {len(pending)} files + {MANIFEST}")
    else:
        print(f"uploaded {len(pending)} files; {MANIFEST} unchanged")
    return 0


def verify(container, root: Path, prefix: str) -> int:
    files = scan(root, rehash=True)
    remote = remote_index(container, prefix)
    problems = []
    for f in files:
        got = remote.get(prefix + f.rel)
        if got is None:
            problems.append(f"MISSING   {f.rel}")
        elif got[0] != f.size:
            problems.append(f"SIZE      {f.rel} (local {f.size:,}, remote {got[0]:,})")
        elif got[1] != f.sha256:
            problems.append(f"HASH      {f.rel}")
    if not (root / MANIFEST).is_file():
        problems.append(f"MANIFEST  {MANIFEST} missing locally — run --upload")
    elif not manifest_current(root, files):
        problems.append(f"MANIFEST  {MANIFEST} is stale — run --upload")
    else:
        mpath = root / MANIFEST
        if remote.get(prefix + MANIFEST) != (mpath.stat().st_size, sha256_of(mpath)):
            problems.append(f"MANIFEST  remote {MANIFEST} missing or differs")
    for p in problems:
        print(p)
    total = sum(f.size for f in files)
    status = "FAILED" if problems else "OK"
    print(f"\nverify {status}: {len(files)} files, {total:,} bytes ({human(total)}); {len(problems)} problems")
    return 3 if problems else 0


def container_client(account: str, container: str):
    from azure.identity import DefaultAzureCredential
    from azure.storage.blob import BlobServiceClient

    service = BlobServiceClient(f"https://{account}.blob.core.windows.net",
                                credential=DefaultAzureCredential())
    return service.get_container_client(container)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("local_root", type=Path)
    ap.add_argument("container")
    ap.add_argument("--prefix", default="", help="blob-name prefix, e.g. iv_5m/")
    ap.add_argument("--account", default=os.environ.get("RESEARCH_STORAGE_ACCOUNT"),
                    help="storage account name (default: $RESEARCH_STORAGE_ACCOUNT)")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--upload", action="store_true", help="upload new or changed files")
    mode.add_argument("--verify", action="store_true", help="compare local files against remote")
    args = ap.parse_args(argv)
    if not args.account:
        ap.error("pass --account or set RESEARCH_STORAGE_ACCOUNT")
    root = args.local_root.resolve()
    if not root.is_dir():
        print(f"Not a directory: {args.local_root}")
        return 2
    prefix = args.prefix.strip("/") + "/" if args.prefix.strip("/") else ""
    container = container_client(args.account, args.container)
    if args.verify:
        return verify(container, root, prefix)
    return sync(container, root, prefix, args.upload)


if __name__ == "__main__":
    sys.stdout.reconfigure(line_buffering=True)
    try:
        sys.exit(main())
    except Exception as exc:
        # SDK errors can carry request details. Report the type and service code only.
        code = getattr(exc, "error_code", None)
        print(f"Azure operation failed ({type(exc).__name__}{': ' + str(code) if code else ''}). "
              "Check `az login` and the Storage Blob Data Contributor role.")
        sys.exit(1)
