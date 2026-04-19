package com.example.api_server.controller;

import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.service.LiveMarketDataService;
import com.example.api_server.service.MarketDataService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/market")
@CrossOrigin(origins = "http://localhost:5173")
public class MarketDataController {

    private final MarketDataService marketDataService;
    private final LiveMarketDataService liveMarketDataService;

    public MarketDataController(MarketDataService marketDataService,
                                LiveMarketDataService liveMarketDataService) {
        this.marketDataService = marketDataService;
        this.liveMarketDataService = liveMarketDataService;
    }

    @GetMapping
    @RateLimiter(name = "marketDataApi")
    public MarketDataResponse getMarketData(
            @RequestParam(required = false, defaultValue = "") List<String> tickers) {
        return marketDataService.getMarketData(tickers);
    }

    /**
     * Live tick for the developing bar. Hits the yfinance-backed Azure Function
     * directly (no Supabase read) and is cached in-memory so many clients share
     * one upstream call per TTL.
     */
    @GetMapping("/live")
    @RateLimiter(name = "marketDataApi")
    public MarketDataResponse getLiveMarketData(@RequestParam String symbol) {
        return liveMarketDataService.getLivePrice(symbol);
    }
}
