"""Download Databento futures and equity-bar data for the ML pipeline with explicit cost caps and conservative retry protection.

Scope: ES/NQ futures (GLBX.MDP3) and 1-minute QQQ/SPY bars from Nasdaq TotalView-ITCH
(XNAS.ITCH, eq-ohlcv-1m) for the 5-min price/volume baseline. GEX comes from a separate
options-analytics provider, so option definitions/statistics are not fetched here; the
one-day definition sample already under data/databento/fopt-def/ is kept for reference.

Default mode is a QUOTE: it prices every missing file with the free
metadata.get_cost call and downloads nothing. Spending requires --download,
and the whole pending set must fit under --max-cost or nothing is fetched.

    python functions/ml/databento_fetch.py fut-ohlcv-1m fut-bbo-1s                 # quote
    python functions/ml/databento_fetch.py fut-bbo-1s --download --max-cost 25
    python functions/ml/databento_fetch.py nq-mbo --start 2026-07-06 --end 2026-08-01
    python functions/ml/databento_fetch.py eq-ohlcv-1m --start 2022-01-01 --end 2026-09-26

Layout: data/databento/<job>/<product>/<start>_<end>.{dbn.zst,parquet}. Each job
chunks by calendar month or weekday (see Job.every). A file whose Parquet exists is
skipped; a file whose DBN exists but Parquet doesn't is converted without a new
request. The DBN is the paid artifact — never delete it to "retry". Every paid
request is appended to data/databento/ledger.jsonl with its quoted cost.

BBO requests cover 09:25-16:00 ET per weekday, with DST handled explicitly.
Interrupted paid attempts are blocked for manual reconciliation, never retried.

Needs DATABENTO_API_KEY in the environment or in the repo-root .env.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import databento as db
import pandas as pd
from dotenv import load_dotenv

from databento_cost import DEFAULT_END, DEFAULT_START, REPO_ROOT

OUT_ROOT = Path(__file__).resolve().parent / "data" / "databento"
LEDGER = OUT_ROOT / "ledger.jsonl"
DATASET = "GLBX.MDP3"


@dataclass(frozen=True)
class Job:
    schema: str
    stype_in: str
    symbols: str  # "outrights" | "continuous" | "raw"
    products: tuple[str, ...] = ("ES", "NQ")
    whole_window_only: bool = False  # refuse the default window (pilots must name dates)
    every: str = "month"  # "month" | "day" (weekdays)
    et_window: tuple[str, str] | None = None  # daily [start, end) in America/New_York
    dataset: str = DATASET


JOBS = {
    "fut-ohlcv-1m": Job("ohlcv-1m", "parent", "outrights"),  # every contract: roll-aware basis vs. index GEX levels
    "fut-bbo-1s": Job("bbo-1s", "continuous", "continuous", every="day", et_window=("09:25", "16:00")),
    "nq-mbo": Job("mbo", "continuous", "continuous", products=("NQ",), whole_window_only=True),
    # Single venue (Nasdaq), but one consistent source from 2022 on; volume features are relative.
    "eq-ohlcv-1m": Job("ohlcv-1m", "raw_symbol", "raw", products=("QQQ", "SPY"), dataset="XNAS.ITCH"),
}


def chunk_dates(job: Job, start: str, end: str) -> list[tuple[str, str]]:
    s, e = pd.Timestamp(start), pd.Timestamp(end)
    fmt = "%Y-%m-%d"
    if job.every == "month":
        edges = [s, *pd.date_range(s + pd.offsets.MonthBegin(1), e, freq="MS", inclusive="left"), e]
        return [(a.strftime(fmt), b.strftime(fmt)) for a, b in zip(edges, edges[1:]) if a < b]
    days = pd.date_range(s, e, freq="B", inclusive="left")
    return [(d.strftime(fmt), (d + pd.Timedelta(days=1)).strftime(fmt)) for d in days]


def request_span(job: Job, start: str, end: str) -> tuple[pd.Timestamp, pd.Timestamp]:
    """UTC [start, end) actually requested: the whole chunk, or its ET window (day chunks)."""
    if job.et_window is None:
        return pd.Timestamp(start, tz="UTC"), pd.Timestamp(end, tz="UTC")
    lo, hi = (pd.Timestamp(f"{start} {t}", tz="America/New_York").tz_convert("UTC") for t in job.et_window)
    return lo, hi


def candidate_symbols(job: Job, product: str) -> list[str]:
    if job.symbols == "outrights":
        return [f"{product}.FUT"]
    if job.symbols == "raw":
        return [product]
    return [f"{product}.v.0"]


@dataclass
class Chunk:
    job_name: str
    product: str
    start: str
    end: str
    symbols: list[str]
    cost: float = 0.0

    @property
    def stem(self) -> Path:
        return OUT_ROOT / self.job_name / self.product / f"{self.start}_{self.end}"

    @property
    def dbn(self) -> Path:
        return self.stem.with_suffix(".dbn.zst")

    @property
    def intent(self) -> Path:
        return self.stem.with_suffix(".request.json")

    @property
    def parquet(self) -> Path:
        return self.stem.with_suffix(".parquet")


def request(job: Job, chunk: Chunk) -> dict:
    lo, hi = request_span(job, chunk.start, chunk.end)
    return dict(dataset=job.dataset, symbols=chunk.symbols, stype_in=job.stype_in,
                schema=job.schema, start=lo, end=hi)


def to_parquet(chunk: Chunk) -> None:
    tmp = chunk.parquet.with_suffix(".parquet.tmp")
    db.DBNStore.from_file(chunk.dbn).to_parquet(tmp)
    tmp.rename(chunk.parquet)


def download(client: db.Historical, job: Job, chunk: Chunk) -> None:
    chunk.dbn.parent.mkdir(parents=True, exist_ok=True)
    tmp = chunk.dbn.with_name(chunk.dbn.name + ".tmp")
    if chunk.dbn.exists() or chunk.parquet.exists() or tmp.exists():
        raise RuntimeError("Existing artifact: refusing duplicate paid request")
    # Exclusive creation also prevents two processes from paying for this chunk.
    with chunk.intent.open("x") as f:
        json.dump({"request": request(job, chunk), "quoted_cost": chunk.cost,
                   "status": "started; reconcile before retrying"}, f, default=str)
        f.flush()
        os.fsync(f.fileno())
    client.timeseries.get_range(**request(job, chunk), path=tmp)
    tmp.rename(chunk.dbn)  # paid: from here on the chunk is never requested again
    with LEDGER.open("a") as f:
        f.write(json.dumps({
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "job": chunk.job_name, "product": chunk.product, "start": chunk.start,
            "end": chunk.end, "requested": [t.isoformat() for t in request_span(job, chunk.start, chunk.end)],
            "dataset": job.dataset, "schema": job.schema, "symbols": chunk.symbols,
            "quoted_cost": round(chunk.cost, 4), "bytes": chunk.dbn.stat().st_size,
        }) + "\n")
    to_parquet(chunk)


def main() -> int:
    sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("jobs", nargs="+", choices=sorted(JOBS))
    ap.add_argument("--start", default=None, help=f"default {DEFAULT_START}")
    ap.add_argument("--end", default=None, help=f"exclusive, default {DEFAULT_END}")
    ap.add_argument("--products", default=None, help="comma-separated subset, e.g. NQ or QQQ")
    ap.add_argument("--download", action="store_true", help="actually spend credit")
    ap.add_argument("--max-cost", type=float, default=None,
                    help="USD cap on the whole pending set; required with --download")
    args = ap.parse_args()
    if args.download and args.max_cost is None:
        ap.error("--download needs --max-cost")

    if args.max_cost is not None and (not math.isfinite(args.max_cost) or args.max_cost < 0):
        ap.error("--max-cost must be finite and nonnegative")
    start, end = args.start or DEFAULT_START, args.end or DEFAULT_END
    try:
        from datetime import date
        if date.fromisoformat(start) >= date.fromisoformat(end):
            raise ValueError()
    except ValueError:
        ap.error("use YYYY-MM-DD dates with start < end")
    args.jobs = list(dict.fromkeys(args.jobs))
    if args.products is not None:
        selected = set(args.products.upper().split(","))
        supported = set().union(*(set(JOBS[n].products) for n in args.jobs))
        if not selected or not selected <= supported:
            ap.error(f"--products must be a supported subset of {','.join(sorted(supported))}")
    load_dotenv(REPO_ROOT / ".env")
    try:
        client = db.Historical()
    except Exception as e:  # missing/invalid key — report the symptom only
        print(f"Could not create Databento client: {type(e).__name__}. Is DATABENTO_API_KEY set?")
        return 1

    pending: list[tuple[Job, Chunk]] = []
    convert: list[Chunk] = []
    print(f"{'job':<14}{'product':<8}{'chunk':<24}{'parents':>8}{'size':>10}{'cost':>10}  status")
    for name in args.jobs:
        job = JOBS[name]
        if job.whole_window_only and (args.start is None or args.end is None):
            print(f"{name}: pass --start and --end explicitly (pilot job)")
            return 2
        start, end = args.start or DEFAULT_START, args.end or DEFAULT_END
        products = [p for p in job.products
                    if args.products is None or p in args.products.upper().split(",")]
        for product in products:
            for s, e in chunk_dates(job, start, end):
                chunk = Chunk(name, product, s, e, [])
                label = f"{name:<14}{product:<8}{s + '_' + e:<24}"
                # Date partitions can change between runs. Refuse overlapping
                # artifacts instead of billing for an already purchased subrange.
                for existing in chunk.stem.parent.glob("*"):
                    other = existing.name.split(".")[0]
                    if other == chunk.stem.name:
                        continue
                    try:
                        old_start, old_end = other.split("_")
                        datetime.strptime(old_start, "%Y-%m-%d")
                        datetime.strptime(old_end, "%Y-%m-%d")
                    except ValueError:
                        continue
                    if s < old_end and old_start < e:
                        print(f"{label} BLOCKED: overlapping artifact {existing.name}")
                        return 4
                if chunk.parquet.exists():
                    print(f"{label}{'':>28}  have")
                    continue
                if chunk.dbn.exists():
                    print(f"{label}{'':>28}  convert (already paid)")
                    convert.append(chunk)
                    continue
                if chunk.intent.exists() or chunk.dbn.with_name(chunk.dbn.name + ".tmp").exists():
                    print(f"{label} BLOCKED: incomplete paid attempt; reconcile with provider before retry")
                    return 4
                chunk.symbols = candidate_symbols(job, product)
                q = request(job, chunk)
                size = client.metadata.get_billable_size(**q)
                chunk.cost = client.metadata.get_cost(**q)
                if not math.isfinite(chunk.cost) or chunk.cost < 0:
                    raise ValueError("Invalid provider quote")
                if size == 0:  # exchange holiday
                    print(f"{label}{'':>28}  empty")
                    continue
                print(f"{label}{len(chunk.symbols):>8}{size / 1e6:>8.0f}MB{chunk.cost:>9.2f}$  pending")
                pending.append((job, chunk))

    total = sum(c.cost for _, c in pending)
    print(f"\npending: {len(pending)} files, ${total:.2f}   already paid, to convert: {len(convert)}")

    for chunk in convert:
        to_parquet(chunk)
    if not args.download:
        print("Quote only — nothing spent. Re-run with --download --max-cost <usd> to fetch.")
        return 0
    if total > args.max_cost:
        print(f"REFUSED: ${total:.2f} exceeds --max-cost ${args.max_cost:.2f}. Nothing downloaded.")
        return 3
    spent = 0.0
    for job, chunk in pending:
        # Re-price immediately before every paid call, within the aggregate cap.
        chunk.cost = client.metadata.get_cost(**request(job, chunk))
        if not math.isfinite(chunk.cost) or chunk.cost < 0 or spent + chunk.cost > args.max_cost:
            print("REFUSED: updated quote exceeds remaining cap or is invalid")
            return 3
        print(f"fetching {chunk.job_name}/{chunk.product}/{chunk.start}_{chunk.end} (${chunk.cost:.2f})")
        download(client, job, chunk)
        spent += chunk.cost
    print(f"done — spent ~${spent:.2f} (see {LEDGER.relative_to(REPO_ROOT)})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        # SDK errors can contain request details. Do not expose credentials.
        print(f"Databento operation failed ({type(exc).__name__}); artifacts retained, no automatic retry.")
        sys.exit(1)
