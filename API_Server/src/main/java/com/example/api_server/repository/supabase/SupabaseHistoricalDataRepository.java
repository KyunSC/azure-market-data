package com.example.api_server.repository.supabase;

import com.example.api_server.entity.HistoricalDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
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

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeAndDateBetweenOrderByDateAsc(
            String symbol, String intervalType, LocalDate startDate, LocalDate endDate);

    Optional<HistoricalDataEntity> findBySymbolAndDateAndIntervalType(
            String symbol, LocalDate date, String intervalType);

    void deleteBySymbolAndIntervalType(String symbol, String intervalType);
}
