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
 * Serves the latest tick for a symbol by calling Yahoo Finance's public chart
 * endpoint directly — never reads from Supabase. Results are cached briefly so
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
     * bounds the rate of outgoing Yahoo calls regardless of how many clients
     * are polling.
     */
    @Cacheable(value = "liveMarketData", key = "#symbol")
    public MarketDataResponse getLivePrice(String symbol) {
        String normalized = symbol.toUpperCase();
        logger.debug("Live price cache miss for {} — calling Yahoo Finance", normalized);

        Map<String, Object> body;
        try {
            body = webClient.get()
                    .uri(uri -> uri
                            .path("/v8/finance/chart/{symbol}")
                            .queryParam("interval", "1d")
                            .queryParam("range", "1d")
                            .build(normalized))
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .timeout(Duration.ofSeconds(6))
                    .block();
        } catch (Exception ex) {
            logger.warn("Live price fetch for {} failed: {}", normalized, ex.getMessage());
            return buildResponse(normalized, null, null, null);
        }

        Map<String, Object> meta = extractMeta(body);
        Double price = readDouble(meta, "regularMarketPrice");
        Long volume = readLong(meta, "regularMarketVolume");
        // Stocks expose previousClose; futures expose chartPreviousClose.
        Double previousClose = readDouble(meta, "previousClose");
        if (previousClose == null) {
            previousClose = readDouble(meta, "chartPreviousClose");
        }

        return buildResponse(normalized, price, volume, previousClose);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> extractMeta(Map<String, Object> body) {
        if (body == null) return null;
        Object chart = body.get("chart");
        if (!(chart instanceof Map<?, ?> chartMap)) return null;
        Object result = chartMap.get("result");
        if (!(result instanceof List<?> results) || results.isEmpty()) return null;
        Object first = results.get(0);
        if (!(first instanceof Map<?, ?> firstMap)) return null;
        Object meta = firstMap.get("meta");
        if (!(meta instanceof Map<?, ?> metaMap)) return null;
        return (Map<String, Object>) metaMap;
    }

    private static Double readDouble(Map<String, Object> map, String key) {
        if (map == null) return null;
        Object v = map.get(key);
        return v instanceof Number n ? n.doubleValue() : null;
    }

    private static Long readLong(Map<String, Object> map, String key) {
        if (map == null) return null;
        Object v = map.get(key);
        return v instanceof Number n ? n.longValue() : null;
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
