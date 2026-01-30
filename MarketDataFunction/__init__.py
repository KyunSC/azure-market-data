import azure.functions as func
import yfinance as yf
import time
import json

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
        ticker_obj = yf.Ticker(symbol)
        info = ticker_obj.fast_info
        results.append({
            "symbol": symbol,
            "price": info['lastPrice'],
            "volume": info['lastVolume']
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
