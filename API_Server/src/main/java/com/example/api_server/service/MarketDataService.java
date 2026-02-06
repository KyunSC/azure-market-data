package com.example.api_server.service;

import com.example.api_server.dto.MarketDataResponse;
import com.example.api_server.dto.TickerData;
import com.example.api_server.entity.MarketDataEntity;
import com.example.api_server.repository.supabase.SupabaseMarketDataRepository;
import io.github.resilience4j.circuitbreaker.annotation.CircuitBreaker;
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
    private final SupabaseMarketDataRepository supabaseRepository;

    public MarketDataService(SupabaseMarketDataRepository supabaseRepository) {
        this.supabaseRepository = supabaseRepository;
    }

    @Cacheable(value = "marketData", key = "#tickers.toString()")
    @CircuitBreaker(name = "marketData", fallbackMethod = "getMarketDataFallback")
    public MarketDataResponse getMarketData(List<String> tickers) {
        logger.info("Fetching market data for tickers: {} from Supabase", tickers);

        MarketDataResponse response = new MarketDataResponse();
        response.setTimestamp(LocalDateTime.now().format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss")));

        List<TickerData> tickerDataList = new ArrayList<>();

        for (String symbol : tickers) {
            try {
                MarketDataEntity entity = supabaseRepository.findFirstBySymbolOrderByTimestampDesc(symbol.toUpperCase());

                TickerData tickerData = new TickerData();
                tickerData.setSymbol(symbol.toUpperCase());

                if (entity != null) {
                    tickerData.setPrice(entity.getPrice());
                    tickerData.setVolume(entity.getVolume());
                    logger.info("Found {} in Supabase: price={}, volume={}", symbol, entity.getPrice(), entity.getVolume());
                } else {
                    tickerData.setPrice(null);
                    tickerData.setVolume(null);
                    logger.warn("No data found for {} in Supabase", symbol);
                }

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
