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


def is_premarket_window():
    """True during the 9:00–9:30 ET weekday window.

    Used to gate a single pre-open GEX run so opening-bell viewers see levels
    before cash equities open. Bounded tightly so DST-mismatched cron firings
    (the same UTC tick maps to two different ET hours across the year) only
    trigger the run on the correct side of the spring/fall transition.
    """
    et_tz = pytz.timezone('US/Eastern')
    now_et = datetime.now(et_tz)
    if now_et.weekday() >= 5:
        return False
    return now_et.hour == 9 and now_et.minute < 30


def fetch_option_chain(ticker_symbol, expiration):
    """Fetch option chain for a single expiration."""
    ticker = yf.Ticker(ticker_symbol)
    chain = ticker.option_chain(expiration)
    return chain


def compute_gex(etf_price, futures_price, etf_symbol='QQQ', max_expirations=MAX_EXPIRATIONS):
    """
    Compute gamma exposure levels for ETF options and convert to futures levels.

    Supports QQQ→NQ and SPY→ES (or any ETF/futures pair).
    Returns dict with levels, prices, and metadata.
    """
    ticker = yf.Ticker(etf_symbol)
    expirations = ticker.options

    if not expirations:
        raise ValueError(f"No option expirations available for {etf_symbol}")

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
        raise ValueError(f"No option expirations within 30 days for {etf_symbol}")

    conversion_ratio = futures_price / etf_price

    # Aggregate GEX + option-flow metrics across expirations.
    # Per-strike buckets break GEX out by days-to-expiry so the ML pipeline can
    # weight 0DTE (which is ~50% of daily options volume) separately from
    # weekly/monthly contributions.
    gex_by_strike = {}
    iv_by_strike_call = {}   # strike -> [iv, ...] across expirations
    iv_by_strike_put  = {}
    total_call_volume = 0.0
    total_put_volume  = 0.0
    total_call_oi     = 0.0
    total_put_oi      = 0.0

    def _new_strike_record():
        return {'gex_call': 0.0, 'gex_put': 0.0,
                'gex_0dte': 0.0, 'gex_1dte': 0.0,
                'gex_weekly': 0.0, 'gex_monthly': 0.0}

    def _dte_key(days_out: int) -> str:
        if days_out <= 0:
            return 'gex_0dte'
        if days_out == 1:
            return 'gex_1dte'
        if days_out <= 7:
            return 'gex_weekly'
        return 'gex_monthly'

    for exp_str in valid_expirations:
        exp_date = datetime.strptime(exp_str, '%Y-%m-%d').date()
        days_out = (exp_date - today).days
        T = max(days_out / 365.0, MIN_T_YEARS)
        dte_bucket = _dte_key(days_out)

        try:
            chain = fetch_option_chain(etf_symbol, exp_str)
        except Exception as e:
            logging.warning(f"Failed to fetch chain for {exp_str}: {e}")
            continue

        calls = chain.calls
        puts = chain.puts

        # Accumulate volume / OI for PCR
        total_call_volume += float(calls['volume'].fillna(0).sum())
        total_put_volume  += float(puts['volume'].fillna(0).sum())
        total_call_oi     += float(calls['openInterest'].fillna(0).sum())
        total_put_oi      += float(puts['openInterest'].fillna(0).sum())

        # Process calls
        for _, row in calls.iterrows():
            strike = float(row['strike'])
            raw_oi = row.get('openInterest', 0)
            raw_iv = row.get('impliedVolatility', 0)
            oi = 0 if (raw_oi is None or (isinstance(raw_oi, float) and math.isnan(raw_oi))) else int(raw_oi)
            iv = 0.0 if (raw_iv is None or (isinstance(raw_iv, float) and math.isnan(raw_iv))) else float(raw_iv)

            if iv >= MIN_IV:
                iv_by_strike_call.setdefault(strike, []).append(iv)

            if oi <= 0 or iv < MIN_IV:
                continue

            gamma = black_scholes_gamma(etf_price, strike, T, RISK_FREE_RATE, iv)
            gex_call = gamma * oi * 100 * etf_price

            rec = gex_by_strike.setdefault(strike, _new_strike_record())
            rec['gex_call'] += gex_call
            rec[dte_bucket] += gex_call

        # Process puts (negative gamma effect on dealers)
        for _, row in puts.iterrows():
            strike = float(row['strike'])
            raw_oi = row.get('openInterest', 0)
            raw_iv = row.get('impliedVolatility', 0)
            oi = 0 if (raw_oi is None or (isinstance(raw_oi, float) and math.isnan(raw_oi))) else int(raw_oi)
            iv = 0.0 if (raw_iv is None or (isinstance(raw_iv, float) and math.isnan(raw_iv))) else float(raw_iv)

            if iv >= MIN_IV:
                iv_by_strike_put.setdefault(strike, []).append(iv)

            if oi <= 0 or iv < MIN_IV:
                continue

            gamma = black_scholes_gamma(etf_price, strike, T, RISK_FREE_RATE, iv)
            gex_put = gamma * oi * 100 * etf_price * (-1)

            rec = gex_by_strike.setdefault(strike, _new_strike_record())
            rec['gex_put'] += gex_put
            rec[dte_bucket] += gex_put

    if not gex_by_strike:
        raise ValueError("No valid option data found")

    # --- Option-flow metrics ---

    # Put/call ratios
    pcr_volume = round(total_put_volume / max(total_call_volume, 1.0), 4)
    pcr_oi     = round(total_put_oi    / max(total_call_oi,     1.0), 4)

    # ATM implied vol: mean of call IV and put IV at the strike nearest to spot
    strikes_with_both = [s for s in iv_by_strike_call if s in iv_by_strike_put]
    if strikes_with_both:
        atm = min(strikes_with_both, key=lambda s: abs(s - etf_price))
        call_iv_atm = sum(iv_by_strike_call[atm]) / len(iv_by_strike_call[atm])
        put_iv_atm  = sum(iv_by_strike_put[atm])  / len(iv_by_strike_put[atm])
        iv_atm = round((call_iv_atm + put_iv_atm) / 2, 4)
    else:
        iv_atm = None

    # IV skew: mean OTM-put IV (90–97% of spot) minus mean OTM-call IV (103–110% of spot)
    otm_put_ivs  = [iv for s, ivs in iv_by_strike_put.items()
                    if 0.90 * etf_price <= s <= 0.97 * etf_price for iv in ivs]
    otm_call_ivs = [iv for s, ivs in iv_by_strike_call.items()
                    if 1.03 * etf_price <= s <= 1.10 * etf_price for iv in ivs]
    if otm_put_ivs and otm_call_ivs:
        iv_skew = round(
            sum(otm_put_ivs)  / len(otm_put_ivs) -
            sum(otm_call_ivs) / len(otm_call_ivs),
            4
        )
    else:
        iv_skew = None

    # Compute total GEX per strike
    strikes_data = []
    for strike, gex_vals in sorted(gex_by_strike.items()):
        total_gex = gex_vals['gex_call'] + gex_vals['gex_put']
        strikes_data.append({
            'strike_etf': round(strike, 2),
            'strike_futures': round(strike * conversion_ratio, 2),
            'gex': round(total_gex, 2),
            'gex_call': round(gex_vals['gex_call'], 2),
            'gex_put': round(gex_vals['gex_put'], 2),
            'gex_0dte':    round(gex_vals['gex_0dte'], 2),
            'gex_1dte':    round(gex_vals['gex_1dte'], 2),
            'gex_weekly':  round(gex_vals['gex_weekly'], 2),
            'gex_monthly': round(gex_vals['gex_monthly'], 2),
        })

    # Identify key levels
    levels = _identify_key_levels(strikes_data, etf_price)

    return {
        'timestamp': datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S'),
        'market_open': is_market_open(),
        'etf_price': round(etf_price, 2),
        'futures_price': round(futures_price, 2),
        'conversion_ratio': round(conversion_ratio, 4),
        'expirations_used': valid_expirations,
        'levels': levels,
        'all_strikes': strikes_data,
        # Option-flow features (None if chain data insufficient)
        'pcr_volume': pcr_volume,
        'pcr_oi': pcr_oi,
        'iv_atm': iv_atm,
        'iv_skew': iv_skew,
    }


