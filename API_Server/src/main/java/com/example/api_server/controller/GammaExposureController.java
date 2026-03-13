package com.example.api_server.controller;

import com.example.api_server.dto.GammaExposureResponse;
import com.example.api_server.service.GammaExposureService;
import io.github.resilience4j.ratelimiter.annotation.RateLimiter;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/gamma")
@CrossOrigin(origins = "http://localhost:5173")
public class GammaExposureController {

    private final GammaExposureService gammaExposureService;

    public GammaExposureController(GammaExposureService gammaExposureService) {
        this.gammaExposureService = gammaExposureService;
    }

    @GetMapping
    @RateLimiter(name = "marketDataApi")
    public GammaExposureResponse getGammaExposure(
            @RequestParam(defaultValue = "QQQ") String symbol) {
        return gammaExposureService.getGammaExposure(symbol);
    }
}