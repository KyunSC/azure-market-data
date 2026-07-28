#!/usr/bin/env bash
# Caffeine cold-cache vs warm-cache A/B against a live backend.
#
#   ./bench/run_cache_ab.sh [base_url] [trials] [warm_reqs]
#
# No local DB credentials needed -- it measures the deployed instance.
#
# Method: each trial requests a cache key that has never been requested (the
# `period` param is varied, and @Cacheable keys on symbol+period+interval), so
# request #1 is a guaranteed Caffeine MISS that reads Supabase. Requests #2..N
# reuse the same key back-to-back and are guaranteed HITS. Cold and warm
# therefore move identical payloads over the same connection seconds apart --
# the only difference is whether Supabase was touched.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

BASE="${1:-https://azure-market-data.onrender.com}"
TRIALS="${2:-8}"
WARM_REQS="${3:-8}"
OUT="$RESULTS_DIR/cache_ab.csv"

echo "arm,trial,phase,endpoint,seconds,ttfb,http_code,bytes" > "$OUT"

# Distinct periods -> distinct cache keys (@Cacheable keys on
# symbol+period+interval). Keys must be novel across *runs*, not just within
# one: historicalDataLong holds for 1h, so a second run that reused `1y` would
# score a warm hit as if it were cold and wash the effect out. A persisted
# offset hands every run an untouched block of the period space.
OFFSET_FILE="$RESULTS_DIR/.key_offset"
OFFSET=$(cat "$OFFSET_FILE" 2>/dev/null || echo 0)
echo $((OFFSET + TRIALS)) > "$OFFSET_FILE"
echo "key offset: $OFFSET (periods ${OFFSET}d..$((OFFSET + TRIALS))d + 2)"

# Day counts stay clear of the 1m retention floor at the low end; the daily arm
# walks a separate range so the two never collide on a key.
period_intraday() { echo "$((2 + $1))d"; }
period_daily()    { echo "$((400 + $1))d"; }

echo "warming instance..."
wait_until_up "$BASE" 300 > /dev/null

for ((t = 1; t <= TRIALS; t++)); do
  pi=$(period_intraday $((OFFSET + t)))
  pd=$(period_daily $((OFFSET + t)))
  declare -a NAMES=(hist_1m hist_1d)
  declare -a PATHS=(
    "/api/historical?symbol=NQ%3DF&period=$pi&interval=1m"
    "/api/historical?symbol=NQ%3DF&period=$pd&interval=1d"
  )

  echo "=== trial $t/$TRIALS (1m:$pi 1d:$pd) ==="
  for i in "${!NAMES[@]}"; do
    name="${NAMES[$i]}"; path="${PATHS[$i]}"
    read -r sec ttfb code bytes <<<"$(timed_get "$BASE" "$path")"
    echo "cacheoff,$t,cold,$name,$sec,$ttfb,$code,$bytes" >> "$OUT"
    printf '  cold %-8s total=%7.3fs ttfb=%7.3fs (%s, %sB)\n' "$name" "$sec" "$ttfb" "$code" "$bytes"
    for ((w = 1; w <= WARM_REQS; w++)); do
      read -r sec ttfb code bytes <<<"$(timed_get "$BASE" "$path")"
      echo "cacheon,$t,warm,$name,$sec,$ttfb,$code,$bytes" >> "$OUT"
    done
    printf '  warm %-8s total=%7.3fs ttfb=%7.3fs (last of %s)\n' "$name" "$sec" "$ttfb" "$WARM_REQS"
  done
done

echo
python3 "$BENCH_DIR/summarize.py" "$OUT"
