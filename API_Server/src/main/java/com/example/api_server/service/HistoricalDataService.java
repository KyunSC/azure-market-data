package com.example.api_server.service;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import com.example.api_server.entity.HistoricalDataEntity;
import com.example.api_server.repository.supabase.SupabaseHistoricalDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
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

    public HistoricalDataService(SupabaseHistoricalDataRepository localRepository) {
        this.localRepository = localRepository;
    }

    @Cacheable(value = "historicalData", key = "#symbol + '-' + #period + '-' + #interval")
    @Retry(name = "historicalData")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalData(String symbol, String period, String interval) {
        logger.info("Fetching historical data for {} with period={}, interval={} from Supabase", symbol, period, interval);

        // Longer timeframes aggregate from smaller ones to provide developing candles
        String queryInterval = switch (interval) {
            case "4h", "1d" -> "1h";
            case "1wk" -> "1d";
            default -> interval;
        };

        List<HistoricalDataEntity> data = localRepository
                .findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), queryInterval);

        if (data.isEmpty()) {
            logger.warn("No historical data found for {} with interval {}", symbol, queryInterval);
        } else {
            logger.info("Found {} records for {} from Supabase", data.size(), symbol);
        }

        data = switch (interval) {
            case "4h" -> aggregateToNHours(data, 4);
            case "1d" -> aggregateToDaily(data);
            case "1wk" -> aggregateToWeekly(data);
            default -> data;
        };

        data = filterByPeriod(data, period);

        return buildResponseFromEntities(symbol, period, interval, data);
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

    private List<HistoricalDataEntity> aggregateToNHours(List<HistoricalDataEntity> hourlyData, int n) {
        List<HistoricalDataEntity> result = new ArrayList<>();
        for (int i = 0; i < hourlyData.size(); i += n) {
            int end = Math.min(i + n, hourlyData.size());
            List<HistoricalDataEntity> chunk = hourlyData.subList(i, end);

            HistoricalDataEntity first = chunk.get(0);
            double open = first.getOpen();
            double high = chunk.stream().mapToDouble(HistoricalDataEntity::getHigh).max().orElse(0);
            double low = chunk.stream().mapToDouble(HistoricalDataEntity::getLow).min().orElse(0);
            double close = chunk.get(chunk.size() - 1).getClose();
            long volume = chunk.stream().mapToLong(HistoricalDataEntity::getVolume).sum();

            HistoricalDataEntity agg = new HistoricalDataEntity(
                    first.getSymbol(), first.getDate(), n + "h",
                    open, high, low, close, volume, first.getFetchedAt());
            result.add(agg);
        }
        return result;
    }

    private List<HistoricalDataEntity> aggregateToDaily(List<HistoricalDataEntity> hourlyData) {
        List<HistoricalDataEntity> result = new ArrayList<>();
        if (hourlyData.isEmpty()) return result;

        LinkedHashMap<LocalDate, List<HistoricalDataEntity>> grouped = new LinkedHashMap<>();
        for (HistoricalDataEntity e : hourlyData) {
            grouped.computeIfAbsent(e.getDate().toLocalDate(), k -> new ArrayList<>()).add(e);
        }

        for (Map.Entry<LocalDate, List<HistoricalDataEntity>> entry : grouped.entrySet()) {
            List<HistoricalDataEntity> bars = entry.getValue();
            HistoricalDataEntity first = bars.get(0);
            double high = bars.stream().mapToDouble(HistoricalDataEntity::getHigh).max().orElse(0);
            double low = bars.stream().mapToDouble(HistoricalDataEntity::getLow).min().orElse(0);
            long volume = bars.stream().mapToLong(HistoricalDataEntity::getVolume).sum();
            result.add(new HistoricalDataEntity(
                    first.getSymbol(), entry.getKey().atStartOfDay(), "1d",
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
