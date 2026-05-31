package com.example.api_server.service;

import com.example.api_server.dto.HistoricalBar;
import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import com.example.api_server.repository.supabase.SupabaseHistoricalDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

@Service
public class HistoricalDataService {

    private static final Logger logger = LoggerFactory.getLogger(HistoricalDataService.class);

    private final SupabaseHistoricalDataRepository localRepository;

    /**
     * Proxy reference to self so internal calls go through Spring's AOP and
     * @Cacheable actually fires. Without this, the dispatcher's call to
     * {@code getHistoricalData*Cached} bypasses the proxy and skips caching.
     */
    @Autowired
    @Lazy
    private HistoricalDataService self;

    public HistoricalDataService(SupabaseHistoricalDataRepository localRepository) {
        this.localRepository = localRepository;
    }

    /** Intervals whose last bar is immutable within a session → cache aggressively. */
    private static final Set<String> LONG_CACHE_INTERVALS = Set.of("1d", "1wk");

    /**
     * Dispatcher: routes to a cache bucket based on (interval, period).
     * <ul>
     *   <li>1d/1wk → long bucket (1h TTL).</li>
     *   <li>1m on the same-day live view → short bucket (90s TTL) so a period
     *       switch back to "today" picks up the developing bar quickly.</li>
     *   <li>Everything else intraday → medium bucket (5 min TTL). Ingestion
     *       runs every 5 min, so a longer TTL doesn't reduce real freshness —
     *       it just amortizes the big full-fetch payloads across cache hits.
     *       /since handles fine-grained polling regardless.</li>
     * </ul>
     */
    public HistoricalDataResponse getHistoricalData(String symbol, String period, String interval) {
        if (LONG_CACHE_INTERVALS.contains(interval)) {
            return self.getHistoricalDataLongCached(symbol, period, interval);
        }
        if ("1m".equals(interval) && "1d".equals(period)) {
            return self.getHistoricalDataShortCached(symbol, period, interval);
        }
        return self.getHistoricalDataMediumCached(symbol, period, interval);
    }

    @Cacheable(value = "historicalData", key = "#symbol + '-' + #period + '-' + #interval")
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalDataShortCached(String symbol, String period, String interval) {
        return loadHistoricalData(symbol, period, interval);
    }

    @Cacheable(value = "historicalDataMedium", key = "#symbol + '-' + #period + '-' + #interval")
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalDataMediumCached(String symbol, String period, String interval) {
        return loadHistoricalData(symbol, period, interval);
    }

    @Cacheable(value = "historicalDataLong", key = "#symbol + '-' + #period + '-' + #interval")
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalDataLongCached(String symbol, String period, String interval) {
        return loadHistoricalData(symbol, period, interval);
    }

    private HistoricalDataResponse loadHistoricalData(String symbol, String period, String interval) {
        logger.info("Fetching historical data for {} with period={}, interval={} from Supabase", symbol, period, interval);

        // Pick the smallest stored interval that still satisfies the request, so we
        // transfer as few rows as possible from Supabase (egress-sensitive).
        String queryInterval = storedIntervalFor(interval);

        // Bound the DB query by date. Use a generous buffer so weekends/holidays
        // don't leave the period empty; precise trimming happens in filterByPeriod
        // anchored on the most recent bar.
        LocalDateTime dbCutoff = dbCutoffFor(period);

        // Hard floor on lookback per stored interval. Protects against
        // period=max (or an unknown period) pulling years of 1m bars in a
        // single response. Also clamps absurdly long periods on small
        // intervals (e.g. period=10y at interval=1m). Numbers chosen for a
        // ~600 KB-per-fetch ceiling after projection.
        LocalDateTime minCutoff = maxLookbackFor(queryInterval);
        if (minCutoff != null && (dbCutoff == null || dbCutoff.isBefore(minCutoff))) {
            if (dbCutoff != null) {
                logger.info("Clamped lookback for {} {} (requested cutoff {} → {})",
                        symbol, interval, dbCutoff, minCutoff);
            }
            dbCutoff = minCutoff;
        }

        List<HistoricalBar> data = dbCutoff == null
                ? localRepository.findBarsBySymbolAndInterval(symbol.toUpperCase(), queryInterval)
                : localRepository.findBarsBySymbolAndIntervalSince(
                        symbol.toUpperCase(), queryInterval, dbCutoff);

        if (data.isEmpty()) {
            logger.warn("No historical data found for {} with interval {} (query={}, cutoff={})",
                    symbol, interval, queryInterval, dbCutoff);
        } else {
            logger.info("Found {} {} records for {} (requested interval={}, cutoff={})",
                    data.size(), queryInterval, symbol, interval, dbCutoff);
        }

        data = aggregate(data, queryInterval, interval);
        data = filterByPeriod(data, period);
        return buildResponseFromBars(symbol, period, interval, data);
    }

