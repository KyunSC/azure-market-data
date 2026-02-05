package com.example.api_server.service;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import com.example.api_server.entity.HistoricalDataEntity;
import com.example.api_server.exception.MarketDataException;
import com.example.api_server.repository.local.LocalHistoricalDataRepository;
// import com.example.api_server.repository.supabase.SupabaseHistoricalDataRepository;  // TEMPORARILY DISABLED
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class HistoricalDataService {

    private static final Logger logger = LoggerFactory.getLogger(HistoricalDataService.class);
    private static final long CACHE_HOURS = 1; // Refresh data if older than 1 hour

    private final WebClient.Builder webClientBuilder;
    private final LocalHistoricalDataRepository localRepository;
    // private final SupabaseHistoricalDataRepository supabaseRepository;  // TEMPORARILY DISABLED

    @Value("${azure.function.base-url:http://localhost:7071/api}")
    private String azureFunctionBaseUrl;

    public HistoricalDataService(WebClient.Builder webClientBuilder,
                                  LocalHistoricalDataRepository localRepository) {
        this.webClientBuilder = webClientBuilder;
        this.localRepository = localRepository;
        // this.supabaseRepository = supabaseRepository;  // TEMPORARILY DISABLED
    }

    @Cacheable(value = "historicalData", key = "#symbol + '-' + #period + '-' + #interval")
    @CircuitBreaker(name = "historicalData", fallbackMethod = "getHistoricalDataFallback")
    public HistoricalDataResponse getHistoricalData(String symbol, String period, String interval) {
        logger.info("Fetching historical data for {} with period={}, interval={}", symbol, period, interval);

        // Check if we have fresh data in DB
        List<HistoricalDataEntity> cachedData = localRepository
                .findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), interval);

        if (!cachedData.isEmpty()) {
            LocalDateTime latestFetch = cachedData.get(cachedData.size() - 1).getFetchedAt();
            if (latestFetch.plusHours(CACHE_HOURS).isAfter(LocalDateTime.now())) {
                logger.info("Returning cached data for {} from database", symbol);
                return buildResponseFromEntities(symbol, period, interval, cachedData);
            }
        }

        // Fetch from Azure Function
        HistoricalDataResponse response = fetchFromAzureFunction(symbol, period, interval);

        // Save to databases
        if (response != null && response.getData() != null) {
            saveToDatabase(symbol.toUpperCase(), interval, response.getData());
        }

        return response;
    }

    private HistoricalDataResponse fetchFromAzureFunction(String symbol, String period, String interval) {
        String url = String.format("%s/HistoricalDataFunction?symbol=%s&period=%s&interval=%s",
                azureFunctionBaseUrl, symbol, period, interval);

        logger.info("Calling Azure Function: {}", url);

        return webClientBuilder.build()
                .get()
                .uri(url)
                .retrieve()
                .onStatus(HttpStatusCode::is4xxClientError, clientResponse ->
                        clientResponse.bodyToMono(String.class)
                                .flatMap(body -> Mono.error(new MarketDataException(
                                        "Client error: " + body, clientResponse.statusCode().value()))))
                .onStatus(HttpStatusCode::is5xxServerError, clientResponse ->
                        clientResponse.bodyToMono(String.class)
                                .flatMap(body -> Mono.error(new MarketDataException(
                                        "Server error from historical data service", clientResponse.statusCode().value()))))
                .bodyToMono(HistoricalDataResponse.class)
                .block();
    }

    @Transactional
    private void saveToDatabase(String symbol, String interval, List<OhlcData> data) {
        LocalDateTime now = LocalDateTime.now();

        for (OhlcData ohlc : data) {
            LocalDate date = LocalDate.parse(ohlc.getTime());

            // Check if record exists and update, or create new
            HistoricalDataEntity entity = localRepository
                    .findBySymbolAndDateAndIntervalType(symbol, date, interval)
                    .orElse(new HistoricalDataEntity());

            entity.setSymbol(symbol);
            entity.setDate(date);
            entity.setIntervalType(interval);
            entity.setOpen(ohlc.getOpen());
            entity.setHigh(ohlc.getHigh());
            entity.setLow(ohlc.getLow());
            entity.setClose(ohlc.getClose());
            entity.setVolume(ohlc.getVolume());
            entity.setFetchedAt(now);

            // Save to local DB
            try {
                localRepository.save(entity);
            } catch (Exception e) {
                logger.error("Failed to save {} {} to local database: {}", symbol, date, e.getMessage());
            }

            // Save to Supabase - TEMPORARILY DISABLED
            // try {
            //     HistoricalDataEntity supabaseEntity = supabaseRepository
            //             .findBySymbolAndDateAndIntervalType(symbol, date, interval)
            //             .orElse(new HistoricalDataEntity());
            //
            //     supabaseEntity.setSymbol(symbol);
            //     supabaseEntity.setDate(date);
            //     supabaseEntity.setIntervalType(interval);
            //     supabaseEntity.setOpen(ohlc.getOpen());
            //     supabaseEntity.setHigh(ohlc.getHigh());
            //     supabaseEntity.setLow(ohlc.getLow());
            //     supabaseEntity.setClose(ohlc.getClose());
            //     supabaseEntity.setVolume(ohlc.getVolume());
            //     supabaseEntity.setFetchedAt(now);
            //
            //     supabaseRepository.save(supabaseEntity);
            // } catch (Exception e) {
            //     logger.error("Failed to save {} {} to Supabase: {}", symbol, date, e.getMessage());
            // }
        }

        logger.info("Saved {} records for {} to databases", data.size(), symbol);
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

        // Try to return cached data from DB even if stale
        List<HistoricalDataEntity> cachedData = localRepository
                .findBySymbolAndIntervalTypeOrderByDateAsc(symbol.toUpperCase(), interval);

        if (!cachedData.isEmpty()) {
            logger.info("Returning stale cached data for {} from database", symbol);
            return buildResponseFromEntities(symbol, period, interval, cachedData);
        }

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
