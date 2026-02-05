package com.example.api_server.controller;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.service.HistoricalDataService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/historical")
@CrossOrigin(origins = {"http://localhost:5173", "http://localhost:5174"})
public class HistoricalDataController {

    private final HistoricalDataService historicalDataService;

    public HistoricalDataController(HistoricalDataService historicalDataService) {
        this.historicalDataService = historicalDataService;
    }

    @GetMapping
    @RateLimiter(name = "marketDataApi")
    public HistoricalDataResponse getHistoricalData(
            @RequestParam String symbol,
            @RequestParam(defaultValue = "1mo") String period,
            @RequestParam(defaultValue = "1d") String interval) {
        return historicalDataService.getHistoricalData(symbol, period, interval);
    }
}
