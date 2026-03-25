# Project: Azure Market Data

Real-time market data visualization platform with gamma exposure (GEX) tracking for futures trading (ES/NQ).

## Tech Stack

- **Frontend**: Next.js 16 + React 19 + lightweight-charts 5 (JavaScript/JSX)
- **Backend API**: Spring Boot 4 (Java 21, Maven) on port 8080
- **Data Ingestion**: Azure Functions (Python) on port 7071
- **Database**: PostgreSQL (Supabase cloud or local)
- **Caching**: Caffeine (backend), localStorage (frontend preferences)
- **Resilience**: Resilience4j circuit breaker + rate limiter

## Directory Layout

```
API_Server/                        # Spring Boot REST API
  src/main/java/com/example/api_server/
    controller/                    # REST endpoints
      MarketDataController.java    # GET /api/market?tickers=ES=F,NQ=F
      HistoricalDataController.java # GET /api/historical?symbol=&period=&interval=
      GammaExposureController.java # GET /api/gamma?symbol=QQQ
    service/                       # Business logic
    repository/local/              # Local PostgreSQL repos
    repository/supabase/           # Supabase cloud repos (fallback)
    entity/                        # JPA entities
    dto/                           # Request/response DTOs
    config/                        # DB + WebClient config
  pom.xml                         # Maven config

frontend/                          # Next.js React app
  app/
    page.jsx                       # Dashboard homepage (ticker cards)
    ticker/[symbol]/page.jsx       # Chart detail page (main view)
    globals.css                    # Dark theme styling
  components/
    CandlestickChart.jsx           # Core charting engine (lightweight-charts + canvas drawing)
    indicators.js                  # Technical indicator math (SMA, EMA, BB, VWAP, Volume Profile)
    chartDefaults.js               # Color constants
    TimeframeSelector.jsx          # Period/interval toggle
    IndicatorSelector.jsx          # Indicator dropdown
    DrawingSelector.jsx            # Drawing tools (trendline, ray, rect, horizontal)
    ChartTypeSelector.jsx          # Candlestick / hollow / line toggle
    SettingsPopup.jsx              # Color customization
    TickerCard.jsx                 # Dashboard ticker card
    Dashboard.jsx                  # Dashboard grid layout
  next.config.mjs                  # Proxies /api/* → localhost:8080

functions/                         # Azure Functions (Python)
  MarketDataFunction/              # HTTP: fetch current prices via yfinance
  HistoricalDataFunction/          # HTTP: fetch OHLC data
  GammaExposureFunction/           # HTTP: compute GEX on demand
  ScheduledDataIngestion/          # Timer: periodic data collection + GEX computation
  shared/gex_calculator.py         # Black-Scholes gamma exposure calculator
  seed_all.py                      # DB seeding script
  requirements.txt                 # Python deps (yfinance, psycopg2, azure-functions)
```

## Key Data Flow

1. **Ingestion**: Azure Functions (timer trigger) → yfinance API → PostgreSQL
2. **API**: Frontend → Next.js proxy (`/api/*`) → Spring Boot (port 8080) → PostgreSQL
3. **Display**: React page polls every 15s, renders charts with lightweight-charts

## Database Tables

- `market_data` — current price/volume per symbol
- `historical_data` — OHLC bars (1m, 5m, 15m, 1h, 4h, 1d intervals)
- `gamma_exposure` — GEX computation metadata (QQQ→NQ conversion)
- `gamma_levels` — individual strike-level GEX values with labels (call_wall, put_wall, zero_gamma)

## API Endpoints (Spring Boot)

| Endpoint | Params | Returns |
|----------|--------|---------|
| `GET /api/market` | `tickers` (comma-sep) | Latest prices/volumes |
| `GET /api/historical` | `symbol`, `period`, `interval` | OHLC array |
| `GET /api/gamma` | `symbol` (default QQQ) | GEX levels with labels |

## Running Locally

- **Frontend**: `cd frontend && npm run dev` (port 3000)
- **Backend**: `cd API_Server && mvn spring-boot:run` (port 8080)
- **Functions**: `cd functions && func start` (port 7071)

## Important Patterns

- GEX is computed for QQQ options but displayed on NQ chart via conversion ratio
- 4h candles are aggregated from 1h data in HistoricalDataService
- Drawing tools use a canvas overlay on top of lightweight-charts
- Frontend stores user preferences (colors, indicators) in localStorage
- Circuit breaker falls back to empty data on backend failures
