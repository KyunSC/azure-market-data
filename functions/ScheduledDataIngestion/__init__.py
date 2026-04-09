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

# Add parent directory to path so we can import GEXCalculator module
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from GEXCalculator.gex_calculator import fetch_prices_and_compute_gex, GEX_PAIRS

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
    """Fetch GEX every 15 minutes (all hours, all days)."""
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
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

def insert_gex_data(cursor, etf_symbol, gex_result):
    """Insert gamma exposure computation and its levels into the database."""
    cursor.execute("""
        INSERT INTO gamma_exposure
            (symbol, computed_at, etf_price, futures_price, conversion_ratio, expirations_used, market_open)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (
        etf_symbol,
        datetime.now(pytz.utc),
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

    return exposure_id

def fallback_gex_from_previous(cursor, etf_symbol):
    """Re-insert the most recent market-hours GEX data as a new entry."""
    cursor.execute("""
        SELECT id, etf_price, futures_price, conversion_ratio, expirations_used
        FROM gamma_exposure
        WHERE symbol = %s AND market_open = true
        ORDER BY computed_at DESC
        LIMIT 1
    """, (etf_symbol,))
    row = cursor.fetchone()
    if not row:
        return None

    prev_id, etf_price, futures_price, conversion_ratio, expirations_used = row

    cursor.execute("""
        SELECT strike_etf, strike_futures, gex, gex_call, gex_put, label
        FROM gamma_levels
        WHERE gamma_exposure_id = %s
    """, (prev_id,))
    levels = cursor.fetchall()
    if not levels:
        return None

    cursor.execute("""
        INSERT INTO gamma_exposure
            (symbol, computed_at, etf_price, futures_price, conversion_ratio, expirations_used, market_open)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (
        etf_symbol,
        datetime.now(pytz.utc),
        etf_price,
        futures_price,
        conversion_ratio,
        expirations_used,
        False,
    ))
    new_id = cursor.fetchone()[0]

    for strike_etf, strike_futures, gex, gex_call, gex_put, label in levels:
        cursor.execute("""
            INSERT INTO gamma_levels
                (gamma_exposure_id, strike_etf, strike_futures, gex, gex_call, gex_put, label)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (new_id, strike_etf, strike_futures, gex, gex_call, gex_put, label))

    return new_id

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

        # Fetch GEX data every 15 minutes (for all ETF/futures pairs)
        if should_fetch_gex():
            for etf_symbol in GEX_PAIRS:
                pair = GEX_PAIRS[etf_symbol]
                logging.info(f'Fetching gamma exposure for {etf_symbol}→{pair["futures"]}')
                try:
                    with ThreadPoolExecutor(max_workers=1) as executor:
                        future = executor.submit(fetch_prices_and_compute_gex, etf_symbol)
                        gex_result = future.result(timeout=60)

                    exposure_id = insert_gex_data(cursor, etf_symbol, gex_result)
                    conn.commit()
                    logging.info(f'Saved GEX data (id={exposure_id}), '
                                 f'{etf_symbol}={gex_result["etf_price"]}, '
                                 f'{pair["futures"]}={gex_result["futures_price"]}, '
                                 f'{len(gex_result["levels"])} levels')

                except (FuturesTimeoutError, Exception) as e:
                    logging.error(f'Error computing gamma exposure for {etf_symbol}: {e}')
                    logging.info(f'Falling back to previous market-hours GEX for {etf_symbol}')
                    try:
                        fallback_id = fallback_gex_from_previous(cursor, etf_symbol)
                        if fallback_id:
                            conn.commit()
                            logging.info(f'Fallback GEX saved for {etf_symbol} (id={fallback_id})')
                        else:
                            logging.warning(f'No previous market-hours GEX found for {etf_symbol}')
                    except Exception as fb_err:
                        logging.error(f'Fallback GEX failed for {etf_symbol}: {fb_err}')

    except Exception as e:
        logging.error(f'Database error: {e}')
        raise
    finally:
        if conn:
            conn.close()

    logging.info(f'ScheduledDataIngestion completed at {datetime.utcnow()}')
