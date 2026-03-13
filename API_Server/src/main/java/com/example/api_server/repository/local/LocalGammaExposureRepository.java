package com.example.api_server.repository.local;

import com.example.api_server.entity.GammaExposureEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface LocalGammaExposureRepository extends JpaRepository<GammaExposureEntity, Long> {

    GammaExposureEntity findFirstBySymbolOrderByComputedAtDesc(String symbol);
}