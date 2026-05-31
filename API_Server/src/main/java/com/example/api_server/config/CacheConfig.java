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
                // Live intraday bars: full-fetch cache. Bumped beyond poll-cycle
                // time so repeated full refreshes within a minute share a hit.
                // Only used for the live "today" 1m view now — everything else
                // intraday routes to the medium bucket below.
                buildCache("historicalData", Duration.ofSeconds(90), 200),
                // Multi-day intraday and same-day non-1m views. Ingestion runs
                // every 5 min, so a 5-min TTL never serves data older than the
                // upstream write cadence while turning the biggest miss path
                // (e.g. 1m bars over 5d ≈ 290 KB/fetch) into one Supabase read
                // every 5 min across all viewers.
                buildCache("historicalDataMedium", Duration.ofMinutes(5), 200),
                // Non-live timeframes (1d/1wk): session-long bars rarely change,
                // so cache aggressively to cut Supabase egress.
                buildCache("historicalDataLong", Duration.ofHours(1), 200),
                // MAX(fetched_at) probe for the /since incremental endpoint.
                // Short TTL so newly-ingested bars surface quickly, but long
                // enough that a tight poll loop (every few seconds) shares a
                // single cache entry across clients instead of hitting
                // Supabase on every poll.
                buildCache("latestFetchedAt", Duration.ofSeconds(15), 200),
                // GEX is recomputed by the scheduled ingestion job every 15
                // minutes, so serving 5-minute-old data is fine.
                buildCache("gammaExposure", Duration.ofMinutes(5), 50),
                buildCache("marketData", Duration.ofSeconds(60), 50),
                // Live tick endpoint — cached briefly so a tight client poll
                // cycle fans out to a single Yahoo call per TTL across all
                // viewers. Keep short enough to feel live.
                buildCache("liveMarketData", Duration.ofSeconds(5), 50),
                // Live 1m bars fetched directly from Yahoo (bypasses Supabase
                // entirely). Sized to roll the developing bar over at minute
                // boundaries without burning DB egress between 5-minute
                // ingestion runs.
                buildCache("liveHistoricalData", Duration.ofSeconds(30), 50)
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
