package com.example.api_server.service;

import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.dto.TickerData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/**
 * Serves the latest tick for a symbol by calling the yfinance-backed Azure
 * Function directly — never reads from Supabase. Results are cached briefly so
 * a tight client poll cycle shares a single upstream call.
 */
@Service
public class LiveMarketDataService {

    private static final Logger logger = LoggerFactory.getLogger(LiveMarketDataService.class);

    private final WebClient webClient;

    public LiveMarketDataService(WebClient webClient) {
        this.webClient = webClient;
    }

    /**
     * Cached per symbol — see the {@code liveMarketData} bucket in
     * {@link com.example.api_server.config.CacheConfig} for the TTL. The TTL
     * bounds the rate of outgoing Azure Function calls regardless of how many
     * clients are polling.
     */
    @Cacheable(value = "liveMarketData", key = "#symbol")
    public MarketDataResponse getLivePrice(String symbol) {
        String normalized = symbol.toUpperCase();
        logger.debug("Live price cache miss for {} — calling Azure Function", normalized);

        Map<String, Object> body;
        try {
            body = webClient.get()
                    .uri(uri -> uri.queryParam("tickers", normalized).build())
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .timeout(Duration.ofSeconds(6))
                    .block();
        } catch (Exception ex) {
            logger.warn("Live price fetch for {} failed: {}", normalized, ex.getMessage());
            return buildResponse(normalized, null, null, null);
        }

        Double price = null;
        Long volume = null;
        Double previousClose = null;
        Object tickersObj = body == null ? null : body.get("tickers");
        if (tickersObj instanceof List<?> tickers && !tickers.isEmpty() && tickers.get(0) instanceof Map<?, ?> first) {
            Object p = first.get("price");
            Object v = first.get("volume");
            Object pc = first.get("previous_close");
            if (p instanceof Number) price = ((Number) p).doubleValue();
            if (v instanceof Number) volume = ((Number) v).longValue();
            if (pc instanceof Number) previousClose = ((Number) pc).doubleValue();
        }

        return buildResponse(normalized, price, volume, previousClose);
    }

    private MarketDataResponse buildResponse(String symbol, Double price, Long volume, Double previousClose) {
        TickerData ticker = new TickerData();
        ticker.setSymbol(symbol);
        ticker.setPrice(price);
        ticker.setVolume(volume);
        ticker.setPreviousClose(previousClose);

        MarketDataResponse response = new MarketDataResponse();
        response.setTimestamp(String.valueOf(Instant.now().getEpochSecond()));
        response.setTickers(List.of(ticker));
        return response;
    }
}
