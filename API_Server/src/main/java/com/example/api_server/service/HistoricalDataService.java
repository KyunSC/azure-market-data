package com.example.api_server.service;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import com.example.api_server.entity.HistoricalDataEntity;
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
     * Dispatcher: routes to a cache bucket based on the interval. Live intraday
     * goes through a short TTL; daily/weekly uses a much longer TTL because the
     * last bar doesn't change during the session.
     */
    public HistoricalDataResponse getHistoricalData(String symbol, String period, String interval) {
        return LONG_CACHE_INTERVALS.contains(interval)
                ? self.getHistoricalDataLongCached(symbol, period, interval)
                : self.getHistoricalDataShortCached(symbol, period, interval);
    }

    @Cacheable(value = "historicalData", key = "#symbol + '-' + #period + '-' + #interval")
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalDataShortCached(String symbol, String period, String interval) {
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

        List<HistoricalDataEntity> data = dbCutoff == null
                ? localRepository.findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), queryInterval)
                : localRepository.findBySymbolAndIntervalTypeAndDateGreaterThanEqualOrderByDateAsc(
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
        return buildResponseFromEntities(symbol, period, interval, data);
    }

    /**
     * Incremental fetch: returns only bars aligned to {@code interval} whose bucket
     * start is at or after {@code sinceEpochSeconds}. Intended for live polling so
     * the client sends back the last bar it has and we return just the delta.
     * Not cached — caching per-since-timestamp would never hit.
     */
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalSinceFallback")
    public HistoricalDataResponse getHistoricalDataSince(String symbol, String interval, long sinceEpochSeconds) {
        String queryInterval = storedIntervalFor(interval);
        LocalDateTime since = Instant.ofEpochSecond(sinceEpochSeconds)
                .atZone(ZoneId.systemDefault()).toLocalDateTime();

        List<HistoricalDataEntity> data = localRepository
                .findBySymbolAndIntervalTypeAndDateGreaterThanEqualOrderByDateAsc(
                        symbol.toUpperCase(), queryInterval, since);

        logger.debug("Incremental fetch {} {} since {} → {} {} rows",
                symbol, interval, since, data.size(), queryInterval);

        data = aggregate(data, queryInterval, interval);
        return buildResponseFromEntities(symbol, "since", interval, data);
    }

    public HistoricalDataResponse getHistoricalSinceFallback(String symbol, String interval,
                                                              long sinceEpochSeconds, Exception ex) {
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
            case "15m" -> "15m";
            case "30m" -> "15m";
            case "1h" -> "1h";
            case "4h" -> "1h";
            case "1d" -> "1d";
            case "1wk" -> "1d";
            default -> "1m";
        };
    }

    /** Aggregate stored bars up to the requested interval. */
    private List<HistoricalDataEntity> aggregate(List<HistoricalDataEntity> data,
                                                  String stored, String requested) {
        if (stored.equals(requested)) return data;
        return switch (requested) {
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

    private static final Set<String> INTRADAY_INTERVALS = Set.of("1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "4h");

    private List<HistoricalDataEntity> filterByPeriod(List<HistoricalDataEntity> data, String period) {
        if (period.equals("max") || data.isEmpty()) {
            return data;
        }

        // Anchor the cutoff off the most recent bar rather than wall-clock now().
        // Intraday data is only ingested during market hours, so using now() would
        // filter out everything over weekends/overnight for short periods like 1d.
        LocalDateTime anchor = data.get(data.size() - 1).getDate();
        LocalDateTime cutoff = periodToCutoff(period, anchor);
        if (cutoff == null) {
            return data;
        }

        return data.stream()
                .filter(e -> !e.getDate().isBefore(cutoff))
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

    private List<HistoricalDataEntity> aggregateToNMinutes(List<HistoricalDataEntity> minuteData, int n) {
        List<HistoricalDataEntity> result = new ArrayList<>();
        if (minuteData.isEmpty()) return result;

        String intervalLabel = n >= 60 ? (n / 60) + "h" : n + "m";

        // Group 1m bars into time-aligned buckets
        LinkedHashMap<LocalDateTime, List<HistoricalDataEntity>> grouped = new LinkedHashMap<>();
        for (HistoricalDataEntity e : minuteData) {
            LocalDateTime dt = e.getDate();
            int totalMinutes = dt.getHour() * 60 + dt.getMinute();
            int bucketMinutes = (totalMinutes / n) * n;
            LocalDateTime bucketKey = dt.toLocalDate().atStartOfDay().plusMinutes(bucketMinutes);
            grouped.computeIfAbsent(bucketKey, k -> new ArrayList<>()).add(e);
        }

        for (Map.Entry<LocalDateTime, List<HistoricalDataEntity>> entry : grouped.entrySet()) {
            List<HistoricalDataEntity> bars = entry.getValue();
            HistoricalDataEntity first = bars.get(0);
            double high = bars.stream().mapToDouble(HistoricalDataEntity::getHigh).max().orElse(0);
            double low = bars.stream().mapToDouble(HistoricalDataEntity::getLow).min().orElse(0);
            long volume = bars.stream().mapToLong(HistoricalDataEntity::getVolume).sum();
            result.add(new HistoricalDataEntity(
                    first.getSymbol(), entry.getKey(), intervalLabel,
                    first.getOpen(), high, low, bars.get(bars.size() - 1).getClose(),
                    volume, first.getFetchedAt()));
        }
        return result;
    }

    private List<HistoricalDataEntity> aggregateToWeekly(List<HistoricalDataEntity> dailyData) {
        List<HistoricalDataEntity> result = new ArrayList<>();
        if (dailyData.isEmpty()) return result;

        LinkedHashMap<LocalDate, List<HistoricalDataEntity>> grouped = new LinkedHashMap<>();
        for (HistoricalDataEntity e : dailyData) {
            // Group by Monday of the week
            LocalDate weekStart = e.getDate().toLocalDate().with(DayOfWeek.MONDAY);
            grouped.computeIfAbsent(weekStart, k -> new ArrayList<>()).add(e);
        }

        for (Map.Entry<LocalDate, List<HistoricalDataEntity>> entry : grouped.entrySet()) {
            List<HistoricalDataEntity> bars = entry.getValue();
            HistoricalDataEntity first = bars.get(0);
            double high = bars.stream().mapToDouble(HistoricalDataEntity::getHigh).max().orElse(0);
            double low = bars.stream().mapToDouble(HistoricalDataEntity::getLow).min().orElse(0);
            long volume = bars.stream().mapToLong(HistoricalDataEntity::getVolume).sum();
            result.add(new HistoricalDataEntity(
                    first.getSymbol(), entry.getKey().atStartOfDay(), "1wk",
                    first.getOpen(), high, low, bars.get(bars.size() - 1).getClose(),
                    volume, first.getFetchedAt()));
        }
        return result;
    }

    private HistoricalDataResponse buildResponseFromEntities(String symbol, String period, String interval,
                                                              List<HistoricalDataEntity> entities) {
        boolean intraday = INTRADAY_INTERVALS.contains(interval);
        List<OhlcData> data = entities.stream()
                .filter(e -> e.getOpen() != null && e.getHigh() != null && e.getLow() != null && e.getClose() != null)
                .map(e -> new OhlcData(
                        intraday
                                ? String.valueOf(e.getDate().atZone(ZoneId.systemDefault()).toEpochSecond())
                                : e.getDate().toLocalDate().toString(),
                        e.getOpen(),
                        e.getHigh(),
                        e.getLow(),
                        e.getClose(),
                        e.getVolume()
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
