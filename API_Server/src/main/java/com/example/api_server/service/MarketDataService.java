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

import java.time.LocalDateTime;
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
            try {
                MarketDataEntity entity = localRepository.findFirstBySymbolOrderByTimestampDesc(symbol.toUpperCase());

                TickerData tickerData = new TickerData();
                tickerData.setSymbol(symbol.toUpperCase());

                TickerData liveTick = fetchLiveTick(symbol);
                if (entity != null) {
                    tickerData.setPrice(entity.getPrice());
                    tickerData.setVolume(entity.getVolume());
                    logger.debug("MARKET DATA: {} | Price: {} | Volume: {} | Timestamp: {}",
                            symbol, entity.getPrice(), entity.getVolume(), entity.getTimestamp());
                } else {
                    tickerData.setPrice(liveTick == null ? null : liveTick.getPrice());
                    tickerData.setVolume(liveTick == null ? null : liveTick.getVolume());
                    logger.debug("MARKET DATA: {} - DB miss, live fallback price={}",
                            symbol, tickerData.getPrice());
                }
                tickerData.setPreviousClose(liveTick == null ? null : liveTick.getPreviousClose());

                tickerDataList.add(tickerData);
            } catch (Exception e) {
                logger.error("Error fetching {} from Supabase: {}", symbol, e.getMessage());
                TickerData tickerData = new TickerData();
                tickerData.setSymbol(symbol.toUpperCase());
                tickerData.setPrice(null);
                tickerDataList.add(tickerData);
            }
        }

        response.setTickers(tickerDataList);
        logger.info("Successfully fetched {} tickers from Supabase", tickerDataList.size());

        return response;
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
