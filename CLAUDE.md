# Project: Azure Market Data

Real-time market data visualization platform with gamma exposure (GEX) tracking for index futures trading (ES/NQ).

## Tech Stack

- **Frontend**: Next.js 16 + React 19 + lightweight-charts 5 (JavaScript/JSX)
- **Backend API**: Spring Boot 4 (Java 21, Maven) on port 8080
- **Data Ingestion**: Azure Functions (Python) on port 7071
- **Database**: PostgreSQL (Supabase cloud or local)
- **Caching**: Caffeine (backend), localStorage (frontend preferences + stale-while-revalidate response cache)
- **Hosting**: Backend on Render free tier; UptimeRobot pings `/health` to keep the instance warm during market hours
- **Resilience**: Resilience4j circuit breaker + rate limiter

## Directory Layout

```
API_Server/                        # Spring Boot REST API
  src/main/java/com/example/api_server/
    controller/                    # REST endpoints
      HomeController.java          # GET / (redirect), GET /health
      MarketDataController.java    # GET /api/market, GET /api/market/live
      HistoricalDataController.java # GET /api/historical, GET /api/historical/since
      GammaExposureController.java # GET /api/gamma?symbol=QQQ
    service/                       # Business logic
      LiveMarketDataService.java   # Cached live price fetch (bypasses DB)
    repository/local/              # Local PostgreSQL repos
    repository/supabase/           # Supabase cloud repos (fallback)
    entity/                        # JPA entities
    dto/                           # Request/response DTOs
    config/                        # DB + WebClient + cache config
    exception/                     # GlobalExceptionHandler, custom exceptions
  pom.xml                         # Maven config

frontend/                          # Next.js React app
  app/
    layout.jsx                     # Root layout (Vercel analytics + speed insights)
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
  ScheduledDataIngestion/          # Timer (weekdays every 5m): data collection
  ScheduledDataIngestionGlobex/    # Timer (Sunday evenings every 5m): Globex session ingestion
  ScheduledGammaExposure/          # Timer (weekdays every 5m): GEX computation
  ScheduledGammaExposurePremarket/ # Timer (weekdays ~9:25 ET): one pre-open GEX run
  GEXCalculator/gex_calculator.py  # Black-Scholes gamma exposure calculator
  shared/
    sanitize.py                    # yfinance OHLC price sanitization (phantom tick removal)
    volume_profile.py              # Volume profile approximation from 1m OHLCV bars
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
| `GET /` | — | Redirect / health info |
| `GET /health` | — | Health check |
| `GET /api/market` | `tickers` (comma-sep) | Latest prices/volumes from DB |
| `GET /api/market/live` | `symbol` | Live price via LiveMarketDataService (cached) |
| `GET /api/historical` | `symbol`, `period`, `interval` | Full OHLC array |
| `GET /api/historical/since` | `symbol`, `interval`, `since` (epoch ms), `lastFetched` (opt) | Incremental OHLC since timestamp |
| `GET /api/gamma` | `symbol` (default QQQ) | GEX levels with labels |

## Running Locally

- **Frontend**: `cd frontend && npm run dev` (port 3000)
- **Backend**: `cd API_Server && mvn spring-boot:run` (port 8080)
- **Functions**: `cd functions && func start` (port 7071)

## Important Patterns

- GEX is computed for QQQ options but displayed on NQ chart via conversion ratio
- 4h candles are aggregated from 1h data in HistoricalDataService
- `GET /api/historical/since` enables incremental polling: first returned bar may still be developing and should replace the client's last bar
- Drawing tools use a canvas overlay on top of lightweight-charts
- Frontend stores user preferences (colors, indicators) in localStorage
- Frontend also caches API responses in localStorage as a stale-while-revalidate layer to mask backend cold-start latency:
  - Dashboard `/api/market` payload under `marketDataCache:<tickers>` ([app/page.jsx](frontend/app/page.jsx))
  - Ticker chart `/api/historical` payload under `historicalDataCache:<symbol>|<period>|<fetchInterval>` ([app/ticker/[symbol]/page.jsx](frontend/app/ticker/[symbol]/page.jsx))
  - Both have a 24h max-age and seed state synchronously on mount, marking the next fetch as a background refresh (no warming-up UI)
- Circuit breaker falls back to empty data on backend failures
- `ScheduledDataIngestionGlobex` re-uses `ScheduledDataIngestion.main` to cover Sunday Globex hours (0 */5 22,23 * * 0 UTC)
- `ScheduledGammaExposurePremarket` calls `ScheduledGammaExposure.run_gex(premarket=True)` to compute one GEX snapshot at ~9:25 ET. Cron `0 25 13,14 * * 1-5` fires at both EDT and EST candidate ticks; `is_premarket_window()` (9:00–9:30 ET) gates so only the DST-correct firing actually runs. QQQ spot is stale (pre-open), but NQ trades overnight so strike labels are usable at the opening bell.
- Render free-tier instance is kept warm via an UptimeRobot HTTP monitor on `/health` (avoids 30–60s cold boots between viewer sessions)
