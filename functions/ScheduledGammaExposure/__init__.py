import azure.functions as func
import psycopg2
import os
import sys
import logging
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import pytz

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from GEXCalculator.gex_calculator import (
    fetch_prices_and_compute_gex,
    GEX_PAIRS,
    is_market_open,
    is_premarket_window,
)


def get_db_connection():
    return psycopg2.connect(os.environ['DATABASE_URL'])


def insert_gex_data(cursor, etf_symbol, gex_result):
    cursor.execute("""
        INSERT INTO gamma_exposure
            (symbol, computed_at, etf_price, futures_price, conversion_ratio,
             expirations_used, market_open,
             pcr_volume, pcr_oi, iv_atm, iv_skew)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (
        etf_symbol,
        datetime.now(pytz.utc),
        gex_result['etf_price'],
        gex_result['futures_price'],
        gex_result['conversion_ratio'],
        ','.join(gex_result['expirations_used']),
        gex_result['market_open'],
        gex_result.get('pcr_volume'),
        gex_result.get('pcr_oi'),
        gex_result.get('iv_atm'),
        gex_result.get('iv_skew'),
    ))
    exposure_id = cursor.fetchone()[0]

    for level in gex_result['levels']:
        cursor.execute("""
            INSERT INTO gamma_levels
                (gamma_exposure_id, strike_etf, strike_futures, gex, gex_call, gex_put,
                 gex_0dte, gex_1dte, gex_weekly, gex_monthly, label)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (
            exposure_id,
            level['strike_etf'],
            level['strike_futures'],
            level['gex'],
            level.get('gex_call'),
            level.get('gex_put'),
            level.get('gex_0dte'),
            level.get('gex_1dte'),
            level.get('gex_weekly'),
            level.get('gex_monthly'),
            level['label'],
        ))

    return exposure_id


def fallback_gex_from_previous(cursor, etf_symbol):
    """Re-insert the most recent VALID GEX row as a new entry.

    Filters out rows with null prices or null strike data so a chain of failed
    fallbacks can't propagate empty strikes forward (which produced the
    "no GEX lines on NQ" symptom — every level had strike_futures=null).
    """
    cursor.execute("""
        SELECT ge.id, ge.etf_price, ge.futures_price, ge.conversion_ratio, ge.expirations_used
        FROM gamma_exposure ge
        WHERE ge.symbol = %s
          AND ge.etf_price IS NOT NULL
          AND ge.futures_price IS NOT NULL
          AND EXISTS (
              SELECT 1 FROM gamma_levels gl
              WHERE gl.gamma_exposure_id = ge.id
                AND gl.strike_futures IS NOT NULL
                AND gl.strike_etf IS NOT NULL
          )
        ORDER BY ge.computed_at DESC
        LIMIT 1
    """, (etf_symbol,))
    row = cursor.fetchone()
    if not row:
        return None

    prev_id, etf_price, futures_price, conversion_ratio, expirations_used = row

    cursor.execute("""
        SELECT strike_etf, strike_futures, gex, gex_call, gex_put,
               gex_0dte, gex_1dte, gex_weekly, gex_monthly, label
        FROM gamma_levels
        WHERE gamma_exposure_id = %s
          AND strike_etf IS NOT NULL
          AND strike_futures IS NOT NULL
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

    for (strike_etf, strike_futures, gex, gex_call, gex_put,
         gex_0dte, gex_1dte, gex_weekly, gex_monthly, label) in levels:
        cursor.execute("""
            INSERT INTO gamma_levels
                (gamma_exposure_id, strike_etf, strike_futures, gex, gex_call, gex_put,
                 gex_0dte, gex_1dte, gex_weekly, gex_monthly, label)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """, (new_id, strike_etf, strike_futures, gex, gex_call, gex_put,
              gex_0dte, gex_1dte, gex_weekly, gex_monthly, label))

    return new_id


def run_gex(premarket: bool = False) -> None:
    """Compute and persist GEX for all pairs.

    premarket=False: gated by is_market_open() (regular 5-min intraday cadence).
    premarket=True:  gated by is_premarket_window() so the 9:25 ET pre-open run
    only fires on the DST-correct UTC tick. QQQ price will be a stale close but
    NQ trades overnight, so strike labels are usable at the opening bell.
    """
    if premarket:
        if not is_premarket_window():
            logging.info('Outside 9:00-9:30 ET premarket window — skipping.')
            return
    else:
        # QQQ/SPY option chains don't change while CBOE is closed; skipping closed
        # sessions avoids ~70% of upstream calls and credit burn.
        if not is_market_open():
            logging.info('Equity market closed — skipping GEX computation.')
            return

    conn = None
    try:
        conn = get_db_connection()
        cursor = conn.cursor()

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
        logging.error(f'Database error in ScheduledGammaExposure: {e}')
        raise
    finally:
        if conn:
            conn.close()

    logging.info(f'GEX run completed at {datetime.utcnow()} (premarket={premarket})')


def main(mytimer: func.TimerRequest) -> None:
    if mytimer.past_due:
        logging.warning('ScheduledGammaExposure timer trigger is past due!')
    logging.info(f'ScheduledGammaExposure started at {datetime.utcnow()}')
    run_gex(premarket=False)
