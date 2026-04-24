import azure.functions as func
import yfinance as yf
import psycopg2
import os
import sys
import math
import logging
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import pytz

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.sanitize import sanitize_bar

TICKER_TIMEOUT_SECONDS = 10

def is_valid_number(value):
    """Check if value is a valid, usable number."""
    if value is None:
        return False
    try:
        num = float(value)
        return not (math.isnan(num) or math.isinf(num))
    except (TypeError, ValueError):
        return False

def fetch_ticker_data(symbol):
    """Fetch current price/volume for a ticker."""
    ticker_obj = yf.Ticker(symbol)
    info = ticker_obj.fast_info

    price = info.get('lastPrice')
    volume = info.get('lastVolume')

    result = {"symbol": symbol}

    if is_valid_number(price) and float(price) >= 0:
        result["price"] = float(price)
    else:
        result["price"] = None

    if is_valid_number(volume) and float(volume) >= 0:
        result["volume"] = int(volume)
    else:
        result["volume"] = None

    return result

def fetch_historical_data(symbol, period='5d', interval='1d'):
    """Fetch OHLC historical data for a ticker."""
    logging.info(f'fetch_historical_data called: symbol={symbol}, period={period}, interval={interval}')
    ticker = yf.Ticker(symbol)
    history = ticker.history(period=period, interval=interval)

    if history.empty:
        logging.warning(f'yfinance returned empty history for {symbol} {interval}/{period}')
        return None

    logging.info(f'yfinance returned {len(history)} rows for {symbol} {interval}/{period}')

    is_intraday = interval in ('1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h')

    data = []
    for date, row in history.iterrows():
        data.append({
            'date': date.to_pydatetime() if is_intraday else date.date(),
            'interval_type': interval,
            'open': round(float(row['Open']), 2),
            'high': round(float(row['High']), 2),
            'low': round(float(row['Low']), 2),
            'close': round(float(row['Close']), 2),
            'volume': int(row['Volume'])
        })

    return data

def get_ticker_list():
    """Get list of tickers from environment variable."""
    tickers_env = os.environ.get('TICKER_LIST', 'ES=F,NQ=F,^VIX')
    return [t.strip().upper() for t in tickers_env.split(',')]

def should_fetch_historical():
    """Check if we should fetch historical data (once daily around 4:30 PM ET)."""
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
    return now_et.hour == 16 and 25 <= now_et.minute <= 40

def should_fetch_intraday():
    """Check if we should fetch intraday data (during market hours, weekdays)."""
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
    if now_et.weekday() >= 5:
        return False
    if now_et.hour < 9 or (now_et.hour == 9 and now_et.minute < 30):
        return False
    if now_et.hour > 16 or (now_et.hour == 16 and now_et.minute > 15):
        return False
    return True

def get_db_connection():
    """Create connection to Supabase PostgreSQL."""
    return psycopg2.connect(os.environ['DATABASE_URL'])

def insert_market_data(cursor, symbol, price, volume, timestamp):
    """Insert a market data record."""
    cursor.execute("""
        INSERT INTO market_data (symbol, price, volume, timestamp)
        VALUES (%s, %s, %s, %s)
    """, (symbol, price, volume, timestamp))

def upsert_historical_data(cursor, symbol, data):
    """Upsert historical OHLC data.

    Each row is sanitized against the previous row's close to clamp yfinance
    phantom ticks (see shared.sanitize). Without this, re-ingestion would
    stamp the same bad OHLC back into Supabase every 5 min.
    """
    prev_close = None
    for row in data:
        clean = sanitize_bar(row, prev_close=prev_close)
        if clean is not row and (
            clean['open'] != row['open']
            or clean['high'] != row['high']
            or clean['low'] != row['low']
        ):
            logging.warning(
                'Sanitized phantom tick for %s %s @ %s: open %s→%s, high %s→%s, low %s→%s',
                symbol, row.get('interval_type'), row.get('date'),
                row['open'], clean['open'],
                row['high'], clean['high'],
                row['low'], clean['low'],
            )
        cursor.execute("""
            INSERT INTO historical_data
                (symbol, date, interval_type, open, high, low, close_price, volume, fetched_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (symbol, date, interval_type)
            DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close_price = EXCLUDED.close_price,
                volume = EXCLUDED.volume,
                fetched_at = EXCLUDED.fetched_at
        """, (
            symbol,
            clean['date'],
            clean['interval_type'],
            clean['open'],
            clean['high'],
            clean['low'],
            clean['close'],
            clean['volume'],
            datetime.utcnow()
        ))
        prev_close = clean['close']

