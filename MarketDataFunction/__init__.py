import azure.functions as func
import yfinance as yf
import time
import json
import math

def is_valid_number(value):
    """Check if value is a valid, usable number."""
    if value is None:
        return False
    try:
        num = float(value)
        return not (math.isnan(num) or math.isinf(num))
    except (TypeError, ValueError):
        return False

def main(req: func.HttpRequest) -> func.HttpResponse:
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

    # Fetch data for all tickers
    results = []
    for symbol in tickers_list:
        try:
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

            results.append(ticker_data)
        except Exception as e:
            results.append({
                "symbol": symbol,
                "price": None,
                "volume": None,
                "error": str(e)
            })

    result = {
        "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
        "tickers": results,
        "tickers_requested": tickers_list
    }

    return func.HttpResponse(
        json.dumps(result, indent=2),
        mimetype="application/json",
        status_code=200
    )
