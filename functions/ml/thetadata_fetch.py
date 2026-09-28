"""Backfill ThetaData option open interest and 5-minute implied volatility for historical GEX.

Scope: QQQ, SPY, SPX (+SPXW) and NDX (+NDXP) options with 0-30 DTE, all strikes.
Greeks are computed in-house from vendor IV + daily OI, so only first-party inputs
are stored. Timestamps are kept exactly as the vendor sends them (OI is published
~06:30 ET for the prior close); point-in-time alignment belongs in build_dataset.py.

The plan is flat-rate: there is no per-request cost. The risks are time, disk and
rate limits, so default mode is a DRY RUN that lists pending partitions and fetches
nothing. `probe` finds how far back each root/job goes on this subscription.

    python functions/ml/thetadata_fetch.py probe                                  # history depth
    python functions/ml/thetadata_fetch.py oi iv_5m                               # dry run
    python functions/ml/thetadata_fetch.py oi iv_5m --download --limit 10         # pilot
    python functions/ml/thetadata_fetch.py oi iv_5m --download --workers 2 --max-gb 400

Layout: data/thetadata/<job>/symbol=<ROOT>/date=<YYYY-MM-DD>/part.parquet, or an
`_empty` marker when the vendor has no data (holiday, not yet listed). Existing
partitions are skipped, so re-running resumes. Writes go to part.parquet.tmp and are
renamed, so a crash never leaves a partial part.parquet. Downloads run newest first,
and iv_5m for a date needs that date's oi partition (contracts with zero OI are
dropped unless --keep-zero-oi). One line per partition goes to fetch_log.jsonl.

Only counts, sizes and timings are printed, never data values (the holdout window
stays uninspected). Errors print the exception type and gRPC code only.

Exit codes: 0 ok, 1 provider/auth failure, 2 bad usage, 4 permission denied on
every requested root/job, 5 disk guard hit.

Needs THETADATA_API_KEY in the environment or in the repo-root .env.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import grpc
import pandas as pd
from dotenv import load_dotenv
from thetadata import ThetaClient
from thetadata.errors import NoDataFoundError

from databento_cost import REPO_ROOT

OUT_ROOT = Path(__file__).resolve().parent / "data" / "thetadata"
JOBS = ("oi", "iv_5m")  # run order: iv_5m for a date needs that date's oi
# AM-settled monthlies and PM-settled weeklies are separate roots on the index products.
ROOTS = {"QQQ": ("QQQ",), "SPY": ("SPY",), "SPX": ("SPX", "SPXW"), "NDX": ("NDX", "NDXP")}
MAX_DTE = 30  # matches MAX_DAYS_OUT in functions/GEXCalculator/gex_calculator.py
FIRST_YEAR = 2012  # ThetaData calendar and options history start
MIN_FREE_BYTES = 20 * 1024**3
SESSION = ("09:30:00", "16:00:00")
KEYS = ["expiration", "strike", "right"]
TRANSIENT = {grpc.StatusCode.UNAVAILABLE, grpc.StatusCode.DEADLINE_EXCEEDED, grpc.StatusCode.RESOURCE_EXHAUSTED}
ET = ZoneInfo("America/New_York")
_sleep = time.sleep  # patched in tests


class PermissionDenied(Exception):
    """The subscription does not cover this request."""


class MissingOI(Exception):
    """iv_5m was asked for a date whose oi partition has not been fetched."""


class DiskGuard(Exception):
    """--max-gb reached or free disk below MIN_FREE_BYTES."""


def grpc_code(exc: BaseException) -> grpc.StatusCode | None:
    code = getattr(exc, "code", None)
    if isinstance(exc, grpc.RpcError) and callable(code):
        try:
            return code()
        except Exception:
            return None
    return None


def with_retry(fn, tries: int = 5, base: float = 2.0, cap: float = 60.0):
    """Call fn, backing off on transient gRPC codes. PERMISSION_DENIED becomes PermissionDenied."""
    for attempt in range(tries):
        try:
            return fn()
        except grpc.RpcError as e:
            code = grpc_code(e)
            if code == grpc.StatusCode.PERMISSION_DENIED:
                raise PermissionDenied() from None
            if code not in TRANSIENT or attempt == tries - 1:
                raise
            _sleep(min(cap, base * 2 ** attempt))


# ---- calendar -------------------------------------------------------------------

def closed_days(get_client, years: range) -> set[date]:
    """Full-close holidays from calendar_year, cached per year under _calendar/."""
    closed: set[date] = set()
    for year in years:
        cache = OUT_ROOT / "_calendar" / f"{year}.json"
        if cache.exists():
            records = json.loads(cache.read_text())
        else:
            try:
                df = with_retry(lambda: get_client().calendar_year(str(year)))
                records = df.astype(str).to_dict("records")
            except NoDataFoundError:
                records = []
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_text(json.dumps(records))
        for rec in records:
            low = {k.lower(): v for k, v in rec.items()}
            kind = str(low.get("type", "")).lower()
            if "date" in low and "early" not in kind and any(w in kind for w in ("full", "holiday", "closed")):
                closed.add(pd.Timestamp(low["date"]).date())
    return closed


def trading_days(start: date, end: date, closed: set[date]) -> list[date]:
    """Weekdays in [start, end) that are not full-close holidays."""
    days = pd.date_range(start, end, freq="B", inclusive="left")
    return [d.date() for d in days if d.date() not in closed]


# ---- partitions -----------------------------------------------------------------

def partition_dir(job: str, root: str, d: date) -> Path:
    return OUT_ROOT / job / f"symbol={root}" / f"date={d.isoformat()}"


def is_done(job: str, root: str, d: date) -> bool:
    p = partition_dir(job, root, d)
    return (p / "part.parquet").exists() or (p / "_empty").exists()


def write_partition(job: str, root: str, d: date, df: pd.DataFrame | None) -> int:
    """Atomically write part.parquet (via .tmp + rename), or an _empty marker. Returns bytes."""
    out = partition_dir(job, root, d)
    out.mkdir(parents=True, exist_ok=True)
    if df is None or df.empty:
        (out / "_empty").touch()
        return 0
    tmp = out / "part.parquet.tmp"
    df.to_parquet(tmp, index=False)
    tmp.rename(out / "part.parquet")
    return (out / "part.parquet").stat().st_size


def read_oi(root: str, d: date) -> pd.DataFrame | None:
    p = partition_dir("oi", root, d)
    if (p / "part.parquet").exists():
        return pd.read_parquet(p / "part.parquet")
    if (p / "_empty").exists():
        return None
    raise MissingOI()


# ---- contracts ------------------------------------------------------------------

def contract_keys(df: pd.DataFrame) -> pd.DataFrame:
    """Normalized (expiration, strike, right) so OI and IV rows join regardless of wire format."""
    missing = [k for k in KEYS if k not in df.columns]
    if missing:
        raise KeyError(f"response lacks {missing}; columns are {list(df.columns)}")
    return pd.DataFrame({
        "expiration": pd.to_datetime(df["expiration"].astype(str), format="mixed").dt.strftime("%Y-%m-%d"),
        "strike": pd.to_numeric(df["strike"]).round(3),
        "right": df["right"].astype(str).str[:1].str.upper(),
    }, index=df.index)


def live_contracts(oi: pd.DataFrame) -> pd.DataFrame:
    """Unique contract keys with open interest > 0."""
    if "open_interest" not in oi.columns:
        raise KeyError(f"oi response lacks open_interest; columns are {list(oi.columns)}")
    keys = contract_keys(oi)
    return keys[pd.to_numeric(oi["open_interest"]).fillna(0).to_numpy() > 0].drop_duplicates()


def keep_live(iv: pd.DataFrame, live: pd.DataFrame) -> pd.DataFrame:
    hit = contract_keys(iv).merge(live.assign(_live=True), on=KEYS, how="left")["_live"].notna()
    return iv[hit.to_numpy()]


def parse_expirations(df: pd.DataFrame) -> list[date]:
    col = "expiration" if "expiration" in df.columns else df.columns[0]
    return sorted(set(pd.to_datetime(df[col].astype(str), format="mixed").dt.date))


def expirations_for(all_exps: list[date], d: date, max_dte: int) -> list[date]:
    return [e for e in all_exps if 0 <= (e - d).days <= max_dte]


# ---- fetch ----------------------------------------------------------------------

def fetch_oi(client, root: str, d: date) -> pd.DataFrame | None:
    try:
        return with_retry(lambda: client.option_history_open_interest(root, "*", date=d))
    except NoDataFoundError:
        return None


def fetch_iv(client, root: str, d: date, exps: list[date], strike_range: int | None = None) -> pd.DataFrame | None:
    """5-minute bid/mid/ask IV for every strike of each expiration (the endpoint rejects expiration='*')."""
    frames = []
    for e in exps:
        try:
            frames.append(with_retry(lambda e=e: client.option_history_greeks_implied_volatility(
                root, e, interval="5m", date=d, start_time=SESSION[0], end_time=SESSION[1],
                strike_range=strike_range)))
        except NoDataFoundError:
            continue
    frames = [f for f in frames if f is not None and len(f)]
    return pd.concat(frames, ignore_index=True) if frames else None


@dataclass
class Backfill:
    client: object
    jobs: list[str]
    exps: dict[str, list[date]]
    max_dte: int = MAX_DTE
    keep_zero_oi: bool = False
    max_bytes: float = float("inf")
    denied: set = field(default_factory=set)  # {(job, root)}
    stop: threading.Event = field(default_factory=threading.Event)
    used: int = 0
    done: list = field(default_factory=list)  # log records written this run
    lock: threading.Lock = field(default_factory=threading.Lock)

    def fetch(self, job: str, root: str, d: date) -> tuple[int, int, pd.DataFrame | None, str]:
        """(rows fetched, rows kept, frame, status); status is 'unmatched' when the OI filter was skipped."""
        if job == "oi":
            oi = fetch_oi(self.client, root, d)
            n = 0 if oi is None else len(oi)
            return n, n, oi, "ok"
        oi = read_oi(root, d)
        if oi is None:
            return 0, 0, None, "ok"  # no OI that day, so no GEX either
        exps = expirations_for(self.exps.get(root, []), d, self.max_dte)
        live = None
        if not self.keep_zero_oi:
            live = live_contracts(oi)
            wanted = set(live["expiration"])
            exps = [e for e in exps if e.isoformat() in wanted]
        iv = fetch_iv(self.client, root, d, exps)
        if iv is None:
            return 0, 0, None, "ok"
        rows = len(iv)
        if live is not None:
            kept = keep_live(iv, live)
            if kept.empty:
                # No contract matched at all: the keys disagree (e.g. strikes restated by a
                # corporate action after the prior-close OI), so keep everything unfiltered.
                return rows, rows, iv, "unmatched"
            iv = kept
        return rows, len(iv), iv, "ok"

    def guard(self) -> None:
        if self.used > self.max_bytes or shutil.disk_usage(OUT_ROOT).free < MIN_FREE_BYTES:
            raise DiskGuard()

    def log(self, **rec) -> None:
        rec = {"at": datetime.now(timezone.utc).isoformat(timespec="seconds"), **rec}
        with self.lock:
            self.done.append(rec)
            with (OUT_ROOT / "fetch_log.jsonl").open("a") as f:
                f.write(json.dumps(rec) + "\n")
        print(f"{rec['job']:<7}{rec['root']:<6}{rec['date']}  {rec['status']:<7}"
              f"{rec['rows']:>10}{rec['rows_kept']:>10}{rec['bytes'] / 1e6:>9.1f}MB{rec['seconds']:>7.1f}s")

    def process(self, root: str, d: date) -> None:
        """Every requested job for one (root, date), oi first."""
        for job in self.jobs:
            if self.stop.is_set():
                return
            if (job, root) in self.denied or is_done(job, root, d):
                continue
            try:
                self.guard()
            except DiskGuard:
                self.stop.set()
                raise
            t0 = time.monotonic()
            base = dict(job=job, root=root, date=d.isoformat(), rows=0, rows_kept=0, bytes=0)
            try:
                rows, kept, df, note = self.fetch(job, root, d)
            except PermissionDenied:
                with self.lock:
                    first = (job, root) not in self.denied
                    self.denied.add((job, root))
                if first:
                    print(f"{job}/{root}: PERMISSION_DENIED on {d} — skipping this root/job for the rest of the run")
                self.log(**base, seconds=round(time.monotonic() - t0, 2), status="denied")
                continue
            except MissingOI:
                self.log(**base, seconds=0.0, status="no_oi")
                continue
            nbytes = write_partition(job, root, d, df)
            with self.lock:
                self.used += nbytes
            self.log(**{**base, "rows": rows, "rows_kept": kept, "bytes": nbytes},
                     seconds=round(time.monotonic() - t0, 2), status=(note if nbytes else "empty"))


# ---- probe ----------------------------------------------------------------------

def second_tuesday(year: int, month: int) -> date:
    first = date(year, month, 1)
    return first + timedelta(days=(1 - first.weekday()) % 7 + 7)


def probe_request(client, root: str, job: str, d: date, exps: list[date]):
    """DataFrame when data exists, None when not, 'denied' when the plan blocks it."""
    try:
        if job == "oi":
            return fetch_oi(client, root, d)
        near = expirations_for(exps, d, MAX_DTE)
        return fetch_iv(client, root, d, near[:1], strike_range=2) if near else None
    except PermissionDenied:
        return "denied"


def probe_root_job(client, root: str, job: str, today: date, exps: list[date]) -> dict:
    """Earliest month with data: yearly checkpoints, then bisect to the month (assumes monotone coverage)."""
    latest = second_tuesday(today.year, today.month)
    if latest >= today:
        prev = today.replace(day=1) - timedelta(days=1)
        latest = second_tuesday(prev.year, prev.month)
    head = probe_request(client, root, job, latest, exps)
    if isinstance(head, str):
        return {"status": "denied", "earliest": None}
    if head is None or head.empty:
        return {"status": "none", "earliest": None}
    info = {"status": "ok"}
    if job == "iv_5m":
        up = pd.to_numeric(head.get("underlying_price", pd.Series(dtype=float)), errors="coerce")
        info["underlying"] = "ok" if (up > 0).any() else "missing"

    def has(month: tuple[int, int]) -> bool:
        r = probe_request(client, root, job, second_tuesday(*month), exps)
        return isinstance(r, pd.DataFrame) and not r.empty

    def first_true(items: list) -> int:
        """Index of the first month with data; the last item is already known to have data."""
        lo, hi = 0, len(items) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if has(items[mid]):
                hi = mid
            else:
                lo = mid + 1
        return lo

    years = [(y, 1) for y in range(FIRST_YEAR, latest.year + 1) if second_tuesday(y, 1) < latest]
    i = first_true(years + [(latest.year, latest.month)])
    if i == 0:
        found = years[0] if years else (latest.year, latest.month)
    else:
        lo_y = years[i - 1][0]
        months = [(lo_y, m) for m in range(2, 13)] + [(lo_y + 1, 1)]
        months = [m for m in months if second_tuesday(*m) <= latest]
        found = months[first_true(months)]
    info["earliest"] = date(found[0], found[1], 1).isoformat()
    return info


def run_probe(get_client, roots: list[str]) -> int:
    client = get_client()
    today = datetime.now(ET).date()
    path = OUT_ROOT / "_probe.json"
    cached = json.loads(path.read_text()) if path.exists() else {"results": {}}
    print(f"{'root':<6}{'job':<8}{'status':<8}{'earliest':<12}underlying")
    for root in roots:
        try:
            exps = parse_expirations(with_retry(lambda: client.option_list_expirations(root)))
        except (NoDataFoundError, PermissionDenied):
            exps = []
        for job in JOBS:
            info = probe_root_job(client, root, job, today, exps)
            cached["results"].setdefault(root, {})[job] = info
            print(f"{root:<6}{job:<8}{info['status']:<8}{info.get('earliest') or '-':<12}{info.get('underlying', '-')}")
    cached["probed_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cached, indent=2))
    print(f"cached in {path}")
    return 0


# ---- main -----------------------------------------------------------------------

def dir_bytes(root: Path) -> int:
    return sum(p.stat().st_size for p in root.rglob("*") if p.is_file()) if root.exists() else 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("jobs", nargs="+", choices=["probe", *JOBS])
    ap.add_argument("--symbols", default=",".join(ROOTS), help="comma-separated subset of " + ",".join(ROOTS))
    ap.add_argument("--start", default=None, help="default: earliest date from `probe`")
    ap.add_argument("--end", default=None, help="exclusive, default today (ET)")
    ap.add_argument("--max-dte", type=int, default=MAX_DTE)
    ap.add_argument("--keep-zero-oi", action="store_true", help="keep IV rows for contracts with no open interest")
    ap.add_argument("--download", action="store_true", help="actually fetch (default is a dry run)")
    ap.add_argument("--limit", type=int, default=None, help="only the N newest pending (root, date) units")
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--max-gb", type=float, default=400.0, help="stop when data/thetadata exceeds this")
    args = ap.parse_args()

    symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    if not symbols or not set(symbols) <= set(ROOTS):
        ap.error(f"--symbols must be a subset of {','.join(ROOTS)}")
    roots = [r for s in symbols for r in ROOTS[s]]
    if "probe" in args.jobs and len(set(args.jobs)) > 1:
        ap.error("probe runs on its own")
    if args.max_dte < 0 or args.workers < 1 or (args.limit is not None and args.limit < 1) or args.max_gb <= 0:
        ap.error("--max-dte >= 0, --workers >= 1, --limit >= 1 and --max-gb > 0")
    try:
        start = date.fromisoformat(args.start) if args.start else None
        end = date.fromisoformat(args.end) if args.end else datetime.now(ET).date()
    except ValueError:
        ap.error("use YYYY-MM-DD dates")
    if start is not None and start >= end:
        ap.error("--start must be before --end")

    load_dotenv(REPO_ROOT / ".env")
    holder: list = []

    def get_client():
        if not holder:
            holder.append(ThetaClient(dataframe_type="pandas", dotenv_path=REPO_ROOT / ".env"))
        return holder[0]

    try:
        if args.jobs == ["probe"]:
            return run_probe(get_client, roots)
    except Exception as e:
        if holder:
            raise
        print(f"Could not create ThetaData client: {type(e).__name__}. Is THETADATA_API_KEY set?")
        return 1

    jobs = [j for j in JOBS if j in args.jobs]
    probe = json.loads((OUT_ROOT / "_probe.json").read_text()).get("results", {}) \
        if (OUT_ROOT / "_probe.json").exists() else {}
    starts: dict[tuple[str, str], date | None] = {}
    denied: set = set()
    for job in jobs:
        for root in roots:
            info = probe.get(root, {}).get(job, {})
            if info.get("status") == "denied":
                print(f"{job}/{root}: denied on this subscription (probe) — skipped")
                denied.add((job, root))
            if start is not None:
                starts[job, root] = start
            elif info.get("earliest"):
                s = date.fromisoformat(info["earliest"])
                oi_first = probe.get(root, {}).get("oi", {}).get("earliest")
                starts[job, root] = max(s, date.fromisoformat(oi_first)) if job == "iv_5m" and oi_first else s
            elif (job, root) not in denied:
                print(f"{job}/{root}: no start date — run `probe` first or pass --start")
                return 2
    live_pairs = [(j, r) for j in jobs for r in roots if (j, r) not in denied]
    if not live_pairs:
        print("Every requested root/job is denied on this subscription.")
        return 4

    first = min(starts[p] for p in live_pairs)
    try:
        closed = closed_days(get_client, range(max(first.year, FIRST_YEAR), end.year + 1))
    except Exception as e:
        if holder:
            raise
        print(f"Could not create ThetaData client: {type(e).__name__}. Is THETADATA_API_KEY set?")
        return 1
    days = trading_days(first, end, closed)

    print(f"{'job':<7}{'root':<6}{'start':<12}{'days':>7}{'have':>7}{'empty':>7}{'pending':>9}")
    units: dict[tuple[date, str], int] = {}
    pending: dict[str, set] = {job: set() for job in jobs}
    for job, root in live_pairs:
        mine = [d for d in days if d >= starts[job, root]]
        have = sum((partition_dir(job, root, d) / "part.parquet").exists() for d in mine)
        empty = sum((partition_dir(job, root, d) / "_empty").exists() for d in mine)
        pend = [d for d in mine if not is_done(job, root, d)]
        for d in pend:
            units[d, root] = units.get((d, root), 0) + 1
            pending[job].add((d, root))
        print(f"{job:<7}{root:<6}{starts[job, root].isoformat():<12}{len(mine):>7}{have:>7}{empty:>7}{len(pend):>9}")
    order = sorted(units, key=lambda u: (u[0], -roots.index(u[1])), reverse=True)  # newest first
    if args.limit is not None:
        order = order[:args.limit]
    total = sum(units.values())
    print(f"\npending: {total} partitions in {len(units)} (root, date) units; this run: "
          f"{sum(units[u] for u in order)} partitions in {len(order)} units")
    if not args.download:
        print("Dry run — nothing fetched. Re-run with --download (try --limit 10 first).")
        return 0

    OUT_ROOT.mkdir(parents=True, exist_ok=True)
    try:
        client = get_client()
    except Exception as e:
        print(f"Could not create ThetaData client: {type(e).__name__}. Is THETADATA_API_KEY set?")
        return 1
    exps: dict[str, list[date]] = {}
    if "iv_5m" in jobs:
        for root in roots:
            if ("iv_5m", root) in denied:
                continue
            try:
                exps[root] = parse_expirations(with_retry(lambda: client.option_list_expirations(root)))
            except NoDataFoundError:
                exps[root] = []
            except PermissionDenied:
                print(f"iv_5m/{root}: expirations denied — skipped")
                denied.add(("iv_5m", root))

    run = Backfill(client, jobs, exps, max_dte=args.max_dte, keep_zero_oi=args.keep_zero_oi,
                   max_bytes=args.max_gb * 1024**3, denied=denied, used=dir_bytes(OUT_ROOT))
    print(f"\n{'job':<7}{'root':<6}{'date':<12}{'status':<7}{'rows':>10}{'kept':>10}{'size':>11}{'time':>8}")
    t0 = time.monotonic()
    failure: BaseException | None = None
    disk_hit = interrupted = False
    ex = ThreadPoolExecutor(max_workers=args.workers)
    try:
        futures = [ex.submit(run.process, root, d) for d, root in order]
        for fut in as_completed(futures):
            exc = fut.exception()
            if isinstance(exc, DiskGuard):
                disk_hit = True
            elif exc is not None and failure is None:
                failure = exc
                run.stop.set()
    except KeyboardInterrupt:
        run.stop.set()
        interrupted = True
        print("interrupted — finishing in-flight partitions; re-run to resume")
    finally:
        ex.shutdown(wait=True, cancel_futures=True)
    wall = time.monotonic() - t0

    fetched = [r for r in run.done if r["status"] in ("ok", "empty", "unmatched")]
    print(f"\ndone: {len(fetched)} partitions, {sum(r['bytes'] for r in fetched) / 1e9:.2f} GB in {wall / 60:.1f} min")
    for job in jobs:
        mine = [r for r in fetched if r["job"] == job]
        left = sum(1 for d, root in pending[job] if (job, root) not in run.denied and not is_done(job, root, d))
        if mine and left:
            sec = sum(r["seconds"] for r in mine) / len(mine)
            mb = sum(r["bytes"] for r in mine) / len(mine) / 1e6
            print(f"{job}: {sec:.1f}s and {mb:.1f}MB per partition -> remaining ~{left} partitions: "
                  f"~{left * sec / args.workers / 3600:.1f} h, ~{left * mb / 1e3:.1f} GB")
    if failure is not None:
        code = grpc_code(failure)
        print(f"ThetaData operation failed ({type(failure).__name__}{', ' + code.name if code else ''}); "
              "completed partitions kept, re-run to resume.")
        return 1
    if disk_hit:
        print("Stopped by disk guard (--max-gb or <20 GB free). Completed partitions kept.")
        return 5
    if interrupted:
        return 130
    if all(p in run.denied for p in live_pairs):
        return 4
    return 0


def cli() -> int:
    try:
        return main()
    except Exception as exc:
        # SDK errors can carry request details. Report the type and gRPC code only.
        code = grpc_code(exc)
        print(f"ThetaData operation failed ({type(exc).__name__}{', ' + code.name if code else ''}); "
              "completed partitions kept, re-run to resume.")
        return 1


if __name__ == "__main__":
    sys.exit(cli())
