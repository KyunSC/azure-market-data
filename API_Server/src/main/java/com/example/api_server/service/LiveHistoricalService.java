package com.example.api_server.service;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.dto.OhlcData;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Serves recent 1m OHLC bars by calling Yahoo Finance's chart endpoint
 * directly — never reads from Supabase, never triggers an Azure Function.
 * Used by the chart UI on 1m intervals so the developing candle rolls over
 * at every minute boundary instead of waiting for the 5-minute ingestion
 * timer. Cached per-symbol so many viewers share a single upstream call.
 */
@Service
public class LiveHistoricalService {

    private static final Logger logger = LoggerFactory.getLogger(LiveHistoricalService.class);

    private final WebClient webClient;

    public LiveHistoricalService(WebClient webClient) {
        this.webClient = webClient;
    }

    /**
     * Cached per symbol — see the {@code liveHistoricalData} bucket in
     * {@link com.example.api_server.config.CacheConfig} for the TTL.
     */
    @Cacheable(value = "liveHistoricalData", key = "#symbol")
    public HistoricalDataResponse getRecent1mBars(String symbol) {
        String normalized = symbol.toUpperCase();
        logger.debug("Live 1m bars cache miss for {} — calling Yahoo Finance", normalized);

        Map<String, Object> body;
        try {
            body = webClient.get()
                    .uri(uri -> uri
                            .path("/v8/finance/chart/{symbol}")
                            .queryParam("interval", "1m")
                            .queryParam("range", "1d")
                            .build(normalized))
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .timeout(Duration.ofSeconds(6))
                    .block();
        } catch (Exception ex) {
            logger.warn("Live 1m fetch for {} failed: {}", normalized, ex.getMessage());
            return emptyResponse(normalized);
        }

        return buildResponse(normalized, body);
    }

    private HistoricalDataResponse buildResponse(String symbol, Map<String, Object> body) {
        List<OhlcData> bars = new ArrayList<>();
        if (body == null) return wrap(symbol, bars);

        Object chart = body.get("chart");
        if (!(chart instanceof Map<?, ?> chartMap)) return wrap(symbol, bars);
        Object result = chartMap.get("result");
        if (!(result instanceof List<?> results) || results.isEmpty()) return wrap(symbol, bars);
        Object first = results.get(0);
        if (!(first instanceof Map<?, ?> firstMap)) return wrap(symbol, bars);

        Object timestampsRaw = firstMap.get("timestamp");
        if (!(timestampsRaw instanceof List<?> timestamps)) return wrap(symbol, bars);

        Object indicatorsRaw = firstMap.get("indicators");
        if (!(indicatorsRaw instanceof Map<?, ?> indicators)) return wrap(symbol, bars);
        Object quoteRaw = indicators.get("quote");
        if (!(quoteRaw instanceof List<?> quoteList) || quoteList.isEmpty()) return wrap(symbol, bars);
        Object quoteFirst = quoteList.get(0);
        if (!(quoteFirst instanceof Map<?, ?> quote)) return wrap(symbol, bars);

        List<?> opens = asList(quote.get("open"));
        List<?> highs = asList(quote.get("high"));
        List<?> lows = asList(quote.get("low"));
        List<?> closes = asList(quote.get("close"));
        List<?> volumes = asList(quote.get("volume"));

        int n = timestamps.size();
        for (int i = 0; i < n; i++) {
            Long ts = readLong(timestamps.get(i));
            Double open = readDouble(get(opens, i));
            Double high = readDouble(get(highs, i));
            Double low = readDouble(get(lows, i));
            Double close = readDouble(get(closes, i));
            Long volume = readLong(get(volumes, i));
            if (ts == null || open == null || high == null || low == null || close == null) continue;
            bars.add(new OhlcData(String.valueOf(ts), open, high, low, close, volume == null ? 0L : volume));
        }
        return wrap(symbol, bars);
    }

    private HistoricalDataResponse wrap(String symbol, List<OhlcData> bars) {
        return new HistoricalDataResponse(
                symbol,
                "live",
                "1m",
                LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")),
                bars);
    }

    private HistoricalDataResponse emptyResponse(String symbol) {
        return wrap(symbol, List.of());
    }

    private static List<?> asList(Object o) {
        return o instanceof List<?> l ? l : List.of();
    }

    private static Object get(List<?> l, int i) {
        return i < l.size() ? l.get(i) : null;
    }

    private static Double readDouble(Object v) {
        return v instanceof Number n ? n.doubleValue() : null;
    }

    private static Long readLong(Object v) {
        return v instanceof Number n ? n.longValue() : null;
    }
}
