package com.example.api_server.repository.supabase;

import com.example.api_server.entity.HistoricalDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public interface SupabaseHistoricalDataRepository extends JpaRepository<HistoricalDataEntity, Long> {

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeOrderByDateAsc(String symbol, String intervalType);

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeAndDateGreaterThanEqualOrderByDateAsc(
            String symbol, String intervalType, LocalDateTime startDate);

    /**
     * Cheap MAX(date) probe used to decide whether an incremental fetch has
     * anything to return without transferring any OHLC rows. Returning this
     * single value keeps egress negligible compared to pulling the full delta.
     */
    @Query("SELECT MAX(h.date) FROM HistoricalDataEntity h " +
            "WHERE h.symbol = :symbol AND h.intervalType = :intervalType")
    LocalDateTime findMaxDateBySymbolAndIntervalType(
            @Param("symbol") String symbol, @Param("intervalType") String intervalType);

    /**
     * Cheap MAX(fetched_at) probe — advances every time ingestion writes a
     * row (including in-place updates of the developing bar). Used by the
     * /since endpoint as a poll-cheap "anything new?" check.
     */
    @Query("SELECT MAX(h.fetchedAt) FROM HistoricalDataEntity h " +
            "WHERE h.symbol = :symbol AND h.intervalType = :intervalType")
    LocalDateTime findMaxFetchedAtBySymbolAndIntervalType(
            @Param("symbol") String symbol, @Param("intervalType") String intervalType);

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeAndDateBetweenOrderByDateAsc(
            String symbol, String intervalType, LocalDate startDate, LocalDate endDate);

    Optional<HistoricalDataEntity> findBySymbolAndDateAndIntervalType(
            String symbol, LocalDate date, String intervalType);

    void deleteBySymbolAndIntervalType(String symbol, String intervalType);
}
