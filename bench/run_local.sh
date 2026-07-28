#!/usr/bin/env bash
# Local cold-start + cache benchmark.
#
#   ./bench/run_local.sh <arm> <trials> [warm_reqs_per_endpoint]
#
# Arms:
#   baseline   no Caffeine cache, breaker/retry neutered (never opens, 1 attempt)
#   cache      Caffeine cache ON, breaker/retry still neutered
#   full       everything ON (ships-to-prod config)
#
# Per trial: boot a fresh JVM, time boot->first HTTP 200, then issue one COLD
# request per endpoint (empty Caffeine) followed by N WARM requests. Kill, repeat.
# Emits one CSV row per request to bench/results/local_<arm>.csv.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ARM="${1:-full}"
TRIALS="${2:-5}"
WARM_REQS="${3:-10}"
PORT=8099
BASE="http://localhost:$PORT"
JAR="$REPO_DIR/API_Server/target/API_Server-0.0.1-SNAPSHOT.jar"
OUT="$RESULTS_DIR/local_${ARM}.csv"
LOG="$RESULTS_DIR/local_${ARM}.log"

# Breaker/retry off. Resilience4j exposes no `enabled` flag, and inflating
# slidingWindowSize just OOMs (the metrics array is pre-allocated), so drop the
# autoconfigurations instead: without them the AOP aspects never register and
# the @CircuitBreaker/@Retry annotations are inert. Call sites stay untouched.
R4J=io.github.resilience4j.springboot3
NO_RESILIENCE=(--spring.autoconfigure.exclude="\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerMetricsAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakerStreamEventsAutoConfiguration,\
$R4J.circuitbreaker.autoconfigure.CircuitBreakersHealthIndicatorAutoConfiguration,\
$R4J.retry.autoconfigure.RetryAutoConfiguration,\
$R4J.retry.autoconfigure.RetryMetricsAutoConfiguration")

case "$ARM" in
  baseline) ARGS=(--app.cache.enabled=false "${NO_RESILIENCE[@]}") ;;
  cache)    ARGS=(--app.cache.enabled=true  "${NO_RESILIENCE[@]}") ;;
  full)     ARGS=(--app.cache.enabled=true) ;;
  *) echo "unknown arm: $ARM" >&2; exit 1 ;;
esac

# Schedulers off in every arm -- background ingestion would otherwise warm the
# caches and contend for the connection pool, confounding the request timings.
ARGS+=(--app.scheduler.ingestion.enabled=false --app.scheduler.gex.enabled=false
       --server.port=$PORT)

[[ -f "$JAR" ]] || { echo "missing $JAR -- run: cd API_Server && ./mvnw -q package -DskipTests" >&2; exit 1; }
[[ -n "${SUPABASE_PASSWORD:-}" ]] || { echo "SUPABASE_PASSWORD not set" >&2; exit 1; }

echo "arm,trial,phase,endpoint,seconds,ttfb,http_code,bytes" > "$OUT"
: > "$LOG"

for ((t = 1; t <= TRIALS; t++)); do
  echo "=== $ARM trial $t/$TRIALS ===" | tee -a "$LOG"
  java -jar "$JAR" "${ARGS[@]}" >> "$LOG" 2>&1 &
  PID=$!
  BOOT=$(wait_until_up "$BASE" 180)
  echo "$ARM,$t,boot,health,$BOOT,$BOOT,200,0" >> "$OUT"
  echo "  boot->200: ${BOOT}s" | tee -a "$LOG"

  for i in "${!ENDPOINT_NAMES[@]}"; do
    name="${ENDPOINT_NAMES[$i]}"; path="${ENDPOINT_PATHS[$i]}"
    read -r sec ttfb code bytes <<<"$(timed_get "$BASE" "$path")"
    echo "$ARM,$t,cold,$name,$sec,$ttfb,$code,$bytes" >> "$OUT"
    echo "  cold $name: total=${sec}s ttfb=${ttfb}s ($code, ${bytes}B)" | tee -a "$LOG"
    for ((w = 1; w <= WARM_REQS; w++)); do
      read -r sec ttfb code bytes <<<"$(timed_get "$BASE" "$path")"
      echo "$ARM,$t,warm,$name,$sec,$ttfb,$code,$bytes" >> "$OUT"
    done
  done

  kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null
  sleep 2
done

echo
echo "=== $ARM summary ==="
python3 "$BENCH_DIR/summarize.py" "$OUT"
