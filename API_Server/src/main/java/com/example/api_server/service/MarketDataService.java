package com.example.api_server.service;

import com.example.api_server.dto.MarketDataRequest;
import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.dto.TickerData;
import com.example.api_server.entity.MarketDataEntity;
import com.example.api_server.exception.MarketDataException;
import com.example.api_server.repository.local.LocalMarketDataRepository;
import com.example.api_server.repository.supabase.SupabaseMarketDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.http.HttpStatusCode;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.Collections;
import java.util.List;

@Service
public class MarketDataService {

    private static final Logger logger = LoggerFactory.getLogger(MarketDataService.class);
    private final WebClient webClient;
    private final LocalMarketDataRepository localRepository;
    private final SupabaseMarketDataRepository supabaseRepository;

    public MarketDataService(WebClient webClient,
                             LocalMarketDataRepository localRepository,
                             SupabaseMarketDataRepository supabaseRepository) {
        this.webClient = webClient;
        this.localRepository = localRepository;
        this.supabaseRepository = supabaseRepository;
    }

    @Cacheable(value = "marketData", key = "#tickers.toString()")
    @CircuitBreaker(name = "marketData", fallbackMethod = "getMarketDataFallback")
    public MarketDataResponse getMarketData(List<String> tickers) {
        logger.info("Fetching market data for tickers: {}", tickers);

        MarketDataRequest request = new MarketDataRequest(tickers);

        MarketDataResponse response = webClient.post()
                .bodyValue(request)
                .retrieve()
                .onStatus(HttpStatusCode::is4xxClientError, clientResponse ->
                        clientResponse.bodyToMono(String.class)
                                .flatMap(body -> Mono.error(new MarketDataException(
                                        "Client error: " + body, clientResponse.statusCode().value()))))
                .onStatus(HttpStatusCode::is5xxServerError, clientResponse ->
                        clientResponse.bodyToMono(String.class)
                                .flatMap(body -> Mono.error(new MarketDataException(
                                        "Server error from market data service", clientResponse.statusCode().value()))))
                .bodyToMono(MarketDataResponse.class)
                .block();

        logger.info("Successfully fetched market data");

        // Save to both databases
        if (response != null && response.getTickers() != null) {
            LocalDateTime now = LocalDateTime.now();
            for (TickerData ticker : response.getTickers()) {
                MarketDataEntity entity = new MarketDataEntity(
                        ticker.getSymbol(),
                        ticker.getPrice(),
                        ticker.getVolume(),
                        now
                );

                // Save to local PostgreSQL
                try {
                    localRepository.save(entity);
                    logger.info("Saved {} to local database", ticker.getSymbol());
                } catch (Exception e) {
                    logger.error("Failed to save {} to local database: {}", ticker.getSymbol(), e.getMessage());
                }

                // Save to Supabase (new entity instance to avoid ID conflicts)
                try {
                    MarketDataEntity supabaseEntity = new MarketDataEntity(
                            ticker.getSymbol(),
                            ticker.getPrice(),
                            ticker.getVolume(),
                            now
                    );
                    supabaseRepository.save(supabaseEntity);
                    logger.info("Saved {} to Supabase", ticker.getSymbol());
                } catch (Exception e) {
                    logger.error("Failed to save {} to Supabase: {}", ticker.getSymbol(), e.getMessage());
                }
            }
            logger.info("Saved {} ticker(s) to both databases", response.getTickers().size());
        }

        return response;
    }

    public MarketDataResponse getMarketDataFallback(List<String> tickers, Exception ex) {
        logger.warn("Circuit breaker fallback triggered for tickers: {}. Reason: {}", tickers, ex.getMessage());

        MarketDataResponse fallbackResponse = new MarketDataResponse();
        fallbackResponse.setTimestamp(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));

        List<TickerData> fallbackTickers = tickers.stream()
                .map(symbol -> {
                    TickerData tickerData = new TickerData();
                    tickerData.setSymbol(symbol);
                    tickerData.setPrice(null);
                    return tickerData;
                })
                .toList();

        fallbackResponse.setTickers(fallbackTickers.isEmpty() ? Collections.emptyList() : fallbackTickers);
        return fallbackResponse;
    }
}
