# Azure Live Market Data

An Azure Function that fetches real-time stock prices using the yfinance API.

## ML experiment: Do dealer-hedging flows improve index-ETF return prediction?

A walk-forward study testing whether gamma exposure (GEX) features extracted from
real-time options data improve forward-return prediction over a price-and-volume baseline.
**Two underlyings** (QQQ = Nasdaq-100, SPY = S&P 500) × **five horizons** (5–120 min) ×
**two architectures** (Random Forest, FT-Transformer) × with/without GEX features, on
~3 weeks of 5-min bars joined to 24/7 GEX snapshots computed in-house from yfinance option
chains.

**Headline finding (primary, a null):** adding 8 GEX features **did not improve** out-of-
sample IC at the horizons where the baseline carries the strongest signal (60–120 min on
both QQQ and SPY). SHAP attribution shows the Random Forest *did* prioritize GEX features
on QQQ (`net_gex` and `dist_put_wall_atr` rank #1 and #2 by mean |SHAP|), so this is a
sample-efficiency null — the signal exists but is below the noise floor at n ≈ 600
training rows per fold — not "GEX is uninformative."

**Headline finding (secondary, positive — replicates across both underlyings):**
the baseline RF reaches
- **QQQ 120-min:** IC = **+0.137** (95% CI [+0.005, +0.361]), dir-acc **65.8%**
- **SPY 120-min:** IC = **+0.160**, dir-acc **62.1%**

…driven by ATR, RSI, 60-min returns, and intraday seasonality (per SHAP).

![Cross-symbol IC vs horizon](functions/ml/plots/ic_vs_horizon_cross_symbol.png)

### Cross-symbol RF results (ΔIC = GEX − baseline)

| Horizon | QQQ base IC | QQQ ΔIC | SPY base IC | SPY ΔIC |
|---|---|---|---|---|
| 5 min   | +0.081 | −0.052 | +0.015 | +0.006 |
| 15 min  | +0.041 | −0.007 | −0.038 | +0.029 |
| 30 min  | −0.018 | −0.049 | −0.043 | +0.014 |
| 60 min  | +0.140 | −0.026 | −0.018 | −0.007 |
| **120 min** | **+0.137** | −0.119 | **+0.160** | −0.083 |

**Methodology highlights:** expanding-window walk-forward CV (5 folds × 100 OOS predictions
each); block bootstrap (block ≈ 1 trading day) for IC 95% CIs; triple-asserted leakage
controls in the data builder; ~140 total model fits across all experiments.

Full paper-style writeup with methodology, SHAP plots, limitations, and reproducibility
instructions: [**functions/ml/README.md**](functions/ml/README.md).

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
