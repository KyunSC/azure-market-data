package com.example.api_server.controller;

import com.example.api_server.service.BenchmarkService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/backtest/benchmark")
public class BenchmarkController {
    private final BenchmarkService service;
    public BenchmarkController(BenchmarkService service) { this.service = service; }

    @GetMapping
    @RateLimiter(name = "marketDataApi")
    public BenchmarkService.Benchmark get(@RequestParam(defaultValue = "SPY") String symbol,
                                         @RequestParam String start, @RequestParam String end) {
        return service.load(symbol, start, end);
    }
}
