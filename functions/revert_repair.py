"""Revert changes made by repair_historical.py by replaying its apply log.

Each line of the form
    SYMBOL INTERVAL DATE: field old->new[, field old->new]*
becomes UPDATE statements that restore the `old` value for each field.

Only `open`, `high`, `low` are touched (those are the only fields
sanitize_bar can change). `--exclude-interval 1m` lets you keep the
legitimate 1m phantom fixes while reverting everything else.

Commits in chunks to keep transactions short on Supabase.

Usage:
    python3 revert_repair.py LOGFILE                          # dry-run
    python3 revert_repair.py LOGFILE --apply
    python3 revert_repair.py LOGFILE --apply --exclude-interval 1m
"""

import argparse
import os
import re
import sys
from datetime import datetime

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from repair_historical import load_db_url

LINE_RE = re.compile(r'^\s+(\S+)\s+(\S+)\s+(.+?):\s+(.+)$')
CHANGE_RE = re.compile(r'(open|high|low)\s+([-\d.]+)->([-\d.]+)')

CHUNK_SIZE = 500  # commit every N updates so a hiccup doesn't lose the lot


def parse_date(s):
    s = s.strip()
    for fmt in ('%Y-%m-%d %H:%M:%S%z', '%Y-%m-%d %H:%M:%S'):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    try:
        return datetime.strptime(s, '%Y-%m-%d').date()
    except ValueError:
        return None


def parse_log(path, exclude_intervals):
    edits = []
    with open(path) as f:
        for line in f:
            m = LINE_RE.match(line.rstrip())
            if not m:
                continue
            symbol, interval, date_s, changes_s = m.groups()
            if interval in exclude_intervals:
                continue
            d = parse_date(date_s)
            if d is None:
                continue
            for cm in CHANGE_RE.finditer(changes_s):
                field, old_s, _new_s = cm.groups()
                edits.append((symbol, interval, d, field, float(old_s)))
    return edits


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('logfile')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--exclude-interval', action='append', default=[])
    args = parser.parse_args()

    excluded = set(args.exclude_interval)
    edits = parse_log(args.logfile, excluded)

    by_group = {}
    for (s, iv, _d, _f, _v) in edits:
        by_group[(s, iv)] = by_group.get((s, iv), 0) + 1

    print(f'Parsed {len(edits)} field reverts from {args.logfile}')
    if excluded:
        print(f'Excluded intervals: {sorted(excluded)}')
    for (s, iv), n in sorted(by_group.items()):
        print(f'  {s} {iv}: {n}')

    if not args.apply:
        print('\n[DRY-RUN] no writes. Pass --apply to commit.')
        return

    conn = psycopg2.connect(load_db_url())
    conn.autocommit = False
    cur = conn.cursor()
    written = 0
    try:
        for (symbol, interval, date_obj, field, old_val) in edits:
            cur.execute(
                f'UPDATE historical_data SET {field} = %s '
                f'WHERE symbol = %s AND interval_type = %s AND date = %s',
                (old_val, symbol, interval, date_obj),
            )
            written += 1
            if written % CHUNK_SIZE == 0:
                conn.commit()
                print(f'  committed chunk: {written}/{len(edits)}', flush=True)
        conn.commit()
        print(f'\n[APPLY] committed {written} field reverts')
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == '__main__':
    main()
