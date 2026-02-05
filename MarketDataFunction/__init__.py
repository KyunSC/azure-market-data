import azure.functions as func
import yfinance as yf
import time
import json
import math
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError

MAX_TICKERS = 20
TICKER_TIMEOUT_SECONDS = 10
RATE_LIMIT_REQUESTS = 30
RATE_LIMIT_WINDOW_SECONDS = 60

# In-memory rate limit tracking (per IP)
request_log = {}

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
    """Fetch data for a single ticker."""
    ticker_obj = yf.Ticker(symbol)
    info = ticker_obj.fast_info

    price = info.get('lastPrice')
    volume = info.get('lastVolume')

    ticker_data = {"symbol": symbol}

    if is_valid_number(price) and float(price) >= 0:
        ticker_data["price"] = float(price)
    else:
        ticker_data["price"] = None
        ticker_data["price_error"] = "unavailable or invalid"

    if is_valid_number(volume) and float(volume) >= 0:
        ticker_data["volume"] = int(volume)
    else:
        ticker_data["volume"] = None
        ticker_data["volume_error"] = "unavailable or invalid"

    return ticker_data

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Market data request received")

    # Rate limiting
    client_ip = req.headers.get('X-Forwarded-For', 'unknown')
    now = time.time()
    cutoff = now - RATE_LIMIT_WINDOW_SECONDS
    request_log[client_ip] = [t for t in request_log.get(client_ip, []) if t > cutoff]
    if len(request_log[client_ip]) >= RATE_LIMIT_REQUESTS:
        return func.HttpResponse(
            json.dumps({"error": "Rate limit exceeded"}),
            mimetype="application/json",
            status_code=429
        )
    request_log[client_ip].append(now)

    # Try to get tickers from JSON body first (POST), then query params (GET)
    try:
        req_body = req.get_json()
        tickers_list = req_body.get('tickers', ['SPY', 'ES=F'])
    except ValueError:
        # No JSON body, check for comma-separated query param
        tickers_param = req.params.get('tickers', None)
        if tickers_param:
            tickers_list = [t.strip() for t in tickers_param.split(',')]
        else:
            tickers_list = ['SPY', 'ES=F']

    # Input validation
    if not isinstance(tickers_list, list):
        logging.warning(f"Invalid tickers format: {type(tickers_list)}")
        return func.HttpResponse(
            json.dumps({"error": "tickers must be a list"}),
            mimetype="application/json",
            status_code=400
        )

    if len(tickers_list) > MAX_TICKERS:
        logging.warning(f"Too many tickers requested: {len(tickers_list)}")
        return func.HttpResponse(
            json.dumps({"error": f"Maximum {MAX_TICKERS} tickers allowed"}),
            mimetype="application/json",
            status_code=400
        )

    logging.info(f"Fetching data for {len(tickers_list)} tickers: {tickers_list}")

    # Fetch data for all tickers with timeout
    results = []
    failed_count = 0

    for symbol in tickers_list:
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(fetch_ticker_data, symbol)
                ticker_data = future.result(timeout=TICKER_TIMEOUT_SECONDS)
                results.append(ticker_data)

                if "error" in ticker_data:
                    failed_count += 1
                    logging.warning(f"Ticker {symbol} returned with error")
                else:
                    logging.info(f"Successfully fetched {symbol}")

        except TimeoutError:
            logging.error(f"Timeout fetching {symbol}")
            failed_count += 1
            results.append({
                "symbol": symbol,
                "price": None,
                "volume": None,
                "error": "request timed out"
            })
        except Exception as e:
            logging.error(f"Error fetching {symbol}: {str(e)}")
            failed_count += 1
            results.append({
                "symbol": symbol,
                "price": None,
                "volume": None,
                "error": str(e)
            })

    # Determine status code
    if failed_count == 0:
        status_code = 200
    elif failed_count == len(tickers_list):
        status_code = 500
    else:
        status_code = 207  # Partial success

    logging.info(f"Request complete: {len(tickers_list) - failed_count}/{len(tickers_list)} successful, status {status_code}")

    result = {
        "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
        "tickers": results,
        "tickers_requested": tickers_list
    }

    return func.HttpResponse(
        json.dumps(result, indent=2),
        mimetype="application/json",
        status_code=status_code
    )
