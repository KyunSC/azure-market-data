# Azure Live Market Data

An Azure Function that fetches real-time stock prices using the yfinance API.

## ML experiment: Do dealer-hedging flows improve QQQ return prediction?

A walk-forward study testing whether gamma exposure (GEX) features extracted from
real-time QQQ options data improve forward-return prediction over a price-and-volume
baseline. Five horizons (5–120 min) × two architectures (Random Forest,
FT-Transformer) × with/without GEX features, on ~3 weeks of 5-min bars joined to
24/7 GEX snapshots computed in-house from yfinance option chains.

**Headline finding (primary, a null):** adding 8 GEX features **did not improve**
out-of-sample IC over the price/volume baseline at *any* horizon, with either
architecture. SHAP attribution shows the Random Forest *did* prioritize GEX features
(`net_gex` and `dist_put_wall_atr` rank #1 and #2 by mean |SHAP|), so this is a
sample-efficiency null — the signal exists but is below the noise floor at n≈600
training rows per fold — not "GEX is uninformative."

**Headline finding (secondary, positive):** the baseline RF reaches
**IC = +0.137 (95% block-bootstrap CI [+0.005, +0.361])** and
**65.8% directional accuracy** on **120-minute** QQQ returns — driven by ATR,
RSI, 60-min returns, and intraday seasonality (per SHAP).

![IC vs horizon](functions/ml/plots/ic_vs_horizon.png)

| Horizon | RF-base IC | RF-GEX IC | Δ(IC) | RF-base dir-acc |
|---|---|---|---|---|
| 5 min   | +0.081 | +0.029 | −0.052 | 50.5% |
| 15 min  | +0.041 | +0.034 | −0.007 | 56.6% |
| 30 min  | −0.018 | −0.066 | −0.049 | 53.7% |
| 60 min  | +0.140 | +0.114 | −0.026 | 59.8% |
| **120 min** | **+0.137** | +0.018 | −0.119 | **65.8%** |

**Methodology highlights:** expanding-window walk-forward CV (5 folds × 100 OOS
predictions each); block bootstrap (block=73 ≈ 1 trading day) for IC 95% CIs;
triple-asserted leakage controls in the data builder; ~72 total model fits across
all experiments.

Full paper-style writeup with methodology, SHAP plots, limitations, and
reproducibility instructions:
[**functions/ml/README.md**](functions/ml/README.md).

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
