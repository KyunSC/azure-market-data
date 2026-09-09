# Backtester dataset service

The browser runs simulations. Spring Boot serves immutable research datasets at
`GET /api/backtest/datasets/{id}` and the current catalog at
`GET /api/backtest/datasets`. Next.js proxies both to `API_URL`.
Live TA runs continue to use `/api/historical` and represent exploratory snapshots.

## Local startup

From the repository root, publish the existing QQQ/SPY exports:

```sh
python3 functions/ml/publish_backtest_data.py --source frontend/public/backtest --out API_Server/backtest-data
```

Then start Spring Boot from `API_Server` with `./mvnw spring-boot:run`.
Start the frontend from `frontend` with `API_URL=http://localhost:8080 npm run dev`.
Open `/backtest`; research uses the backend by default. The explicit **Use bundled
examples** option loads the original static fixtures. These are historical examples,
not current market data. Legacy model exports are labeled as unverified for training
label overlap; newly generated predictions purge the forward-label horizon.

## Refresh and production publishing

1. Refresh the feature parquets using `functions/ml/build_dataset.py` (see its CLI
   and `functions/ml/README.md` for database configuration). The existing backward
   GEX join checks snapshot timestamps and limits snapshot staleness.
2. Run the export from a job environment with the ML dependencies and database/API
   access, using a staging directory outside the frontend:

   ```sh
   python functions/ml/export_backtest_data.py --symbols QQQ SPY --out /tmp/backtest-export --publish-out API_Server/backtest-data
   ```

3. For a durable mounted directory, configure Spring Boot's
   `BACKTEST_DATASETS_LOCATION` to its absolute path and publish into that directory.
   For object storage, upload the versioned JSON artifacts first and **index.json
   last**, then set `BACKTEST_DATASETS_LOCATION=https://your-storage/backtest`.
   The HTTPS location must be readable by the API. Do not put storage credentials in
   frontend variables. The backend's default directory is relative to its working
   directory and is for local development; it is not durable on Render's ephemeral
   filesystem. The Docker image does not embed generated datasets.
4. Configure production `API_URL` before building Next.js. Deploy the backend before
   the frontend. Schedule the export/publish command in your ingestion/job platform
   after its source data refresh. This change does not create or modify cloud jobs.

The publisher validates every dataset before changing the catalog. Local writes use
atomic replacement; dataset IDs contain a SHA-256 digest of canonical content.
Old artifacts remain available when a new catalog is published. Preserve them in
object storage too, since links pin exact IDs. A failed publication leaves the old
catalog intact. Gaps include overnight/weekend closures and are reported, not filled.

## Contract and behavior

Schema version 1 preserves `time/open/high/low/close/volume`, `features`, and optional
`ml` columns. Timestamps are UTC epoch seconds; catalog dates use ISO timestamps.
Catalog entries include ID, version, symbol, interval, coverage, generation time,
capabilities, and quality metadata. Unknown versions return 404; missing catalogs
and storage outages return 503; invalid IDs return 400. Catalog responses revalidate;
immutable artifacts cache for a year. Rate limiting uses the existing API policy.

The UI validates columns and prices, ignores superseded responses/results, and keys
the worker by immutable dataset ID. Dataset refresh is explicit. Successful backend
responses have a best-effort localStorage cache for up to 24 hours; offline use is
labeled, and 404 responses never fall back to a removed version. Shared research
links pin dataset and engine versions. Comparison slots retain dataset, strategy,
costs, risk and rule configuration. Slots remain in memory; server-side result
persistence and exact replay of live TA snapshots are outside this implementation.

## Verification

The Compare panel defaults to S&P 500 buy-and-hold via SPY, with QQQ and XEQT.TO
alternatives. `GET /api/backtest/benchmark?symbol=SPY&start=YYYY-MM-DD&end=YYYY-MM-DD`
loads Yahoo adjusted daily closes directly, so XEQT does not require ingestion or
research features. Requests are symbol-allowlisted, range-limited and cached six
hours. Benchmark holdings are fully invested without trading costs; adjusted closes
reflect provider adjustments. Both curves rebase at their first shared date. XEQT
returns are CAD, SPY/QQQ USD, with no FX conversion. Intraday strategy observations
use the last available mark between 15:30 and 16:00 ET and may precede the official
benchmark close, as labeled in the UI. Current-day benchmark data is excluded.
Only common dates are compared; annualized Sharpe is omitted when sessions are
missing. The existing equity-panel ghost remains the traded asset's own buy-and-hold.

```sh
python3 -m unittest discover -s functions/tests -p test_backtest_publish.py
cd API_Server
./mvnw -Dtest=BacktestDatasetTests test
cd ../frontend
node --test lib/backtest/integration.test.mjs lib/backtest/benchmark.test.mjs
npm run build
```

Before production rollout, publish to the configured durable storage and check both
API endpoints through the deployed Next.js proxy. Verify QQQ/SPY coverage in the UI,
refresh after publishing a new version, and replay a link to the previous version.
