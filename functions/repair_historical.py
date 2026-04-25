"""One-shot repair: scan historical_data and clamp phantom ticks.

Walks the table in (symbol, interval_type, date) order, applies the same
shared.sanitize.sanitize_bar logic the ingestion pipeline uses, and rewrites
any row whose OHLC changed. Uses a rolling window of recently-cleaned closes
as the witness — robust against runs of consecutive phantom bars that would
slip through a single-prev_close witness.

Usage:
    # Dry-run (default) — prints every would-be change, no writes
    DATABASE_URL=... python3 repair_historical.py

    # Apply changes
    DATABASE_URL=... python3 repair_historical.py --apply

    # Limit scope
    DATABASE_URL=... python3 repair_historical.py --symbol NQ=F --interval 1m
"""

import argparse
import json
import os
import sys

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shared.sanitize import sanitize_bar

SANITIZE_WINDOW_SIZE = 5


def load_db_url():
    url = os.environ.get('DATABASE_URL')
    if url:
        return url
    settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'local.settings.json')
    if os.path.exists(settings_path):
        with open(settings_path) as f:
            data = json.load(f)
        url = data.get('Values', {}).get('DATABASE_URL')
        if url:
            return url
    raise SystemExit('DATABASE_URL not set and local.settings.json has no value')


def iter_groups(cursor, symbol=None, interval=None):
    """Yield (symbol, interval_type) pairs present in the table."""
    sql = 'SELECT DISTINCT symbol, interval_type FROM historical_data'
    clauses = []
    params = []
    if symbol:
        clauses.append('symbol = %s')
        params.append(symbol)
    if interval:
        clauses.append('interval_type = %s')
        params.append(interval)
    if clauses:
        sql += ' WHERE ' + ' AND '.join(clauses)
    sql += ' ORDER BY symbol, interval_type'
    cursor.execute(sql, params)
    return cursor.fetchall()


def repair_group(conn, symbol, interval_type, apply_changes):
    """Sanitize all rows for one (symbol, interval_type). Returns (scanned, changed)."""
    read = conn.cursor()
    read.execute(
        """
        SELECT date, open, high, low, close_price, volume
        FROM historical_data
        WHERE symbol = %s AND interval_type = %s
        ORDER BY date ASC
        """,
        (symbol, interval_type),
    )

    prev_close = None
    recent_closes = []
    changed = 0
    scanned = 0

    write = conn.cursor()
    for date, open_p, high_p, low_p, close_p, volume in read:
        scanned += 1
        if close_p is None:
            continue
        row = {
            'open': float(open_p) if open_p is not None else None,
            'high': float(high_p) if high_p is not None else None,
            'low': float(low_p) if low_p is not None else None,
            'close': float(close_p),
        }
        clean = sanitize_bar(row, prev_close=prev_close, recent_closes=recent_closes)
        prev_close = clean['close']
        recent_closes.append(clean['close'])
        if len(recent_closes) > SANITIZE_WINDOW_SIZE:
            recent_closes.pop(0)

        if clean is row:
            continue

        diffs = []
        for field in ('open', 'high', 'low'):
            before = row.get(field)
            after = clean.get(field)
            if before is None or after is None:
                continue
            if abs(before - after) > 1e-6:
                diffs.append((field, before, after))

        if not diffs:
            continue

        changed += 1
        diff_str = ', '.join(f'{f} {b}->{a}' for f, b, a in diffs)
        print(f'  {symbol} {interval_type} {date}: {diff_str}')

        if apply_changes:
            write.execute(
                """
                UPDATE historical_data
                SET open = %s, high = %s, low = %s
                WHERE symbol = %s AND date = %s AND interval_type = %s
                """,
                (clean['open'], clean['high'], clean['low'], symbol, date, interval_type),
            )

    read.close()
    write.close()
    return scanned, changed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--apply', action='store_true', help='Write changes (default: dry-run)')
    parser.add_argument('--symbol', help='Restrict to one symbol, e.g. NQ=F')
    parser.add_argument('--interval', help='Restrict to one interval_type, e.g. 1m')
    args = parser.parse_args()

    conn = psycopg2.connect(load_db_url())
    conn.autocommit = False

    try:
        with conn.cursor() as c:
            groups = iter_groups(c, args.symbol, args.interval)

        if not groups:
            print('No matching rows in historical_data.')
            return

        total_scanned = 0
        total_changed = 0
        mode = 'APPLY' if args.apply else 'DRY-RUN'
        print(f'[{mode}] scanning {len(groups)} (symbol, interval) groups')

        for symbol, interval_type in groups:
            print(f'\n-- {symbol} / {interval_type} --')
            scanned, changed = repair_group(conn, symbol, interval_type, args.apply)
            total_scanned += scanned
            total_changed += changed
            print(f'  scanned={scanned} changed={changed}')

        if args.apply:
            conn.commit()
            print(f'\n[APPLY] committed. total scanned={total_scanned} changed={total_changed}')
        else:
            conn.rollback()
            print(f'\n[DRY-RUN] no writes. total scanned={total_scanned} would-change={total_changed}')
            print('Run with --apply to persist.')

    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


if __name__ == '__main__':
    main()
