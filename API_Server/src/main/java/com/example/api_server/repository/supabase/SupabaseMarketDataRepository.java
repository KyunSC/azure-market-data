package com.example.api_server.repository.supabase;

import com.example.api_server.entity.MarketDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;

@Repository
public interface SupabaseMarketDataRepository extends JpaRepository<MarketDataEntity, Long> {

    MarketDataEntity findFirstBySymbolOrderByTimestampDesc(String symbol);

    /**
     * Upsert the current price/volume snapshot keyed by symbol. market_data
     * stores one row per symbol — re-ingesting overwrites in place instead of
     * appending. The {@code symbol} unique constraint backs the conflict
     * target.
     */
    @Modifying
    @Transactional("supabaseTransactionManager")
    @Query(value = """
            INSERT INTO market_data (symbol, price, volume, timestamp)
            VALUES (:symbol, :price, :volume, :timestamp)
            ON CONFLICT (symbol) DO UPDATE SET
                price = EXCLUDED.price,
                volume = EXCLUDED.volume,
                timestamp = EXCLUDED.timestamp
            """, nativeQuery = true)
    void upsertSnapshot(@Param("symbol") String symbol,
                        @Param("price") Double price,
                        @Param("volume") Long volume,
                        @Param("timestamp") LocalDateTime timestamp);
}
