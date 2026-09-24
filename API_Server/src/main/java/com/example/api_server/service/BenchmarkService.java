package com.example.api_server.service;

import com.example.api_server.exception.MarketDataException;
import java.time.*;
import java.util.*;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

@Service
public class BenchmarkService {
    private final WebClient client;
    private static final ZoneId MARKET_ZONE = ZoneId.of("America/New_York");
    private static final Set<String> CRYPTO = Set.of("BTC-USD", "ETH-USD");
    private static final Set<String> ALLOWED = Set.of("SPY", "QQQ", "XEQT.TO", "BTC-USD", "ETH-USD");

    /** Crypto trades 24/7 and Yahoo dates its daily candles at 00:00 UTC. */
    static ZoneId zoneFor(String symbol) { return CRYPTO.contains(symbol) ? ZoneOffset.UTC : MARKET_ZONE; }

    public record Point(String date, double adjustedClose) {}
    public record Benchmark(String symbol, String currency, String priceBasis, List<Point> data) {}

    public BenchmarkService(WebClient client) { this.client = client; }

    @Cacheable(value = "backtestBenchmarks", key = "#symbol + ':' + #start + ':' + #end")
    public Benchmark load(String symbol, String start, String end) {
        if (!ALLOWED.contains(symbol))
            throw new MarketDataException("Unsupported benchmark", 400);
        var zone = zoneFor(symbol);
        LocalDate from, to;
        try { from = LocalDate.parse(start); to = LocalDate.parse(end); }
        catch (DateTimeException e) { throw new MarketDataException("Use ISO dates for benchmark coverage", 400); }
        if (to.isBefore(from) || from.isBefore(to.minusYears(10)) || to.isAfter(LocalDate.now(zone)))
            throw new MarketDataException("Benchmark range must be historical and at most ten years", 400);
        try {
            var body = client.get().uri(uri -> uri.path("/v8/finance/chart/{symbol}")
                    .queryParam("interval", "1d")
                    .queryParam("period1", from.atStartOfDay(zone).toEpochSecond())
                    .queryParam("period2", to.plusDays(1).atStartOfDay(zone).toEpochSecond())
                    .queryParam("events", "div,splits")
                    .queryParam("includeAdjustedClose", "true").build(symbol))
                    .retrieve().bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .timeout(Duration.ofSeconds(12)).block();
            return parse(symbol, from, to, body);
        } catch (Exception e) {
            throw new MarketDataException("Benchmark history unavailable. Please retry.", 503);
        }
    }

    @SuppressWarnings("unchecked")
    public static Benchmark parse(String symbol, LocalDate from, LocalDate to, Map<String, Object> body) {
        var chart = (Map<String, Object>) body.get("chart");
        var result = ((List<Map<String, Object>>) chart.get("result")).getFirst();
        var times = (List<Number>) result.get("timestamp");
        var indicators = (Map<String, Object>) result.get("indicators");
        var adjusted = ((List<Map<String, Object>>) indicators.get("adjclose")).getFirst();
        var prices = (List<Number>) adjusted.get("adjclose");
        if (prices.size() != times.size()) throw new IllegalArgumentException("Mismatched benchmark columns");
        var zone = zoneFor(symbol);
        var points = new TreeMap<String, Point>();
        for (int i = 0; i < times.size(); i++) {
            if (times.get(i) == null || prices.get(i) == null) continue;
            var day = Instant.ofEpochSecond(times.get(i).longValue()).atZone(zone).toLocalDate();
            double price = prices.get(i).doubleValue();
            if (day.isBefore(from) || day.isAfter(to) || !day.isBefore(LocalDate.now(zone))) continue;
            if (!Double.isFinite(price) || price <= 0) continue;
            points.put(day.toString(), new Point(day.toString(), price));
        }
        if (points.size() < 2) throw new IllegalArgumentException("At least two completed daily closes required");
        return new Benchmark(symbol, symbol.equals("XEQT.TO") ? "CAD" : "USD", "adjusted-close", List.copyOf(points.values()));
    }
}
