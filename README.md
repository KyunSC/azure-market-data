# Azure Live Market Data

An Azure Function that fetches real-time stock prices using the yfinance API.

## Endpoint

```
GET/POST /api/MarketDataFunction
```

## Usage

### Default (SPY and ES=F)
```bash
curl "http://localhost:7071/api/MarketDataFunction"
```

### Custom tickers via query params
```bash
curl "http://localhost:7071/api/MarketDataFunction?ticker1=AAPL&ticker2=MSFT"
```

### Multiple tickers via POST
```bash
curl -X POST "http://localhost:7071/api/MarketDataFunction" \
  -H "Content-Type: application/json" \
  -d '{"tickers": ["AAPL", "GOOGL", "MSFT", "AMZN"]}'
```

## Response

```json
{
  "timestamp": "2026-01-15 12:06:43",
  "tickers": [
    {
      "symbol": "SPY",
      "price": 695.28
    },
    {
      "symbol": "ES=F",
      "price": 7012.5
    }
  ]
}
```

## Local Development

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Run the function:
   ```bash
   func start
   ```

## Requirements

- Python 3.8+
- Azure Functions Core Tools
- Dependencies: `azure-functions`, `yfinance`