    /**
     * Incremental fetch: returns only bars aligned to {@code interval} whose bucket
     * start is at or after {@code sinceEpochSeconds}. Intended for live polling so
     * the client sends back the last bar it has and we return just the delta.
     *
     * The MAX(fetched_at) probe is cached, so a tight poll loop costs at most
     * one tiny timestamp query per cache TTL. When {@code lastFetchedEpoch}
     * matches the current MAX, we know ingestion hasn't written anything new
     * (including in-place updates of the developing bar) and short-circuit
     * without touching Supabase for OHLC rows. The new MAX is returned in
     * {@link HistoricalDataResponse#getLastFetched()} so the client can echo
     * it on the next poll.
     */
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalSinceFallback")
    public HistoricalDataResponse getHistoricalDataSince(String symbol, String interval,
                                                         long sinceEpochSeconds,
                                                         Long lastFetchedEpoch) {
        String queryInterval = storedIntervalFor(interval);
        LocalDateTime since = Instant.ofEpochSecond(sinceEpochSeconds)
                .atZone(ZoneId.systemDefault()).toLocalDateTime();

        LocalDateTime maxFetched = self.latestFetchedAt(symbol.toUpperCase(), queryInterval);
        Long maxFetchedEpoch = maxFetched == null
                ? null
                : maxFetched.atZone(ZoneId.systemDefault()).toEpochSecond();

        // No data at all yet for this symbol/interval.
        if (maxFetched == null) {
            return emptyDeltaResponse(symbol, interval, null);
        }

        // Client is already current with what ingestion has written. Skip the
        // delta query entirely — no OHLC rows pulled from Supabase.
        if (lastFetchedEpoch != null && lastFetchedEpoch >= maxFetchedEpoch) {
            return emptyDeltaResponse(symbol, interval, maxFetchedEpoch);
        }

        List<HistoricalBar> data = localRepository
                .findBarsBySymbolAndIntervalSince(symbol.toUpperCase(), queryInterval, since);

        logger.debug("Incremental fetch {} {} since {} → {} {} rows",
                symbol, interval, since, data.size(), queryInterval);

        data = aggregate(data, queryInterval, interval);
        HistoricalDataResponse response = buildResponseFromBars(symbol, "since", interval, data);
        response.setLastFetched(maxFetchedEpoch);
        return response;
    }

    private HistoricalDataResponse emptyDeltaResponse(String symbol, String interval, Long lastFetched) {
        HistoricalDataResponse response = buildResponseFromBars(symbol, "since", interval, List.of());
        response.setLastFetched(lastFetched);
        return response;
    }

    /**
     * Cached MAX(fetched_at) probe. Advances whenever ingestion writes a row
     * (including in-place updates of the developing bar), so it's a reliable
     * "anything new since you last polled?" signal that costs one timestamp
     * per cache TTL across all clients.
     */
    @Cacheable(value = "latestFetchedAt", key = "#symbol + '-' + #intervalType")
    public LocalDateTime latestFetchedAt(String symbol, String intervalType) {
        return localRepository.findMaxFetchedAtBySymbolAndIntervalType(symbol, intervalType);
    }

    public HistoricalDataResponse getHistoricalSinceFallback(String symbol, String interval,
                                                              long sinceEpochSeconds,
                                                              Long lastFetchedEpoch, Exception ex) {
        logger.warn("Circuit breaker fallback for incremental {} {}. Reason: {}", symbol, interval, ex.getMessage());
        return new HistoricalDataResponse(
                symbol.toUpperCase(), "since", interval,
                LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                List.of());
    }

