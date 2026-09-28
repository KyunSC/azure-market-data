"""Price Databento pulls for the research window before downloading anything.

metadata.get_cost / get_billable_size are free — no credits are spent. Each row
is one (dataset, symbols, schema) request over [--start, --end).

Futures use volume-rolled continuous contracts (ES.v.0 = the most-traded ES
contract each day). Options use parent symbology (QQQ.OPT = every QQQ option).
`statistics` carries open interest; `definition` carries strike/expiry/type —
together they are what gex_calculator needs, minus the underlying price.

Needs DATABENTO_API_KEY in the environment or in the repo-root .env.

Run: python functions/ml/databento_cost.py
     python functions/ml/databento_cost.py --start 2026-09-15 --end 2026-09-20
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import databento as db
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]

# Research window of the current feature parquets (functions/ml/data/*_5m_features_*.parquet).
DEFAULT_START = "2026-04-24"
DEFAULT_END = "2026-09-24"  # exclusive

FUTURES = ["ES.v.0", "NQ.v.0"]

REQUESTS = [
    # (label, dataset, symbols, stype_in, schema)
    ("ES+NQ 1m bars", "GLBX.MDP3", FUTURES, "continuous", "ohlcv-1m"),
    ("ES+NQ trades", "GLBX.MDP3", FUTURES, "continuous", "trades"),
    ("ES+NQ top of book", "GLBX.MDP3", FUTURES, "continuous", "mbp-1"),
    ("ES+NQ 10-level book", "GLBX.MDP3", FUTURES, "continuous", "mbp-10"),
    ("ES+NQ full order book", "GLBX.MDP3", FUTURES, "continuous", "mbo"),
    ("ES+NQ futures options defs", "GLBX.MDP3", ["ES.OPT", "NQ.OPT"], "parent", "definition"),
    ("ES+NQ futures options OI", "GLBX.MDP3", ["ES.OPT", "NQ.OPT"], "parent", "statistics"),
    ("QQQ+SPY options defs", "OPRA.PILLAR", ["QQQ.OPT", "SPY.OPT"], "parent", "definition"),
    ("QQQ+SPY options OI", "OPRA.PILLAR", ["QQQ.OPT", "SPY.OPT"], "parent", "statistics"),
    ("QQQ+SPY options 1m NBBO", "OPRA.PILLAR", ["QQQ.OPT", "SPY.OPT"], "parent", "cbbo-1m"),
    ("QQQ+SPY options trades", "OPRA.PILLAR", ["QQQ.OPT", "SPY.OPT"], "parent", "trades"),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--start", default=DEFAULT_START)
    ap.add_argument("--end", default=DEFAULT_END, help="exclusive")
    args = ap.parse_args()

    load_dotenv(REPO_ROOT / ".env")
    try:
        client = db.Historical()
    except Exception as e:  # missing/invalid key — report the symptom only
        print(f"Could not create Databento client: {type(e).__name__}. Is DATABENTO_API_KEY set?")
        return 1

    print(f"Window: {args.start} -> {args.end} (exclusive)\n")
    print(f"{'request':<30}{'schema':<12}{'size':>12}{'cost':>12}")
    total = 0.0
    for label, dataset, symbols, stype_in, schema in REQUESTS:
        q = dict(dataset=dataset, symbols=symbols, stype_in=stype_in, schema=schema,
                 start=args.start, end=args.end)
        try:
            size = client.metadata.get_billable_size(**q)
            cost = client.metadata.get_cost(**q)
        except Exception as e:
            print(f"{label:<30}{schema:<12}{'error: ' + str(e).splitlines()[0][:60]:>24}")
            continue
        total += cost
        print(f"{label:<30}{schema:<12}{size / 1e9:>10.2f}GB{cost:>11.2f}$")
    print(f"\n{'everything above':<42}{total:>23.2f}$")
    return 0


if __name__ == "__main__":
    sys.exit(main())
