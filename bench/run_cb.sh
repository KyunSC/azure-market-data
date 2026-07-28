#!/usr/bin/env bash
# Circuit-breaker arm: latency under a hung database.
#
#   ./bench/run_cb.sh [requests_per_arm]
#
# Needs no Supabase credentials -- the datasource is repointed at a local TCP
# tarpit that accepts connections and never answers, which is the failure mode
# the breaker exists for (a hung dependency, not a refused one; a refused
# connection fails fast and would understate the problem).
#
# Hikari is configured connectionTimeout=10s and initializationFailTimeout=-1,
# so the app boots against the dead DB and every doomed request costs ~10s.
#
# Arms:
#   cb_off  resilience4j autoconfigs excluded -> every request pays the full hang
#   cb_on   shipped config -> retry(3, exp backoff) then the breaker opens at
#           50% failure over a 10-call window and short-circuits to the fallback
#
# The headline is the steady-state: what request #N costs once the system has
# been failing for a while.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REQS="${1:-16}"
PORT=8098
TARPIT_PORT=6544
BASE="http://localhost:$PORT"
JAR="$REPO_DIR/API_Server/target/API_Server-0.0.1-SNAPSHOT.jar"
OUT="$RESULTS_DIR/cb.csv"
LOG="$RESULTS_DIR/cb.log"

[[ -f "$JAR" ]] || { echo "missing $JAR -- run: cd API_Server && ./mvnw -q package -DskipTests" >&2; exit 1; }

R4J=io.github.resilience4j.springboot3
EXCLUDES="\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerMetricsAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerStreamEventsAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakersHealthIndicatorAutoConfiguration,\
$R4J.retry.autoconfigure.RetryAutoConfiguration,\
$R4J.retry.autoconfigure.RetryMetricsAutoConfiguration"

# socketTimeout is belt-and-braces; Hikari's 10s connectionTimeout fires first.
DEAD_DB="jdbc:postgresql://127.0.0.1:$TARPIT_PORT/postgres?socketTimeout=30&connectTimeout=10"

python3 "$BENCH_DIR/tarpit.py" "$TARPIT_PORT" > "$RESULTS_DIR/tarpit.log" 2>&1 &
TARPIT_PID=$!
trap 'kill $TARPIT_PID 2>/dev/null' EXIT
sleep 1

echo "arm,trial,phase,endpoint,seconds,ttfb,http_code,bytes" > "$OUT"
: > "$LOG"

for ARM in cb_off cb_on; do
  echo "=== $ARM ($REQS requests against a hung DB) ==="
  ARGS=(--server.port=$PORT
        --spring.datasource.supabase.url="$DEAD_DB"
        --spring.datasource.supabase.username=bench
        --spring.datasource.supabase.password=bench
        --app.cache.enabled=false
        --app.scheduler.ingestion.enabled=false
        --app.scheduler.gex.enabled=false)
  # Cache off in both arms: a cache hit would mask the failure entirely and we
  # would be timing Caffeine, not the breaker.
  [[ "$ARM" == "cb_off" ]] && ARGS+=(--spring.autoconfigure.exclude="$EXCLUDES")

  java -jar "$JAR" "${ARGS[@]}" >> "$LOG" 2>&1 &
  PID=$!
  wait_until_up "$BASE" 120 > /dev/null

  for ((i = 1; i <= REQS; i++)); do
    read -r sec ttfb code bytes <<<"$(timed_get "$BASE" "/api/gamma?symbol=QQQ")"
    echo "$ARM,$i,req,gamma,$sec,$ttfb,$code,$bytes" >> "$OUT"
    printf '  req %2d  %8.3fs  http=%s\n' "$i" "$sec" "$code"
  done

  kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
  sleep 2
done

kill $TARPIT_PID 2>/dev/null
echo
echo "Per-request latency (a drop to ~0s marks the breaker opening):"
python3 - "$OUT" <<'PY'
import csv, statistics, sys
from collections import defaultdict
rows = defaultdict(list)
with open(sys.argv[1]) as f:
    for r in csv.DictReader(f):
        rows[r["arm"]].append((int(r["trial"]), float(r["seconds"]), r["http_code"]))
for arm, rs in rows.items():
    rs.sort()
    print(f"\n{arm}: " + " ".join(f"{s:.2f}" for _, s, _ in rs))
    tail = [s for i, s, _ in rs if i > len(rs) // 2]
    print(f"  first request : {rs[0][1]:.3f}s")
    print(f"  steady state  : median {statistics.median(tail):.3f}s over last {len(tail)} reqs")
    print(f"  total wall    : {sum(s for _, s, _ in rs):.1f}s for {len(rs)} requests")
PY
