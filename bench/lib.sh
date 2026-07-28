#!/usr/bin/env bash
# Shared helpers for the cold-start / resilience benchmark harness.

BENCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$BENCH_DIR/.." && pwd)"
RESULTS_DIR="$BENCH_DIR/results"
mkdir -p "$RESULTS_DIR"

# Endpoints under test. Chosen to span the three cache buckets:
#   market      -> marketData (60s TTL) + a live Yahoo call
#   hist_1m_5d  -> historicalDataMedium (5m TTL), biggest payload (~290 KB)
#   hist_1d     -> historicalDataLong (1h TTL)
#   gamma       -> gammaExposure (5m TTL)
# Tomcat rejects raw '^' and bare '=' in the query string (RFC 3986), so the
# ticker list is percent-encoded exactly as the browser sends it.
declare -a ENDPOINT_NAMES=(market hist_1m_5d hist_1d gamma)
declare -a ENDPOINT_PATHS=(
  "/api/market?tickers=ES%3DF,NQ%3DF,SPY,QQQ,%5EVIX,XEQT.TO,BTC-USD,ETH-USD,SOL-USD"
  "/api/historical?symbol=NQ%3DF&period=5d&interval=1m"
  "/api/historical?symbol=NQ%3DF&period=1y&interval=1d"
  "/api/gamma?symbol=QQQ"
)

# timed_get <base_url> <path> -> "<total_s> <ttfb_s> <http_code> <bytes>"
#
# TTFB is the headline metric: it ends when the first response byte arrives, so
# it captures server think-time (Supabase round-trip vs Caffeine lookup) without
# the payload download that dominates time_total on the 2 MB responses.
timed_get() {
  curl -sS -o /dev/null --max-time 300 \
    -w '%{time_total} %{time_starttransfer} %{http_code} %{size_download}' \
    "$1$2" 2>/dev/null || echo "-1 -1 000 0"
}

# wait_until_up <base_url> <timeout_s> -> prints seconds until first HTTP 200 on /health
wait_until_up() {
  local base="$1" timeout="${2:-300}" start now
  start=$(python3 -c 'import time;print(time.time())')
  while :; do
    if curl -sS -o /dev/null --max-time 5 -f "$base/health" 2>/dev/null; then
      now=$(python3 -c 'import time;print(time.time())')
      python3 -c "print(f'{$now-$start:.3f}')"
      return 0
    fi
    now=$(python3 -c 'import time;print(time.time())')
    if python3 -c "import sys;sys.exit(0 if $now-$start > $timeout else 1)"; then
      echo "-1"; return 1
    fi
    sleep 0.25
  done
}

# stats <csv-of-numbers-on-stdin> -> "n=<n> min=<> p50=<> p95=<> max=<> mean=<>"
stats() {
  python3 - "$@" <<'PY'
import sys, statistics
xs = sorted(float(l) for l in sys.stdin if l.strip() and float(l) >= 0)
if not xs:
    print("n=0"); sys.exit()
def pct(p):
    if len(xs) == 1: return xs[0]
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
print(f"n={len(xs)} min={xs[0]*1000:.1f}ms p50={pct(.5)*1000:.1f}ms "
      f"p95={pct(.95)*1000:.1f}ms max={xs[-1]*1000:.1f}ms mean={statistics.mean(xs)*1000:.1f}ms")
PY
}
