import math
import logging
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FuturesTimeoutError
import yfinance as yf
import pytz

TICKER_TIMEOUT_SECONDS = 30
RISK_FREE_RATE = 0.05
MAX_EXPIRATIONS = 4
MAX_DAYS_OUT = 30
MIN_T_YEARS = 1 / 365
MIN_IV = 0.01


def norm_pdf(x):
    """Standard normal probability density function (avoids scipy dependency)."""
    return math.exp(-0.5 * x * x) / math.sqrt(2 * math.pi)


def black_scholes_gamma(S, K, T, r, sigma):
    """Calculate Black-Scholes gamma for a European option."""
    if T <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        return 0.0
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    gamma = norm_pdf(d1) / (S * sigma * math.sqrt(T))
    return gamma


def is_market_open():
    """Check if US equity market is currently open."""
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
    if now_et.weekday() >= 5:
        return False
    market_open = now_et.hour > 9 or (now_et.hour == 9 and now_et.minute >= 30)
    market_close = now_et.hour < 16
    return market_open and market_close


def fetch_option_chain(ticker_symbol, expiration):
    """Fetch option chain for a single expiration."""
    ticker = yf.Ticker(ticker_symbol)
    chain = ticker.option_chain(expiration)
    return chain


def compute_gex(qqq_price, nq_price, max_expirations=MAX_EXPIRATIONS):
    """
    Compute gamma exposure levels for QQQ options and convert to NQ levels.

    Returns dict with levels, prices, and metadata.
    """
    ticker = yf.Ticker("QQQ")
    expirations = ticker.options

    if not expirations:
        raise ValueError("No option expirations available for QQQ")

    # Filter expirations within MAX_DAYS_OUT
    today = datetime.now().date()
    valid_expirations = []
    for exp_str in expirations:
        exp_date = datetime.strptime(exp_str, '%Y-%m-%d').date()
        days_out = (exp_date - today).days
        if 0 <= days_out <= MAX_DAYS_OUT:
            valid_expirations.append(exp_str)
        if len(valid_expirations) >= max_expirations:
            break

    if not valid_expirations:
        raise ValueError("No option expirations within 30 days for QQQ")

    conversion_ratio = nq_price / qqq_price

    # Aggregate GEX across expirations
    gex_by_strike = {}

    for exp_str in valid_expirations:
        exp_date = datetime.strptime(exp_str, '%Y-%m-%d').date()
        T = max((exp_date - today).days / 365.0, MIN_T_YEARS)

        try:
            chain = fetch_option_chain("QQQ", exp_str)
        except Exception as e:
            logging.warning(f"Failed to fetch chain for {exp_str}: {e}")
            continue

        calls = chain.calls
        puts = chain.puts

        # Process calls
        for _, row in calls.iterrows():
            strike = float(row['strike'])
            oi = int(row.get('openInterest', 0) or 0)
            iv = float(row.get('impliedVolatility', 0) or 0)

            if oi <= 0 or iv < MIN_IV:
                continue

            gamma = black_scholes_gamma(qqq_price, strike, T, RISK_FREE_RATE, iv)
            gex_call = gamma * oi * 100 * qqq_price

            if strike not in gex_by_strike:
                gex_by_strike[strike] = {'gex_call': 0, 'gex_put': 0}
            gex_by_strike[strike]['gex_call'] += gex_call

        # Process puts (negative gamma effect on dealers)
        for _, row in puts.iterrows():
            strike = float(row['strike'])
            oi = int(row.get('openInterest', 0) or 0)
            iv = float(row.get('impliedVolatility', 0) or 0)

            if oi <= 0 or iv < MIN_IV:
                continue

            gamma = black_scholes_gamma(qqq_price, strike, T, RISK_FREE_RATE, iv)
            gex_put = gamma * oi * 100 * qqq_price * (-1)

            if strike not in gex_by_strike:
                gex_by_strike[strike] = {'gex_call': 0, 'gex_put': 0}
            gex_by_strike[strike]['gex_put'] += gex_put

    if not gex_by_strike:
        raise ValueError("No valid option data found")

    # Compute total GEX per strike
    strikes_data = []
    for strike, gex_vals in sorted(gex_by_strike.items()):
        total_gex = gex_vals['gex_call'] + gex_vals['gex_put']
        strikes_data.append({
            'strike_qqq': round(strike, 2),
            'strike_nq': round(strike * conversion_ratio, 2),
            'gex': round(total_gex, 2),
            'gex_call': round(gex_vals['gex_call'], 2),
            'gex_put': round(gex_vals['gex_put'], 2),
        })

    # Identify key levels
    levels = _identify_key_levels(strikes_data)

    return {
        'timestamp': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'),
        'market_open': is_market_open(),
        'qqq_price': round(qqq_price, 2),
        'nq_price': round(nq_price, 2),
        'conversion_ratio': round(conversion_ratio, 4),
        'expirations_used': valid_expirations,
        'levels': levels,
        'all_strikes': strikes_data,
    }