    /** Pick the coarsest stored interval that still produces the requested bars. */
    private String storedIntervalFor(String requested) {
        return switch (requested) {
            case "1m" -> "1m";
            case "5m" -> "5m";
            case "15m" -> "5m";
            case "30m" -> "5m";
            case "1h" -> "1h";
            case "4h" -> "1h";
            case "1d" -> "1d";
            case "1wk" -> "1d";
            default -> "1m";
        };
    }

    /** Aggregate stored bars up to the requested interval. */
    private List<HistoricalBar> aggregate(List<HistoricalBar> data,
                                          String stored, String requested) {
        if (stored.equals(requested)) return data;
        return switch (requested) {
            case "15m" -> aggregateToNMinutes(data, 15);
            case "30m" -> aggregateToNMinutes(data, 30);
            case "4h" -> aggregateToNMinutes(data, 240);
            case "1wk" -> aggregateToWeekly(data);
            default -> data;
        };
    }

    /**
     * Loose cutoff for the DB query: period plus a buffer for weekends/holidays.
     * Return null to disable DB-level filtering (period=max or unknown).
     */
    private LocalDateTime dbCutoffFor(String period) {
        LocalDateTime now = LocalDateTime.now();
        return switch (period) {
            case "1d" -> now.minusDays(8);
            case "5d" -> now.minusDays(12);
            case "10d" -> now.minusDays(17);
            case "14d" -> now.minusDays(21);
            case "1mo" -> now.minusMonths(1).minusDays(7);
            case "3mo" -> now.minusMonths(3).minusDays(7);
            case "6mo" -> now.minusMonths(6).minusDays(7);
            case "1y" -> now.minusYears(1).minusDays(7);
            case "2y" -> now.minusYears(2).minusDays(7);
            case "5y" -> now.minusYears(5).minusDays(7);
            case "10y" -> now.minusYears(10).minusDays(7);
            default -> null;
        };
    }

    /**
     * Hard floor on how far back the DB query may reach, per stored interval.
     * Keeps any single response under ~600 KB after projection even on
     * worst-case inputs (period=max, or absurd period/interval pairings).
     * <ul>
     *   <li>1m stored → 30 days (~11k rows)</li>
     *   <li>5m stored → 6 months (~14k rows)</li>
     *   <li>1h stored → 5 years (~12k rows)</li>
     *   <li>1d stored → no cap (rows are cheap)</li>
     * </ul>
     */
    private LocalDateTime maxLookbackFor(String storedInterval) {
        LocalDateTime now = LocalDateTime.now();
        return switch (storedInterval) {
            case "1m" -> now.minusDays(30);
            case "5m" -> now.minusMonths(6);
            case "1h" -> now.minusYears(5);
            default -> null;
        };
    }

