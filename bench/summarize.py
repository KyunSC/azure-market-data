#!/usr/bin/env python3
"""Summarize bench CSVs.

    python3 summarize.py results/cache_ab.csv            # marginal summary
    python3 summarize.py --paired results/cache_ab.csv   # paired cold-vs-warm

Paired mode is the one that matters for the cache arm. Response payloads differ
by an order of magnitude across cache keys (14 KB .. 2 MB), so pooling all cold
times against all warm times compares different workloads. Pairing each trial's
cold request against the median of the warm requests for that same key holds
payload, route and network conditions fixed; the per-trial speedups are then
aggregated as a median of ratios.
"""
import csv
import statistics
import sys
from collections import defaultdict


def pct(xs, p):
    xs = sorted(xs)
    if len(xs) == 1:
        return xs[0]
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def load(paths):
    rows = []
    for path in paths:
        with open(path) as f:
            for r in csv.DictReader(f):
                if not r["http_code"].startswith("2"):
                    continue
                r["seconds"] = float(r["seconds"])
                r["ttfb"] = float(r.get("ttfb") or r["seconds"])
                r["bytes"] = int(r["bytes"])
                if r["seconds"] < 0:
                    continue
                rows.append(r)
    return rows


def marginal(rows):
    g = defaultdict(list)
    for r in rows:
        g[(r["arm"], r["phase"], r["endpoint"])].append(r)
    print(f"{'arm':<10} {'phase':<6} {'endpoint':<12} {'n':>4} "
          f"{'ttfb p50':>10} {'ttfb p95':>10} {'total p50':>11} {'KB':>8}")
    print("-" * 78)
    for k in sorted(g):
        rs = g[k]
        print(f"{k[0]:<10} {k[1]:<6} {k[2]:<12} {len(rs):>4} "
              f"{pct([r['ttfb'] for r in rs], .5) * 1000:>9.0f}m "
              f"{pct([r['ttfb'] for r in rs], .95) * 1000:>9.0f}m "
              f"{pct([r['seconds'] for r in rs], .5) * 1000:>10.0f}m "
              f"{statistics.median(r['bytes'] for r in rs) / 1024:>8.0f}")


def paired(rows):
    cold, warm = defaultdict(list), defaultdict(list)
    for r in rows:
        (cold if r["phase"] == "cold" else warm)[(r["trial"], r["endpoint"])].append(r)

    per_ep = defaultdict(list)
    print(f"{'endpoint':<10} {'trial':>5} {'KB':>7} {'cold ttfb':>10} "
          f"{'warm ttfb':>10} {'speedup':>8} {'saved':>9}")
    print("-" * 64)
    for key in sorted(cold, key=lambda k: (k[1], int(k[0]))):
        if key not in warm:
            continue
        c = statistics.median(r["ttfb"] for r in cold[key])
        w = statistics.median(r["ttfb"] for r in warm[key])
        kb = statistics.median(r["bytes"] for r in cold[key]) / 1024
        per_ep[key[1]].append((c, w, c / w if w else float("nan")))
        print(f"{key[1]:<10} {key[0]:>5} {kb:>7.0f} {c * 1000:>9.0f}m "
              f"{w * 1000:>9.0f}m {c / w:>7.2f}x {(c - w) * 1000:>8.0f}m")

    print()
    print(f"{'endpoint':<10} {'pairs':>6} {'median cold':>12} {'median warm':>12} "
          f"{'median speedup':>15} {'median saved':>13}")
    print("-" * 74)
    allc, allw, allr = [], [], []
    for ep, trips in sorted(per_ep.items()):
        cs = [t[0] for t in trips]; ws = [t[1] for t in trips]; rs = [t[2] for t in trips]
        allc += cs; allw += ws; allr += rs
        print(f"{ep:<10} {len(trips):>6} {statistics.median(cs) * 1000:>11.0f}m "
              f"{statistics.median(ws) * 1000:>11.0f}m {statistics.median(rs):>14.2f}x "
              f"{(statistics.median(cs) - statistics.median(ws)) * 1000:>12.0f}m")
    if allr:
        print(f"{'ALL':<10} {len(allr):>6} {statistics.median(allc) * 1000:>11.0f}m "
              f"{statistics.median(allw) * 1000:>11.0f}m {statistics.median(allr):>14.2f}x "
              f"{(statistics.median(allc) - statistics.median(allw)) * 1000:>12.0f}m")


args = sys.argv[1:]
mode_paired = "--paired" in args
rows = load([a for a in args if not a.startswith("--")])
(paired if mode_paired else marginal)(rows)
