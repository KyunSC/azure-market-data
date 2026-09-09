package com.example.api_server.controller;

import com.example.api_server.service.BacktestDatasetService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/backtest/datasets")
public class BacktestController {
    private final BacktestDatasetService datasets;

    public BacktestController(BacktestDatasetService datasets) { this.datasets = datasets; }

    @GetMapping
    @RateLimiter(name = "marketDataApi")
    public ResponseEntity<String> catalog() { return datasets.response("index.json", false); }

    @GetMapping("/{id}")
    @RateLimiter(name = "marketDataApi")
    public ResponseEntity<String> dataset(@PathVariable String id) {
        if (!id.matches("[a-z0-9_-]+-[a-f0-9]{64}")) {
            return ResponseEntity.badRequest().body("{\"message\":\"Invalid dataset ID\"}");
        }
        return datasets.response(id + ".json", true);
    }
}