    private static final Set<String> INTRADAY_INTERVALS = Set.of("1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "4h");

    private List<HistoricalBar> filterByPeriod(List<HistoricalBar> data, String period) {
        if (period.equals("max") || data.isEmpty()) {
            return data;
        }

        // Anchor the cutoff off the most recent bar rather than wall-clock now().
        // Intraday data is only ingested during market hours, so using now() would
        // filter out everything over weekends/overnight for short periods like 1d.
        LocalDateTime anchor = data.get(data.size() - 1).date();
        LocalDateTime cutoff = periodToCutoff(period, anchor);
        if (cutoff == null) {
            return data;
        }

        return data.stream()
                .filter(e -> !e.date().isBefore(cutoff))
                .collect(Collectors.toList());
    }

    private LocalDateTime periodToCutoff(String period, LocalDateTime anchor) {
        return switch (period) {
            case "1d" -> anchor.minusDays(1);
            case "5d" -> anchor.minusDays(5);
            case "10d" -> anchor.minusDays(10);
            case "14d" -> anchor.minusDays(14);
            case "1mo" -> anchor.minusMonths(1);
            case "3mo" -> anchor.minusMonths(3);
            case "6mo" -> anchor.minusMonths(6);
            case "1y" -> anchor.minusYears(1);
            case "2y" -> anchor.minusYears(2);
            case "5y" -> anchor.minusYears(5);
            case "10y" -> anchor.minusYears(10);
            default -> null;
        };
    }

    private List<HistoricalBar> aggregateToNMinutes(List<HistoricalBar> minuteData, int n) {
        List<HistoricalBar> result = new ArrayList<>();
        if (minuteData.isEmpty()) return result;

        // Group 1m bars into time-aligned buckets
        LinkedHashMap<LocalDateTime, List<HistoricalBar>> grouped = new LinkedHashMap<>();
        for (HistoricalBar e : minuteData) {
            LocalDateTime dt = e.date();
            int totalMinutes = dt.getHour() * 60 + dt.getMinute();
            int bucketMinutes = (totalMinutes / n) * n;
            LocalDateTime bucketKey = dt.toLocalDate().atStartOfDay().plusMinutes(bucketMinutes);
            grouped.computeIfAbsent(bucketKey, k -> new ArrayList<>()).add(e);
        }

        for (Map.Entry<LocalDateTime, List<HistoricalBar>> entry : grouped.entrySet()) {
            List<HistoricalBar> bars = entry.getValue();
            HistoricalBar first = bars.get(0);
            double high = bars.stream().mapToDouble(HistoricalBar::high).max().orElse(0);
            double low = bars.stream().mapToDouble(HistoricalBar::low).min().orElse(0);
            long volume = bars.stream().mapToLong(b -> b.volume() == null ? 0L : b.volume()).sum();
            result.add(new HistoricalBar(
                    entry.getKey(),
                    first.open(), high, low,
                    bars.get(bars.size() - 1).close(),
                    volume));
        }
        return result;
    }

    private List<HistoricalBar> aggregateToWeekly(List<HistoricalBar> dailyData) {
        List<HistoricalBar> result = new ArrayList<>();
        if (dailyData.isEmpty()) return result;

        LinkedHashMap<LocalDate, List<HistoricalBar>> grouped = new LinkedHashMap<>();
        for (HistoricalBar e : dailyData) {
            // Group by Monday of the week
            LocalDate weekStart = e.date().toLocalDate().with(DayOfWeek.MONDAY);
            grouped.computeIfAbsent(weekStart, k -> new ArrayList<>()).add(e);
        }

        for (Map.Entry<LocalDate, List<HistoricalBar>> entry : grouped.entrySet()) {
            List<HistoricalBar> bars = entry.getValue();
            HistoricalBar first = bars.get(0);
            double high = bars.stream().mapToDouble(HistoricalBar::high).max().orElse(0);
            double low = bars.stream().mapToDouble(HistoricalBar::low).min().orElse(0);
            long volume = bars.stream().mapToLong(b -> b.volume() == null ? 0L : b.volume()).sum();
            result.add(new HistoricalBar(
                    entry.getKey().atStartOfDay(),
                    first.open(), high, low,
                    bars.get(bars.size() - 1).close(),
                    volume));
        }
        return result;
    }

    private HistoricalDataResponse buildResponseFromBars(String symbol, String period, String interval,
                                                         List<HistoricalBar> bars) {
        boolean intraday = INTRADAY_INTERVALS.contains(interval);
        List<OhlcData> data = bars.stream()
                .filter(b -> b.open() != null && b.high() != null && b.low() != null && b.close() != null)
                .map(b -> new OhlcData(
                        intraday
                                ? String.valueOf(b.date().atZone(ZoneId.systemDefault()).toEpochSecond())
                                : b.date().toLocalDate().toString(),
                        b.open(),
                        b.high(),
                        b.low(),
                        b.close(),
                        b.volume()
                ))
                .collect(Collectors.toList());

        return new HistoricalDataResponse(
                symbol.toUpperCase(),
                period,
                interval,
                LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                data
        );
    }

    public HistoricalDataResponse getHistoricalDataFallback(String symbol, String period, String interval, Exception ex) {
        logger.warn("Circuit breaker fallback for historical data {}. Reason: {}", symbol, ex.getMessage());

        // Return empty response
        return new HistoricalDataResponse(
                symbol.toUpperCase(),
                period,
                interval,
                LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                List.of()
        );
    }
}
