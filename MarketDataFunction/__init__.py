import azure.functions as func
import yfinance as yf
import time
import json

def main(req: func.HttpRequest) -> func.HttpResponse:
    # Try to get data from JSON body first (POST), then query params (GET)
    try:
        req_body = req.get_json()
        ticker1 = req_body.get('ticker1', 'SPY')
        ticker2 = req_body.get('ticker2', 'ES=F')
        tickers_list = req_body.get('tickers', None)  # Support list of tickers
    except ValueError:
        # No JSON body, use query parameters
        ticker1 = req.params.get('ticker1', 'SPY')
        ticker2 = req.params.get('ticker2', 'ES=F')
        tickers_list = None

    # If tickers list provided, use that instead
    if tickers_list:
        results = []
        for symbol in tickers_list:
            ticker_obj = yf.Ticker(symbol)
            info = ticker_obj.fast_info
            results.append({
                "symbol": symbol,
                "price": info['lastPrice']
            })

        result = {
            "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
            "tickers": results
        }

        return func.HttpResponse(
            json.dumps(result, indent=2),
            mimetype="application/json",
            status_code=200
        )

    # Fetch market data for two tickers
    spy_ticker = yf.Ticker(ticker1)
    es_ticker = yf.Ticker(ticker2)

    spy_info = spy_ticker.fast_info
    es_info = es_ticker.fast_info

    # Build response
    result = {
        "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
        "tickers": [
            {
                "symbol": ticker1,
                "price": spy_info['lastPrice']
            },
            {
                "symbol": ticker2,
                "price": es_info['lastPrice']
            }
        ]
    }

    return func.HttpResponse(
        json.dumps(result, indent=2),
        mimetype="application/json",
        status_code=200
    )
