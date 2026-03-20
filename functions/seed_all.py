"""Seed maximum historical data for all timeframes."""
import yfinance as yf
import psycopg2
from psycopg2.extras import execute_values
from datetime import datetime, timezone

LOCAL_DB = "dbname=marketmonitor user=sunny host=localhost port=5432"
SUPABASE_DB = "postgresql://postgres.latqdamkyjttyleplqzj:wr%25QN5G8w4U%40nC%25%25@aws-0-us-west-2.pooler.supabase.com:6543/postgres"
TICKERS = ['ES=F', 'NQ=F']

# Max periods per yfinance limits
INTERVALS = [
    ('1m',  '7d'),      # max 7 days
    ('5m',  '60d'),     # max 60 days
    ('15m', '60d'),     # max 60 days
    ('1h',  '730d'),    # max 730 days
    ('1d',  'max'),     # all available history
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

if __name__ == '__main__':
    seed_db(LOCAL_DB, "local")
    seed_db(SUPABASE_DB, "supabase")
