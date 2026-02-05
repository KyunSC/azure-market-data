import azure.functions as func
import yfinance as yf
import time
import json
import logging
from concurrent.futures import ThreadPoolExecutor, TimeoutError

TICKER_TIMEOUT_SECONDS = 15

VALID_PERIODS = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'ytd', 'max']
VALID_INTERVALS = ['1m', '2m', '5m', '15m', '30m', '60m', '90m', '1h', '1d', '5d', '1wk', '1mo', '3mo']

def fetch_historical_data(symbol, period, interval):
    """Fetch OHLC historical data for a ticker."""
    ticker = yf.Ticker(symbol)
    history = ticker.history(period=period, interval=interval)

    if history.empty:
        return None

    data = []
    for date, row in history.iterrows():
        # Format time based on interval (daily vs intraday)
        if interval in ['1d', '5d', '1wk', '1mo', '3mo']:
            time_val = date.strftime('%Y-%m-%d')
        else:
            time_val = int(date.timestamp())

        data.append({
            'time': time_val,
            'open': round(float(row['Open']), 2),
            'high': round(float(row['High']), 2),
            'low': round(float(row['Low']), 2),
            'close': round(float(row['Close']), 2),
            'volume': int(row['Volume'])
        })

    return data

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info("Historical data request received")

    # Get parameters
    symbol = req.params.get('symbol')
    period = req.params.get('period', '1mo')
    interval = req.params.get('interval', '1d')

    # Validation
    if not symbol:
        return func.HttpResponse(
            json.dumps({"error": "symbol parameter is required"}),
            mimetype="application/json",
            status_code=400
        )

    if period not in VALID_PERIODS:
        return func.HttpResponse(
            json.dumps({"error": f"Invalid period. Must be one of: {VALID_PERIODS}"}),
            mimetype="application/json",
            status_code=400
        )

    if interval not in VALID_INTERVALS:
        return func.HttpResponse(
            json.dumps({"error": f"Invalid interval. Must be one of: {VALID_INTERVALS}"}),
            mimetype="application/json",
            status_code=400
        )

    try:
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(fetch_historical_data, symbol.upper(), period, interval)
            data = future.result(timeout=TICKER_TIMEOUT_SECONDS)

        if data is None:
            return func.HttpResponse(
                json.dumps({"error": f"No data available for {symbol}"}),
                mimetype="application/json",
                status_code=404
            )

        result = {
            "symbol": symbol.upper(),
            "period": period,
            "interval": interval,
            "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
            "data": data
        }

        return func.HttpResponse(
            json.dumps(result),
            mimetype="application/json",
            status_code=200
        )

    except TimeoutError:
        logging.error(f"Timeout fetching historical data for {symbol}")
        return func.HttpResponse(
            json.dumps({"error": "Request timed out"}),
            mimetype="application/json",
            status_code=504
        )
    except Exception as e:
        logging.error(f"Error fetching historical data: {str(e)}")
        return func.HttpResponse(
            json.dumps({"error": str(e)}),
            mimetype="application/json",
            status_code=500
        )
