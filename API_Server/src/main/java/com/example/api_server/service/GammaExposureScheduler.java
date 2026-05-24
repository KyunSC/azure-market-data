package com.example.api_server.service;

import com.example.api_server.entity.GammaExposureEntity;
import com.example.api_server.entity.GammaLevelEntity;
import com.example.api_server.repository.supabase.SupabaseGammaExposureRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.cache.CacheManager;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;

/**
 * Replaces the Python ScheduledGammaExposure Azure Function.
 *
 * Runs every 5 minutes during RTH (13:00–20:59 UTC, weekdays). The Python
 * function used the same cron expression — the only change is *where* it
 * runs (Render free tier vs Azure paid execution).
 *
 * The instance is kept warm by UptimeRobot pinging /health during market
 * hours, so the scheduler reliably fires (per the hosting note in CLAUDE.md).
 */
@Component
public class GammaExposureScheduler {

    private static final Logger logger = LoggerFactory.getLogger(GammaExposureScheduler.class);

    private final GammaExposureComputeService computeService;
    private final SupabaseGammaExposureRepository repository;
    private final CacheManager cacheManager;
    private final boolean enabled;

    public GammaExposureScheduler(GammaExposureComputeService computeService,
                                  SupabaseGammaExposureRepository repository,
                                  CacheManager cacheManager,
                                  @Value("${app.scheduler.gex.enabled:true}") boolean enabled) {
        this.computeService = computeService;
        this.repository = repository;
        this.cacheManager = cacheManager;
        this.enabled = enabled;
    }

    @Scheduled(cron = "0 */5 13-20 * * MON-FRI", zone = "UTC")
    public void run() {
        if (!enabled) {
            return;
        }
        if (!GammaExposureComputeService.isMarketOpen()) {
            logger.info("Equity market closed — skipping GEX computation.");
            return;
        }

        logger.info("ScheduledGammaExposure started");
        for (String etfSymbol : GammaExposureComputeService.GEX_PAIRS.keySet()) {
            try {
                GammaExposureComputeService.GexResult result = computeService.fetchAndCompute(etfSymbol);
                Long id = persist(result);
                evictCache(etfSymbol);
                logger.info("Saved GEX data (id={}), {}={}, {}={}, {} levels",
                        id, etfSymbol, result.etfPrice(),
                        result.futuresSymbol(), result.futuresPrice(),
                        result.levels().size());
            } catch (Exception ex) {
                // Per-symbol isolation: one bad pair can't kill the others.
                // The API already serves the latest valid row from DB via
                // findLatestValidBySymbol, so a missed cycle is invisible to
                // the chart.
                logger.error("Error computing gamma exposure for {}: {}", etfSymbol, ex.getMessage(), ex);
            }
        }
        logger.info("ScheduledGammaExposure completed");
    }

    @Transactional("supabaseTransactionManager")
    public Long persist(GammaExposureComputeService.GexResult result) {
        GammaExposureEntity exposure = new GammaExposureEntity();
        exposure.setSymbol(result.etfSymbol());
        exposure.setComputedAt(LocalDateTime.now(ZoneOffset.UTC));
        exposure.setEtfPrice(result.etfPrice());
        exposure.setFuturesPrice(result.futuresPrice());
        exposure.setConversionRatio(result.conversionRatio());
        exposure.setExpirationsUsed(String.join(",", result.expirationsUsed()));
        exposure.setMarketOpen(result.marketOpen());
        exposure.setPcrVolume(result.pcrVolume());
        exposure.setPcrOi(result.pcrOi());
        exposure.setIvAtm(result.ivAtm());
        exposure.setIvSkew(result.ivSkew());

        List<GammaLevelEntity> levels = new ArrayList<>(result.levels().size());
        for (GammaExposureComputeService.StrikeData s : result.levels()) {
            GammaLevelEntity lvl = new GammaLevelEntity();
            lvl.setGammaExposure(exposure);
            lvl.setStrikeEtf(s.strikeEtf());
            lvl.setStrikeFutures(s.strikeFutures());
            lvl.setGex(s.gex());
            lvl.setGexCall(s.gexCall());
            lvl.setGexPut(s.gexPut());
            lvl.setGex0dte(s.gex0dte());
            lvl.setGex1dte(s.gex1dte());
            lvl.setGexWeekly(s.gexWeekly());
            lvl.setGexMonthly(s.gexMonthly());
            lvl.setLabel(s.label());
            levels.add(lvl);
        }
        exposure.setLevels(levels);

        repository.save(exposure);
        return exposure.getId();
    }

    private void evictCache(String etfSymbol) {
        // GammaExposureService is @Cacheable on uppercase symbol — the cron
        // freshens the DB row, evicting forces the next read to surface it
        // instead of serving a stale 5-min entry.
        var cache = cacheManager.getCache("gammaExposure");
        if (cache != null) cache.evict(etfSymbol.toUpperCase());
    }
}
