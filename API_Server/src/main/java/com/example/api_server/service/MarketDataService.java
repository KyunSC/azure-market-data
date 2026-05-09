package com.example.api_server.service;

import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.dto.TickerData;
import com.example.api_server.entity.MarketDataEntity;
import com.example.api_server.repository.supabase.SupabaseMarketDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
import io.github.resilience4j.retry.annotation.Retry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.cache.annotation.Cacheable;
import org.springframework.stereotype.Service;

import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

@Service
public class MarketDataService {

    private static final Logger logger = LoggerFactory.getLogger(MarketDataService.class);
    private final SupabaseMarketDataRepository localRepository;
    private final LiveMarketDataService liveMarketDataService;

    public MarketDataService(SupabaseMarketDataRepository localRepository,
                             LiveMarketDataService liveMarketDataService) {
        this.localRepository = localRepository;
        this.liveMarketDataService = liveMarketDataService;
    }

    @Cacheable(value = "marketData", key = "#tickers.toString()")
    @Retry(name = "marketData")
    @CircuitBreaker(name = "marketData", fallbackMethod = "getMarketDataFallback")
    public MarketDataResponse getMarketData(List<String> tickers) {
        logger.info("Fetching market data for tickers: {} from Supabase", tickers);

        MarketDataResponse response = new MarketDataResponse();
        response.setTimestamp(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));

        List<TickerData> tickerDataList = new ArrayList<>();

        for (String symbol : tickers) {
            TickerData tickerData = new TickerData();
            tickerData.setSymbol(symbol.toUpperCase());

            MarketDataEntity entity = null;
            try {
                entity = localRepository.findFirstBySymbolOrderByTimestampDesc(symbol.toUpperCase());
            } catch (Exception e) {
                logger.warn("DB lookup failed for {}: {} — falling back to live tick", symbol, e.getMessage());
            }

            TickerData liveTick = fetchLiveTick(symbol);
            Double livePrice = liveTick == null ? null : liveTick.getPrice();
            if (livePrice != null) {
                tickerData.setPrice(livePrice);
                tickerData.setVolume(liveTick.getVolume());
            } else if (entity != null) {
                tickerData.setPrice(entity.getPrice());
                tickerData.setVolume(entity.getVolume());
            } else {
                tickerData.setPrice(null);
                tickerData.setVolume(null);
            }

            Double previousClose;
            if (isWeekend() && entity != null) {
                try {
                    previousClose = fetchPreviousTradingDayClose(symbol.toUpperCase(), entity);
                } catch (Exception e) {
                    logger.warn("Previous-close lookup failed for {}: {}", symbol, e.getMessage());
                    previousClose = liveTick == null ? null : liveTick.getPreviousClose();
                }
            } else {
                previousClose = liveTick == null ? null : liveTick.getPreviousClose();
            }
            tickerData.setPreviousClose(previousClose);

            tickerDataList.add(tickerData);
        }

        response.setTickers(tickerDataList);
        logger.info("Successfully fetched {} tickers from Supabase", tickerDataList.size());

        return response;
    }

    private boolean isWeekend() {
        DayOfWeek day = LocalDate.now(ZoneId.of("America/New_York")).getDayOfWeek();
        return day == DayOfWeek.SATURDAY || day == DayOfWeek.SUNDAY;
    }

    private Double fetchPreviousTradingDayClose(String symbol, MarketDataEntity current) {
        LocalDateTime startOfCurrentDay = current.getTimestamp().toLocalDate().atStartOfDay();
        MarketDataEntity prev = localRepository.findFirstBySymbolAndTimestampBeforeOrderByTimestampDesc(
                symbol, startOfCurrentDay);
        return prev != null ? prev.getPrice() : null;
    }

    private TickerData fetchLiveTick(String symbol) {
        try {
            MarketDataResponse live = liveMarketDataService.getLivePrice(symbol);
            if (live == null || live.getTickers() == null || live.getTickers().isEmpty()) {
                return null;
            }
            return live.getTickers().get(0);
        } catch (Exception ex) {
            logger.warn("Live fallback failed for {}: {}", symbol, ex.getMessage());
            return null;
        }
    }

    public MarketDataResponse getMarketDataFallback(List<String> tickers, Exception ex) {
        logger.warn("Circuit breaker fallback triggered for tickers: {}. Reason: {}", tickers, ex.getMessage());

        MarketDataResponse fallbackResponse = new MarketDataResponse();
        fallbackResponse.setTimestamp(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));

        List<TickerData> fallbackTickers = tickers.stream()
                .map(symbol -> {
                    TickerData tickerData = new TickerData();
                    tickerData.setSymbol(symbol);
                    tickerData.setPrice(null);
                    return tickerData;
                })
                .toList();

        fallbackResponse.setTickers(fallbackTickers.isEmpty() ? Collections.emptyList() : fallbackTickers);
        return fallbackResponse;
    }
}