def _identify_key_levels(strikes_data, spot):
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

    # Gamma flip: where cumulative GEX crosses zero. Deep-OTM strikes carry
    # tiny noisy GEX that can flip the cumulative sign well below the real
    # dealer-positioning crossover, so scan all sign changes and keep the
    # one whose interpolated strike sits closest to spot.
    cumulative = 0
    prev_cumulative = None
    prev_strike = None
    best_flip = None
    best_dist = float('inf')
    for s in strikes_data:
        cumulative += s['gex']
        if prev_cumulative is not None and prev_cumulative * cumulative < 0 and prev_strike is not None:
            weight = abs(prev_cumulative) / (abs(prev_cumulative) + abs(cumulative))
            flip_etf = prev_strike['strike_etf'] + weight * (s['strike_etf'] - prev_strike['strike_etf'])
            flip_futures = prev_strike['strike_futures'] + weight * (s['strike_futures'] - prev_strike['strike_futures'])
            dist = abs(flip_etf - spot)
            if dist < best_dist:
                best_dist = dist
                best_flip = {
                    'strike_etf': round(flip_etf, 2),
                    'strike_futures': round(flip_futures, 2),
                    'gex': 0,
                    'gex_call': 0,
                    'gex_put': 0,
                    'gex_0dte': 0,
                    'gex_1dte': 0,
                    'gex_weekly': 0,
                    'gex_monthly': 0,
                    'label': 'zero_gamma',
                }
        prev_cumulative = cumulative
        prev_strike = s
    if best_flip is not None:
        levels.append(best_flip)

    # Top 3 additional significant positive strikes (excluding call wall)
    call_wall_strike = levels[0]['strike_etf'] if levels and levels[0]['label'] == 'call_wall' else None
    sig_positive = sorted(
        [s for s in positive_strikes if s['strike_etf'] != call_wall_strike],
        key=lambda s: s['gex'],
        reverse=True
    )[:3]
    for s in sig_positive:
        levels.append({**s, 'label': 'significant_pos'})

    # Top 3 additional significant negative strikes (excluding put wall)
    put_wall_strike = None
    for l in levels:
        if l['label'] == 'put_wall':
            put_wall_strike = l['strike_etf']
            break
    sig_negative = sorted(
        [s for s in negative_strikes if s['strike_etf'] != put_wall_strike],
        key=lambda s: s['gex']
    )[:3]
    for s in sig_negative:
        levels.append({**s, 'label': 'significant_neg'})

    return levels


