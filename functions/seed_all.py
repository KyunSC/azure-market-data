"""Seed maximum historical data for all timeframes."""
import sys
import os
sys.path.insert(0, os.path.dirname(__file__))

import yfinance as yf
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone
from GEXCalculator.gex_calculator import fetch_prices_and_compute_gex, GEX_PAIRS

LOCAL_DB = "dbname=marketmonitor user=sunny host=localhost port=5432"
SUPABASE_DB = "postgresql://postgres.latqdamkyjttyleplqzj:wr%25QN5G8w4U%40nC%25%25@aws-0-us-west-2.pooler.supabase.com:6543/postgres"
TICKERS = ['ES=F', 'NQ=F', '^VIX']

# Max periods per yfinance limits
INTERVALS = [
    ('1m',  '7d'),      # max 7 days
    ('5m',  '60d'),     # max 60 days
    ('15m', '60d'),     # max 60 days
    ('30m', '60d'),     # max 60 days
    ('1h',  '730d'),    # max 730 days
    ('1d',  'max'),     # all available history
    ('1wk', 'max'),     # weekly all-time
]

def log(msg):
    print(msg, flush=True)

def fetch_historical(symbol, interval, period):
    ticker = yf.Ticker(symbol)
    history = ticker.history(period=period, interval=interval)
    if history.empty:
        return []
    data = []
    for date, row in history.iterrows():
        data.append((
            symbol,
            date.to_pydatetime(),
            interval,
            round(float(row['Open']), 2),
            round(float(row['High']), 2),
            round(float(row['Low']), 2),
            round(float(row['Close']), 2),
            int(row['Volume']),
            datetime.now(timezone.utc),
        ))
    return data

def upsert_batch(cursor, rows):
    execute_values(cursor, """
        INSERT INTO historical_data
            (symbol, date, interval_type, open, high, low, close_price, volume, fetched_at)
        VALUES %s
        ON CONFLICT (symbol, date, interval_type)
        DO UPDATE SET
            open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            close_price = EXCLUDED.close_price,
            volume = EXCLUDED.volume,
            fetched_at = EXCLUDED.fetched_at
    """, rows, page_size=500)

def seed_db(conn_str, label):
    conn = psycopg2.connect(conn_str)
    cursor = conn.cursor()
    total = 0

    for interval, period in INTERVALS:
        for symbol in TICKERS:
            log(f"[{label}] {interval} {symbol} (period={period})...")
            rows = fetch_historical(symbol, interval, period)
            if rows:
                upsert_batch(cursor, rows)
                total += len(rows)
                log(f"  -> {len(rows)} rows")
            else:
                log(f"  -> No data")
        conn.commit()

    cursor.execute("SELECT interval_type, count(*) FROM historical_data GROUP BY interval_type ORDER BY interval_type")
    log(f"\n[{label}] DB totals:")
    for row in cursor.fetchall():
        log(f"  {row[0]}: {row[1]} rows")
    conn.close()
    log(f"[{label}] Done! {total} rows upserted\n")

def seed_gex(conn_str, label):
    for etf_symbol in GEX_PAIRS:
        pair = GEX_PAIRS[etf_symbol]
        log(f"[{label}] Computing GEX levels for {etf_symbol}→{pair['futures']}...")
        try:
            gex_result = fetch_prices_and_compute_gex(etf_symbol)
            log(f"[{label}] {etf_symbol}={gex_result['etf_price']}, {pair['futures']}={gex_result['futures_price']}, {len(gex_result['levels'])} key levels")

            conn = psycopg2.connect(conn_str)
            cursor = conn.cursor()

            cursor.execute("""
                INSERT INTO gamma_exposure
                    (symbol, computed_at, etf_price, futures_price, conversion_ratio, expirations_used, market_open)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                RETURNING id
            """, (
                etf_symbol,
                datetime.now(timezone.utc),
                gex_result['etf_price'],
                gex_result['futures_price'],
                gex_result['conversion_ratio'],
                ','.join(gex_result['expirations_used']),
                gex_result['market_open'],
            ))
            exposure_id = cursor.fetchone()[0]

            for level in gex_result['levels']:
                cursor.execute("""
                    INSERT INTO gamma_levels
                        (gamma_exposure_id, strike_etf, strike_futures, gex, gex_call, gex_put, label)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                """, (
                    exposure_id,
                    level['strike_etf'],
                    level['strike_futures'],
                    level['gex'],
                    level.get('gex_call'),
                    level.get('gex_put'),
                    level['label'],
                ))

            conn.commit()
            conn.close()
            log(f"[{label}] GEX seeded for {etf_symbol}: {len(gex_result['levels'])} levels (exposure_id={exposure_id})")
        except Exception as e:
            log(f"[{label}] GEX seed failed for {etf_symbol}: {e}")

if __name__ == '__main__':
    seed_db(LOCAL_DB, "local")
    seed_gex(LOCAL_DB, "local")
    seed_db(SUPABASE_DB, "supabase")
    seed_gex(SUPABASE_DB, "supabase")
