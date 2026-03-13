package com.example.api_server.service;

import com.example.api_server.dto.GammaExposureResponse;
import com.example.api_server.dto.GammaLevelData;
import com.example.api_server.entity.GammaExposureEntity;
import com.example.api_server.entity.GammaLevelEntity;
import com.example.api_server.repository.local.LocalGammaExposureRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

import java.time.format.DateTimeFormatter;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

@Service
public class GammaExposureService {

    private static final Logger logger = LoggerFactory.getLogger(GammaExposureService.class);
    private final LocalGammaExposureRepository repository;

    public GammaExposureService(LocalGammaExposureRepository repository) {
        this.repository = repository;
    }

    @Cacheable(value = "gammaExposure", key = "#symbol")
    @CircuitBreaker(name = "gammaExposure", fallbackMethod = "getGammaExposureFallback")
    public GammaExposureResponse getGammaExposure(String symbol) {
        logger.info("Fetching gamma exposure for symbol: {}", symbol);

        GammaExposureEntity entity = repository.findFirstBySymbolOrderByComputedAtDesc(symbol.toUpperCase());

        if (entity == null) {
            logger.warn("No gamma exposure data found for {}", symbol);
            GammaExposureResponse empty = new GammaExposureResponse();
            empty.setLevels(Collections.emptyList());
            return empty;
        }

        GammaExposureResponse response = new GammaExposureResponse();
        response.setTimestamp(entity.getComputedAt().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));
        response.setMarketOpen(entity.getMarketOpen());
        response.setQqqPrice(entity.getQqqPrice());
        response.setNqPrice(entity.getNqPrice());
        response.setConversionRatio(entity.getConversionRatio());

        if (entity.getExpirationsUsed() != null) {
            response.setExpirationsUsed(Arrays.asList(entity.getExpirationsUsed().split(",")));
        } else {
            response.setExpirationsUsed(Collections.emptyList());
        }

        List<GammaLevelData> levels = entity.getLevels().stream()
                .map(this::toGammaLevelData)
                .toList();

        response.setLevels(levels);

        logger.info("Returning {} gamma levels for {}", levels.size(), symbol);
        return response;
    }

    private GammaLevelData toGammaLevelData(GammaLevelEntity entity) {
        GammaLevelData data = new GammaLevelData();
        data.setStrikeQqq(entity.getStrikeQqq());
        data.setStrikeNq(entity.getStrikeNq());
        data.setGex(entity.getGex());
        data.setGexCall(entity.getGexCall());
        data.setGexPut(entity.getGexPut());
        data.setLabel(entity.getLabel());
        return data;
    }

    public GammaExposureResponse getGammaExposureFallback(String symbol, Exception ex) {
        logger.warn("Circuit breaker fallback triggered for gamma exposure: {}. Reason: {}", symbol, ex.getMessage());
        GammaExposureResponse fallback = new GammaExposureResponse();
        fallback.setLevels(Collections.emptyList());
        return fallback;
    }
}