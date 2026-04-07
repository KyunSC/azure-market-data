package com.example.api_server.repository.supabase;

import com.example.api_server.entity.GammaExposureEntity;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

@Repository
public interface SupabaseGammaExposureRepository extends JpaRepository<GammaExposureEntity, Long> {

    GammaExposureEntity findFirstBySymbolOrderByComputedAtDesc(String symbol);
}
