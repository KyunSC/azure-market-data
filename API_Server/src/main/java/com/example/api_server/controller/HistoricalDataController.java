package com.example.api_server.controller;

import com.example.api_server.dto.HistoricalDataResponse;
import com.example.api_server.service.HistoricalDataService;
import com.example.api_server.service.LiveHistoricalService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/historical")
@CrossOrigin(origins = {"http://localhost:5173", "http://localhost:5174"})
public class HistoricalDataController {

    private final HistoricalDataService historicalDataService;
    private final LiveHistoricalService liveHistoricalService;

    public HistoricalDataController(HistoricalDataService historicalDataService,
                                    LiveHistoricalService liveHistoricalService) {
        this.historicalDataService = historicalDataService;
        this.liveHistoricalService = liveHistoricalService;
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
     *
     * Optional {@code lastFetched} is the {@code lastFetched} value the
     * client received on its previous poll. When supplied, the server
     * short-circuits without querying OHLC rows if ingestion hasn't written
     * anything new since that timestamp.
     */
    @GetMapping("/since")
    @RateLimiter(name = "marketDataApi")
    public HistoricalDataResponse getHistoricalDataSince(
            @RequestParam String symbol,
            @RequestParam(defaultValue = "1d") String interval,
            @RequestParam long since,
            @RequestParam(required = false) Long lastFetched) {
        return historicalDataService.getHistoricalDataSince(symbol, interval, since, lastFetched);
    }

    /**
     * Recent 1m bars fetched live from Yahoo, bypassing Supabase and the
     * Azure Function ingestion path. Lets the chart roll its developing
     * candle over at minute boundaries between 5-minute ingestion runs
     * without burning DB egress.
     */
    @GetMapping("/recent")
    @RateLimiter(name = "marketDataApi")
    public HistoricalDataResponse getRecent1mBars(@RequestParam String symbol) {
        return liveHistoricalService.getRecent1mBars(symbol);
    }
}
