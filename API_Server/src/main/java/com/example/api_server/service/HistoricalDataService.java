package com.example.api_server.service;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import com.example.api_server.entity.HistoricalDataEntity;
import com.example.api_server.repository.local.LocalHistoricalDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;

@Service
public class HistoricalDataService {

    private static final Logger logger = LoggerFactory.getLogger(HistoricalDataService.class);

    private final LocalHistoricalDataRepository localRepository;

    public HistoricalDataService(LocalHistoricalDataRepository localRepository) {
        this.localRepository = localRepository;
    }

    @Cacheable(value = "historicalData", key = "#symbol + '-' + #period + '-' + #interval")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalData(String symbol, String period, String interval) {
        logger.info("Fetching historical data for {} with period={}, interval={} from Supabase", symbol, period, interval);

        String queryInterval = interval.equals("4h") ? "1h" : interval;

        List<HistoricalDataEntity> data = localRepository
                .findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), queryInterval);

        if (data.isEmpty()) {
            logger.warn("No historical data found for {} with interval {}", symbol, queryInterval);
        } else {
            logger.info("Found {} records for {} from Supabase", data.size(), symbol);
        }

        if (interval.equals("4h")) {
            data = aggregateToNHours(data, 4);
        }

        return buildResponseFromEntities(symbol, period, interval, data);
    }

    private static final Set<String> INTRADAY_INTERVALS = Set.of("1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "4h");

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

    private HistoricalDataResponse buildResponseFromEntities(String symbol, String period, String interval,
                                                              List<HistoricalDataEntity> entities) {
        boolean intraday = INTRADAY_INTERVALS.contains(interval);
        List<OhlcData> data = entities.stream()
                .map(e -> new OhlcData(
                        intraday
                                ? String.valueOf(e.getDate().toEpochSecond(ZoneOffset.UTC))
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
