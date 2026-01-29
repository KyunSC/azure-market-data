package com.example.api_server.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
public class HomeController {

    @GetMapping("/")
    public Map<String, Object> home() {
        return Map.of(
                "name", "Market Data API",
                "version", "1.0.0",
                "status", "running",
                "endpoints", Map.of(
                        "GET /api/market", "Get market data for tickers",
                        "parameters", Map.of(
                                "tickers", "List of stock symbols (e.g., ?tickers=AAPL&tickers=MSFT)"
                        )
                ),
                "example", "/api/market?tickers=AAPL&tickers=GOOGL"
        );
    }

    @GetMapping("/health")
    public Map<String, String> health() {
        return Map.of("status", "UP");
    }
}