def _identify_key_levels(strikes_data):
    """Identify call wall, put wall, gamma flip, and significant levels."""
    levels = []

    if not strikes_data:
        return levels

    # Call wall: highest positive GEX
    positive_strikes = [s for s in strikes_data if s['gex'] > 0]
    if positive_strikes:
        call_wall = max(positive_strikes, key=lambda s: s['gex'])
        levels.append({**call_wall, 'label': 'call_wall'})

    # Put wall: most negative GEX
    negative_strikes = [s for s in strikes_data if s['gex'] < 0]
    if negative_strikes:
        put_wall = min(negative_strikes, key=lambda s: s['gex'])
        levels.append({**put_wall, 'label': 'put_wall'})

    # Gamma flip: where cumulative GEX crosses zero
    cumulative = 0
    prev_cumulative = None
    for s in strikes_data:
        cumulative += s['gex']
        if prev_cumulative is not None and prev_cumulative * cumulative < 0:
            # Interpolate
            prev_strike = strikes_data[strikes_data.index(s) - 1]
            weight = abs(prev_cumulative) / (abs(prev_cumulative) + abs(cumulative))
            flip_qqq = prev_strike['strike_qqq'] + weight * (s['strike_qqq'] - prev_strike['strike_qqq'])
            flip_nq = prev_strike['strike_nq'] + weight * (s['strike_nq'] - prev_strike['strike_nq'])
            levels.append({
                'strike_qqq': round(flip_qqq, 2),
                'strike_nq': round(flip_nq, 2),
                'gex': 0,
                'gex_call': 0,
                'gex_put': 0,
                'label': 'zero_gamma',
            })
            break
        prev_cumulative = cumulative

    # Top 3 additional significant positive strikes (excluding call wall)
    call_wall_strike = levels[0]['strike_qqq'] if levels and levels[0]['label'] == 'call_wall' else None
    sig_positive = sorted(
        [s for s in positive_strikes if s['strike_qqq'] != call_wall_strike],
        key=lambda s: s['gex'],
        reverse=True
    )[:3]
    for s in sig_positive:
        levels.append({**s, 'label': 'significant_pos'})

    # Top 3 additional significant negative strikes (excluding put wall)
    put_wall_strike = None
    for l in levels:
        if l['label'] == 'put_wall':
            put_wall_strike = l['strike_qqq']
            break
    sig_negative = sorted(
        [s for s in negative_strikes if s['strike_qqq'] != put_wall_strike],
        key=lambda s: s['gex']
    )[:3]
    for s in sig_negative:
        levels.append({**s, 'label': 'significant_neg'})

    return levels


def fetch_prices_and_compute_gex():
    """Fetch QQQ and NQ prices, then compute GEX. Main entry point."""
    qqq_ticker = yf.Ticker("QQQ")
    nq_ticker = yf.Ticker("NQ=F")

    qqq_price = float(qqq_ticker.fast_info['lastPrice'])
    nq_price = float(nq_ticker.fast_info['lastPrice'])

    if qqq_price <= 0 or nq_price <= 0:
        raise ValueError(f"Invalid prices: QQQ={qqq_price}, NQ={nq_price}")

    return compute_gex(qqq_price, nq_price)