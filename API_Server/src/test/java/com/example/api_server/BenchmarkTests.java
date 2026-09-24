package com.example.api_server;

import com.example.api_server.service.BenchmarkService;
import com.example.api_server.exception.MarketDataException;
import java.time.LocalDate;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.springframework.web.reactive.function.client.WebClient;
import static org.junit.jupiter.api.Assertions.*;

class BenchmarkTests {
    @Test void validatesBeforeCallingProvider() {
        var service = new BenchmarkService(WebClient.builder().exchangeFunction(request -> { throw new AssertionError("Must not fetch"); }).build());
        assertEquals(400, assertThrows(MarketDataException.class, () -> service.load("BAD", "2025-01-01", "2025-01-10")).getStatusCode());
        assertEquals(400, assertThrows(MarketDataException.class, () -> service.load("SPY", "bad", "2025-01-10")).getStatusCode());
        assertEquals(400, assertThrows(MarketDataException.class, () -> service.load("SPY", "2025-02-01", "2025-01-10")).getStatusCode());
    }

    @Test void usesAdjustedPricesAndIdentifiesCanadianBenchmark() {
        Map<String, Object> result = Map.of("timestamp", List.of(1735828200L, 1735914600L),
                "indicators", Map.of("adjclose", List.of(Map.of("adjclose", List.of(30.0, 33.0)))));
        var benchmark = BenchmarkService.parse("XEQT.TO", LocalDate.parse("2025-01-01"), LocalDate.parse("2025-01-10"),
                Map.of("chart", Map.of("result", List.of(result))));
        assertEquals("CAD", benchmark.currency());
        assertEquals("adjusted-close", benchmark.priceBasis());
        assertEquals(2, benchmark.data().size());
        assertEquals("2025-01-02", benchmark.data().getFirst().date());
        assertEquals(33.0, benchmark.data().getLast().adjustedClose());
    }

    @Test void datesCryptoCandlesInUtc() {
        // 2025-01-04T00:00Z and 2025-01-05T00:00Z: a weekend, and the evening before in New York.
        Map<String, Object> result = Map.of("timestamp", List.of(1735948800L, 1736035200L),
                "indicators", Map.of("adjclose", List.of(Map.of("adjclose", List.of(98000.0, 98300.0)))));
        var benchmark = BenchmarkService.parse("BTC-USD", LocalDate.parse("2025-01-01"), LocalDate.parse("2025-01-10"),
                Map.of("chart", Map.of("result", List.of(result))));
        assertEquals("USD", benchmark.currency());
        assertEquals(List.of("2025-01-04", "2025-01-05"), benchmark.data().stream().map(BenchmarkService.Point::date).toList());
    }
}
