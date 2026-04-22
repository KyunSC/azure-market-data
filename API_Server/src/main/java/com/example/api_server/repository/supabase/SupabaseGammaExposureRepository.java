package com.example.api_server.repository.supabase;

import com.example.api_server.entity.GammaExposureEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

@Repository
public interface SupabaseGammaExposureRepository extends JpaRepository<GammaExposureEntity, Long> {

    GammaExposureEntity findFirstBySymbolOrderByComputedAtDesc(String symbol);

    // Legacy rows exist where every level has null strike_etf/strike_futures
    // (from a broken fallback chain). Those rows serialize fine but draw nothing
    // on the chart. Skip them and return the most recent row that has at least
    // one level with non-null strike data.
    @Query("SELECT ge FROM GammaExposureEntity ge WHERE ge.symbol = :symbol " +
            "AND EXISTS (SELECT 1 FROM GammaLevelEntity gl " +
            "WHERE gl.gammaExposure = ge AND gl.strikeFutures IS NOT NULL) " +
            "ORDER BY ge.computedAt DESC LIMIT 1")
    GammaExposureEntity findLatestValidBySymbol(@Param("symbol") String symbol);
}
