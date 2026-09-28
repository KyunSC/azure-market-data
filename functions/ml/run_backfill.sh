#!/usr/bin/env bash
# Unattended ThetaData backfill: keeps the Mac awake and restarts thetadata_fetch.py after
# provider failures (exit 1: retries exhausted, expired session, network drop).
#
#   nohup functions/ml/run_backfill.sh > /dev/null 2>&1 &     # start; survives closing the terminal
#   nohup functions/ml/run_backfill.sh --symbols QQQ,SPY --start 2022-01-01 > /dev/null 2>&1 &   # subset
#   tail -f functions/ml/data/thetadata/backfill.log          # watch
#   kill "$(cat functions/ml/data/thetadata/.backfill.lock/pid)"   # stop (completed partitions are kept)
#
# Extra arguments are passed to thetadata_fetch.py (e.g. --symbols, --start, --end).
# Env: WORKERS (default 4 = ThetaData Standard concurrency limit), MAX_GB (default 400), PAUSE seconds between restarts (default 300),
#      MAX_STALLS restarts in a row with no new partitions before giving up (default 6).
# Stops for good on exit 0 (done), 2 (usage), 4 (all denied), 5 (disk guard), 130 (interrupted).
# Keep the laptop plugged in; with the lid closed macOS still sleeps unless an external display is attached.
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DATA="$REPO/functions/ml/data/thetadata"
LOG="$DATA/backfill.log"
LOCK="$DATA/.backfill.lock"
WORKERS="${WORKERS:-4}"
MAX_GB="${MAX_GB:-400}"
PAUSE="${PAUSE:-300}"
MAX_STALLS="${MAX_STALLS:-6}"

if [ -z "${BACKFILL_CAFFEINATED:-}" ]; then
  export BACKFILL_CAFFEINATED=1
  exec caffeinate -i "$0" "$@"
fi

mkdir -p "$DATA"
if ! mkdir "$LOCK" 2>/dev/null; then
  if kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "backfill already running (pid $(cat "$LOCK/pid"))" | tee -a "$LOG"
    exit 3
  fi
  mkdir -p "$LOCK"  # stale lock from a killed run
fi
echo $$ > "$LOCK/pid"
child=""
trap 'rm -rf "$LOCK"' EXIT
trap '[ -n "$child" ] && kill -INT "$child" 2>/dev/null; wait "$child" 2>/dev/null; exit 130' INT TERM

partitions() { [ -f "$DATA/fetch_log.jsonl" ] && wc -l < "$DATA/fetch_log.jsonl" | tr -d ' ' || echo 0; }

stalls=0
while true; do
  before=$(partitions)
  echo "=== $(date '+%F %T') start (workers=$WORKERS, args=$*, logged partitions=$before)" >> "$LOG"
  "$REPO/.venv/bin/python" "$REPO/functions/ml/thetadata_fetch.py" oi iv_5m --download \
    --workers "$WORKERS" --max-gb "$MAX_GB" "$@" >> "$LOG" 2>&1 &
  child=$!
  wait "$child"
  code=$?
  child=""
  echo "=== $(date '+%F %T') exit $code" >> "$LOG"
  [ "$code" -ne 1 ] && exit "$code"
  if [ "$(partitions)" -eq "$before" ]; then
    stalls=$((stalls + 1))
    if [ "$stalls" -ge "$MAX_STALLS" ]; then
      echo "=== giving up: $stalls restarts in a row made no progress" >> "$LOG"
      exit 1
    fi
  else
    stalls=0
  fi
  sleep "$PAUSE"
done
