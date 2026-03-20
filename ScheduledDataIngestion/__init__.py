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

# Add parent directory to path so we can import shared module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from shared.gex_calculator import fetch_prices_and_compute_gex

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
    ticker = yf.Ticker(symbol)
    history = ticker.history(period=period, interval=interval)

    if history.empty:
        return None

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
    tickers_env = os.environ.get('TICKER_LIST', 'ES=F,NQ=F')
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

def should_fetch_gex():
    """Fetch GEX every 15 minutes during market hours (weekday 9:30-16:15 ET)."""
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
    if now_et.weekday() >= 5:
        return False
    if now_et.hour < 9 or (now_et.hour == 9 and now_et.minute < 30):
        return False
    if now_et.hour > 16 or (now_et.hour == 16 and now_et.minute > 15):
        return False
    return now_et.minute % 15 < 2

def get_db_connection():
    """Create connection to Supabase PostgreSQL."""
    return psycopg2.connect(os.environ['DATABASE_URL'])

def insert_market_data(cursor, symbol, price, volume, timestamp):
    """Insert a market data record."""
    cursor.execute("""
        INSERT INTO market_data (symbol, price, volume, timestamp)
        VALUES (%s, %s, %s, %s)
    """, (symbol, price, volume, timestamp))

def insert_gex_data(cursor, gex_result):
    """Insert gamma exposure computation and its levels into the database."""
    cursor.execute("""
        INSERT INTO gamma_exposure
            (symbol, computed_at, qqq_price, nq_price, conversion_ratio, expirations_used, market_open)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (
        'QQQ',
        datetime.now(pytz.utc),
        gex_result['qqq_price'],
        gex_result['nq_price'],
        gex_result['conversion_ratio'],
        ','.join(gex_result['expirations_used']),
        gex_result['market_open'],
    ))
    exposure_id = cursor.fetchone()[0]

    for level in gex_result['levels']:
        cursor.execute("""
            INSERT INTO gamma_levels
                (gamma_exposure_id, strike_qqq, strike_nq, gex, gex_call, gex_put, label)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            exposure_id,
            level['strike_qqq'],
            level['strike_nq'],
            level['gex'],
            level.get('gex_call'),
            level.get('gex_put'),
            level['label'],
        ))

    return exposure_id

def upsert_historical_data(cursor, symbol, data):
    """Upsert historical OHLC data."""
    for row in data:
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
            row['date'],
            row['interval_type'],
            row['open'],
            row['high'],
            row['low'],
            row['close'],
            row['volume'],
            datetime.utcnow()
        ))

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

        # Fetch intraday data (1m, 5m, 15m, 1h) during market hours
        if should_fetch_intraday():
            logging.info('Fetching intraday data (1m, 5m, 15m, 1h)')
            intraday_intervals = [
                ('1m', '1d'),
                ('5m', '5d'),
                ('15m', '5d'),
                ('1h', '1mo'),
            ]
            for interval, period in intraday_intervals:
                for symbol in tickers:
                    try:
                        with ThreadPoolExecutor(max_workers=1) as executor:
                            future = executor.submit(fetch_historical_data, symbol, period, interval)
                            historical = future.result(timeout=TICKER_TIMEOUT_SECONDS)

                        if historical:
                            upsert_historical_data(cursor, symbol, historical)
                            logging.info(f'Saved {interval} data for {symbol}')
                        else:
                            logging.warning(f'No {interval} data for {symbol}')

                    except FuturesTimeoutError:
                        logging.error(f'Timeout fetching {interval} for {symbol}')
                    except Exception as e:
                        logging.error(f'Error fetching {interval} for {symbol}: {e}')

            conn.commit()
            logging.info('Intraday data fetch complete')

        # Fetch GEX data every 15 minutes during market hours
        if should_fetch_gex():
            logging.info('Fetching gamma exposure data (15-min run)')
            try:
                with ThreadPoolExecutor(max_workers=1) as executor:
                    future = executor.submit(fetch_prices_and_compute_gex)
                    gex_result = future.result(timeout=60)

                exposure_id = insert_gex_data(cursor, gex_result)
                conn.commit()
                logging.info(f'Saved GEX data (id={exposure_id}), '
                             f'QQQ={gex_result["qqq_price"]}, '
                             f'NQ={gex_result["nq_price"]}, '
                             f'{len(gex_result["levels"])} levels')

            except FuturesTimeoutError:
                logging.error('Timeout computing gamma exposure')
            except Exception as e:
                logging.error(f'Error computing gamma exposure: {e}')

    except Exception as e:
        logging.error(f'Database error: {e}')
        raise
    finally:
        if conn:
            conn.close()

    logging.info(f'ScheduledDataIngestion completed at {datetime.utcnow()}')
