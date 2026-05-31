package com.example.api_server.repository.supabase;

import com.example.api_server.dto.HistoricalBar;
import com.example.api_server.entity.HistoricalDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

@Repository
public interface SupabaseHistoricalDataRepository extends JpaRepository<HistoricalDataEntity, Long> {

    /**
     * Projection-based read used by the chart path. Hydrates only the columns
     * the response needs (date + OHLCV) instead of the full entity — drops
     * {@code id}, {@code symbol}, {@code interval_type}, and {@code fetched_at}
     * from the wire payload Supabase sends back.
     */
    @Query("SELECT new com.example.api_server.dto.HistoricalBar(" +
            "h.date, h.open, h.high, h.low, h.close, h.volume) " +
            "FROM HistoricalDataEntity h " +
            "WHERE h.symbol = :symbol AND h.intervalType = :intervalType " +
            "ORDER BY h.date ASC")
    List<HistoricalBar> findBarsBySymbolAndInterval(
            @Param("symbol") String symbol, @Param("intervalType") String intervalType);

    @Query("SELECT new com.example.api_server.dto.HistoricalBar(" +
            "h.date, h.open, h.high, h.low, h.close, h.volume) " +
            "FROM HistoricalDataEntity h " +
            "WHERE h.symbol = :symbol AND h.intervalType = :intervalType AND h.date >= :start " +
            "ORDER BY h.date ASC")
    List<HistoricalBar> findBarsBySymbolAndIntervalSince(
            @Param("symbol") String symbol, @Param("intervalType") String intervalType,
            @Param("start") LocalDateTime start);

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

    /**
     * Upsert a single OHLC bar keyed by (symbol, date, interval_type). Matches
     * the ON CONFLICT semantics in the Python ingestion code so re-ingesting
     * the developing last bar overwrites it in place. Called in a loop by the
     * Spring Boot ingestion scheduler — Postgres handles the per-row INSERT
     * pretty cheaply via the existing unique index.
     */
    @Modifying
    @Transactional("supabaseTransactionManager")
    @Query(value = """
            INSERT INTO historical_data
                (symbol, date, interval_type, open, high, low, close_price, volume, fetched_at)
            VALUES (:symbol, :date, :intervalType, :open, :high, :low, :close, :volume, :fetchedAt)
            ON CONFLICT (symbol, date, interval_type)
            DO UPDATE SET
                open = EXCLUDED.open,
                high = EXCLUDED.high,
                low = EXCLUDED.low,
                close_price = EXCLUDED.close_price,
                volume = EXCLUDED.volume,
                fetched_at = EXCLUDED.fetched_at
            """, nativeQuery = true)
    void upsertBar(@Param("symbol") String symbol,
                   @Param("date") LocalDateTime date,
                   @Param("intervalType") String intervalType,
                   @Param("open") Double open,
                   @Param("high") Double high,
                   @Param("low") Double low,
                   @Param("close") Double close,
                   @Param("volume") Long volume,
                   @Param("fetchedAt") LocalDateTime fetchedAt);
}