# Supported ETF→Futures pairs
GEX_PAIRS = {
    'QQQ': {'etf': 'QQQ', 'futures': 'NQ=F'},
    'SPY': {'etf': 'SPY', 'futures': 'ES=F'},
    'IWM': {'etf': 'IWM', 'futures': 'RTY=F'},
    'DIA': {'etf': 'DIA', 'futures': 'YM=F'},
}


def fetch_prices_and_compute_gex(etf_symbol='QQQ'):
    """Fetch ETF and futures prices, then compute GEX. Main entry point.

    Args:
        etf_symbol: 'QQQ' for NQ levels, 'SPY' for ES levels.
    """
    pair = GEX_PAIRS.get(etf_symbol)
    if not pair:
        raise ValueError(f"Unsupported ETF symbol: {etf_symbol}. Supported: {list(GEX_PAIRS.keys())}")

    etf_ticker = yf.Ticker(pair['etf'])
    futures_ticker = yf.Ticker(pair['futures'])

    etf_price = float(etf_ticker.fast_info['lastPrice'])
    futures_price = float(futures_ticker.fast_info['lastPrice'])

    if etf_price <= 0 or futures_price <= 0:
        raise ValueError(f"Invalid prices: {pair['etf']}={etf_price}, {pair['futures']}={futures_price}")

    return compute_gex(etf_price, futures_price, etf_symbol=etf_symbol)