def main(mytimer: func.TimerRequest) -> None:
    utc_timestamp = datetime.utcnow()

    if mytimer.past_due:
        logging.warning('Timer trigger is past due!')

    logging.info(f'ScheduledDataIngestion started at {utc_timestamp}')

    tickers = get_ticker_list()
    logging.info(f'Fetching data for tickers: {tickers}')

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

        # Fetch and persist current market data
        success_count = 0
        for symbol in tickers:
            try:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(fetch_ticker_data, symbol)
                    data = future.result(timeout=TICKER_TIMEOUT_SECONDS)

                if data and data.get('price') is not None:
                    insert_market_data(
                        cursor,
                        symbol=symbol,
                        price=data['price'],
                        volume=data.get('volume'),
                        timestamp=utc_timestamp
                    )
                    success_count += 1
                    logging.info(f'Saved {symbol}: ${data["price"]}')
                else:
                    logging.warning(f'No valid price data for {symbol}')

            except FuturesTimeoutError:
                logging.error(f'Timeout fetching {symbol}')
            except Exception as e:
                logging.error(f'Error fetching {symbol}: {e}')

        conn.commit()
        logging.info(f'Market data: {success_count}/{len(tickers)} tickers saved')

        # Fetch historical data once daily
        if should_fetch_historical():
            logging.info('Fetching historical data (daily run)')
            for symbol in tickers:
                try:
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(fetch_historical_data, symbol, '5d', '1d')
                        historical = future.result(timeout=TICKER_TIMEOUT_SECONDS)

                    if historical:
                        upsert_historical_data(cursor, symbol, historical)
                        logging.info(f'Saved historical data for {symbol}')
                    else:
                        logging.warning(f'No historical data for {symbol}')

                except FuturesTimeoutError:
                    logging.error(f'Timeout fetching historical for {symbol}')
                except Exception as e:
                    logging.error(f'Error fetching historical for {symbol}: {e}')

            conn.commit()
            logging.info('Historical data fetch complete')

        # Fetch intraday data — futures always, equities only during market hours
        et_tz = pytz.timezone('US/Eastern')
        now_et = datetime.now(et_tz)
        is_market_hours = should_fetch_intraday()
        futures_symbols = [s for s in tickers if s.endswith('=F')]
        equity_symbols = [s for s in tickers if not s.endswith('=F')]
        intraday_symbols = futures_symbols + (equity_symbols if is_market_hours else [])
        logging.info(f'Intraday check: ET={now_et.strftime("%Y-%m-%d %H:%M")} weekday={now_et.weekday()} market_hours={is_market_hours} symbols={intraday_symbols}')

        if intraday_symbols and now_et.weekday() < 5:
            logging.info(f'Fetching intraday data for {intraday_symbols}')
            intraday_intervals = [
                ('1m', '1d'),
                ('5m', '5d'),
                ('15m', '5d'),
                ('30m', '5d'),
                ('1h', '1mo'),
            ]
            for interval, period in intraday_intervals:
                for symbol in intraday_symbols:
                    try:
                        with ThreadPoolExecutor(max_workers=1) as executor:
                            future = executor.submit(fetch_historical_data, symbol, period, interval)
                            historical = future.result(timeout=30)

                        if historical:
                            upsert_historical_data(cursor, symbol, historical)
                            conn.commit()
                            logging.info(f'Saved {len(historical)} rows of {interval} data for {symbol}')
                        else:
                            logging.warning(f'No {interval} data for {symbol}')

                    except FuturesTimeoutError:
                        logging.error(f'Timeout fetching {interval} for {symbol}')
                    except Exception as e:
                        logging.exception(f'Error fetching {interval} for {symbol}: {e}')

            logging.info('Intraday data fetch complete')

    except Exception as e:
        logging.error(f'Database error: {e}')
        raise
    finally:
        if conn:
            conn.close()

    logging.info(f'ScheduledDataIngestion completed at {datetime.utcnow()}')
