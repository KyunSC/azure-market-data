import yfinance as yf
import time

ticker = yf.Ticker("SPY")
aapl_ticker = yf.Ticker("ES=F")
fast_info = ticker.fast_info
fast_AAPL_info = aapl_ticker.fast_info
print(f"Time: {time.strftime('%H:%M:%S')} | Price: ${fast_info['lastPrice']:.2f}")
print(f"Time: {time.strftime('%H:%M:%S')} | Price: ${fast_AAPL_info['lastPrice']:.2f}")
time.sleep(5)  # Update every 5 seconds
