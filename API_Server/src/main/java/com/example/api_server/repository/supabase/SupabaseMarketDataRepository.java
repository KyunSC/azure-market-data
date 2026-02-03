package com.example.api_server.repository.supabase;

import com.example.api_server.entity.MarketDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDateTime;
import java.util.List;

@Repository
public interface SupabaseMarketDataRepository extends JpaRepository<MarketDataEntity, Long> {

    List<MarketDataEntity> findBySymbolOrderByTimestampDesc(String symbol);

    List<MarketDataEntity> findBySymbolAndTimestampBetweenOrderByTimestampDesc(
            String symbol, LocalDateTime start, LocalDateTime end);

    MarketDataEntity findFirstBySymbolOrderByTimestampDesc(String symbol);
}
