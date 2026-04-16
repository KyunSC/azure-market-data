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

    /**
     * Incremental fetch for live polling. Client passes {@code since} = epoch
     * seconds of the last bucket it already has; response contains only bars
     * with bucket start &gt;= since. The first returned bar (if any) should
     * replace the client's last bar, since it may still be developing.
     */
    @GetMapping("/since")
    @RateLimiter(name = "marketDataApi")
    public HistoricalDataResponse getHistoricalDataSince(
            @RequestParam String symbol,
            @RequestParam(defaultValue = "1d") String interval,
            @RequestParam long since) {
        return historicalDataService.getHistoricalDataSince(symbol, interval, since);
    }
}
