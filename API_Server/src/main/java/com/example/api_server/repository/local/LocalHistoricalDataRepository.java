package com.example.api_server.repository.local;

import com.example.api_server.entity.HistoricalDataEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.time.LocalDate;
import java.util.List;
import java.util.Optional;

@Repository
public interface LocalHistoricalDataRepository extends JpaRepository<HistoricalDataEntity, Long> {

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeOrderByDateAsc(String symbol, String intervalType);

    List<HistoricalDataEntity> findBySymbolAndIntervalTypeAndDateBetweenOrderByDateAsc(
            String symbol, String intervalType, LocalDate startDate, LocalDate endDate);

    Optional<HistoricalDataEntity> findBySymbolAndDateAndIntervalType(
            String symbol, LocalDate date, String intervalType);

    void deleteBySymbolAndIntervalType(String symbol, String intervalType);
}
