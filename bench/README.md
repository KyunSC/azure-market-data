# Cold-start benchmark

Measures what the caching / circuit-breaking / stale-while-revalidate work
actually bought, so the résumé claim rests on numbers rather than vibes.

## The thing being measured

"Cold start" is three different costs stacked on one another, and the three
techniques attack different ones. Conflating them is how you end up with a
number you cannot defend in an interview.

| # | Cost | Magnitude | Fixed by |
|---|------|-----------|----------|
| L1 | Render free-tier container spin-up + JVM/Spring boot | tens of seconds | nothing — only *masked* |
| L2 | First request after boot: Caffeine empty, must read Supabase | hundreds of ms – seconds | Caffeine cache (for everyone after the first) |
| L3 | Request latency while Supabase is hung/slow | ~10 s per request, unbounded | circuit breaker |
| L4 | **Perceived** time until the user sees prices | = L1 + L2 without help | localStorage stale-while-revalidate |

L4 is the honest headline for a user-facing claim: caching and circuit breaking
do **not** speed up a cold boot, and saying they do is wrong. The SWR layer is
what makes a cold visit feel fast; the other two shape the steady state and the
failure mode.

## Arms and how each layer is switched off

Toggles are config-only wherever possible, so both arms run the same bytecode
and the same call sites.

| Layer | ON | OFF |
|-------|-----|-----|
| Caffeine | default | `--app.cache.enabled=false` → `NoOpCacheManager` ([CacheConfig.java](../API_Server/src/main/java/com/example/api_server/config/CacheConfig.java)) |
| Breaker + retry | default | `--spring.autoconfigure.exclude=…CircuitBreakerAutoConfiguration,…RetryAutoConfiguration` — the AOP aspects never register, so the annotations go inert |
| Client SWR | context pre-seeded with a cached payload | fresh browser context, empty localStorage |

Two dead ends worth not repeating: resilience4j exposes no `enabled` flag, and
neutering the breaker via `slidingWindowSize=2000000000` OOMs the JVM at
startup because the metrics ring buffer is pre-allocated. Dropping the
autoconfiguration is the clean switch.

## Scripts

| Script | Measures | Needs |
|--------|----------|-------|
| `run_cache_ab.sh [url] [trials] [warm]` | L2 — cold-cache vs warm-cache TTFB against the live deploy | nothing |
| `measure_ttfd.mjs --delays … --trials N` | L4 — time-to-first-data with/without SWR | frontend on :3010, Chrome |
| `run_cb.sh [requests]` | L3 — latency under a hung DB, breaker on vs off | nothing (uses `tarpit.py`) |
| `run_local.sh <arm> <trials>` | L1+L2 locally, all arms, full A/B | `SUPABASE_PASSWORD` |
| `summarize.py [--paired] <csv>` | aggregation | — |

Results land in `results/*.csv`.

### Methodology notes that matter

**Cache keys must be novel across runs, not just within one.** `@Cacheable`
keys on `symbol+period+interval` and `historicalDataLong` holds for an hour, so
a second run that reuses `period=1y` scores a *warm* hit while labelling it
cold, which washes the effect out entirely. `run_cache_ab.sh` persists a key
offset in `results/.key_offset` and hands each run an untouched block of the
period space. The first attempt at this benchmark got a spurious ~1.0x for
exactly this reason.

**Compare TTFB, not total time.** Responses here run 14 KB to 2 MB; on the 2 MB
ones the payload download dominates `time_total` and buries the server-side
difference the cache actually changes.

**Pair, don't pool.** Payload sizes vary by two orders of magnitude across
cache keys, so pooling all cold times against all warm times compares different
workloads. `summarize.py --paired` matches each trial's cold request against
the warm requests for that *same* key — identical payload, same connection,
seconds apart — and aggregates as a median of per-trial ratios.

**Hang the dependency, don't kill it.** A refused TCP connection fails in
microseconds and would make the breaker look pointless. `tarpit.py` accepts the
connection and never replies, which is what a saturated PgBouncer actually does
and what the 10 s Hikari `connectionTimeout` is there to bound.

**Inject the cold-start delay rather than waiting for a real one.** Reproducing
a genuine Render spin-down costs 15+ min of idle per trial. `measure_ttfd.mjs`
intercepts `/api/market` and delays it a fixed amount, so the identical
cold-start cost is replayed across both arms and many trials. Sweep the delay,
then read the curve at the empirically measured spin-up value.

## Reproducing the real Render cold start

Injected delays give the curve; you still need one real anchor point, and the
free-tier spin-down is only reachable with the keep-warm monitor off.

1. Pause the UptimeRobot monitor on `/health`.
2. Leave the service idle 16+ min (Render spins down after 15).
3. `curl -sS -o /dev/null -w '%{time_starttransfer}\n' https://azure-market-data.onrender.com/health`
4. Repeat for N≥10 trials, appending to `results/render_cold.csv`. Each trial
   costs ~20 min wall-clock, so this runs over a day or two.
5. Re-enable the monitor.

Report the median and the spread — spin-up time varies a lot with host load,
and a single sample is not a result.
