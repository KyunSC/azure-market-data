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
import java.time.format.DateTimeFormatter;
import java.util.List;
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

        List<HistoricalDataEntity> data = localRepository
                .findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), interval);

        if (data.isEmpty()) {
            logger.warn("No historical data found for {} with interval {}", symbol, interval);
        } else {
            logger.info("Found {} records for {} from Supabase", data.size(), symbol);
        }

        return buildResponseFromEntities(symbol, period, interval, data);
    }

    private HistoricalDataResponse buildResponseFromEntities(String symbol, String period, String interval,
                                                              List<HistoricalDataEntity> entities) {
        List<OhlcData> data = entities.stream()
                .map(e -> new OhlcData(
                        e.getDate().toString(),
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
