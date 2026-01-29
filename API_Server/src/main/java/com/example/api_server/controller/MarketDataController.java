package com.example.api_server.controller;

import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.service.MarketDataService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/market")
public class MarketDataController {

    private final MarketDataService marketDataService;

    public MarketDataController(MarketDataService marketDataService) {
        this.marketDataService = marketDataService;
    }

    @GetMapping
    public MarketDataResponse getMarketData(
            @RequestParam(required = false, defaultValue = "") List<String> tickers) {
        return marketDataService.getMarketData(tickers);
    }
}
