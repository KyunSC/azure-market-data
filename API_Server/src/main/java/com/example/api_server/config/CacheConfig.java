package com.example.api_server.config;

import com.github.benmanes.caffeine.cache.Caffeine;
import org.springframework.cache.CacheManager;
import org.springframework.cache.caffeine.CaffeineCache;
import org.springframework.cache.support.SimpleCacheManager;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.time.Duration;
import java.util.List;

@Configuration
public class CacheConfig {

    @Bean
    public CacheManager cacheManager() {
        SimpleCacheManager manager = new SimpleCacheManager();
        manager.setCaches(List.of(
                // Live intraday bars: short TTL so polls stay fresh.
                buildCache("historicalData", Duration.ofSeconds(60), 200),
                // Non-live timeframes (1d/1wk): session-long bars rarely change,
                // so cache aggressively to cut Supabase egress.
                buildCache("historicalDataLong", Duration.ofMinutes(30), 200),
                buildCache("gammaExposure", Duration.ofSeconds(60), 50),
                buildCache("marketData", Duration.ofSeconds(60), 50)
        ));
        return manager;
    }

    private CaffeineCache buildCache(String name, Duration ttl, int maxSize) {
        return new CaffeineCache(name, Caffeine.newBuilder()
                .expireAfterWrite(ttl)
                .maximumSize(maxSize)
                .build());
    }
}
