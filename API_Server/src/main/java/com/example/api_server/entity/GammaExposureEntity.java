package com.example.api_server.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;
import java.util.List;

@Entity
@Table(name = "gamma_exposure")
public class GammaExposureEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String symbol;

    @Column(name = "computed_at", nullable = false)
    private LocalDateTime computedAt;

    @Column(name = "qqq_price")
    private Double qqqPrice;

    @Column(name = "nq_price")
    private Double nqPrice;

    @Column(name = "conversion_ratio")
    private Double conversionRatio;

    @Column(name = "expirations_used")
    private String expirationsUsed;

    @Column(name = "market_open")
    private Boolean marketOpen;

    @OneToMany(mappedBy = "gammaExposure", cascade = CascadeType.ALL, fetch = FetchType.EAGER)
    private List<GammaLevelEntity> levels;

    public GammaExposureEntity() {
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public String getSymbol() {
        return symbol;
    }

    public void setSymbol(String symbol) {
        this.symbol = symbol;
    }

    public LocalDateTime getComputedAt() {
        return computedAt;
    }

    public void setComputedAt(LocalDateTime computedAt) {
        this.computedAt = computedAt;
    }

    public Double getQqqPrice() {
        return qqqPrice;
    }

    public void setQqqPrice(Double qqqPrice) {
        this.qqqPrice = qqqPrice;
    }

    public Double getNqPrice() {
        return nqPrice;
    }

    public void setNqPrice(Double nqPrice) {
        this.nqPrice = nqPrice;
    }

    public Double getConversionRatio() {
        return conversionRatio;
    }

    public void setConversionRatio(Double conversionRatio) {
        this.conversionRatio = conversionRatio;
    }

    public String getExpirationsUsed() {
        return expirationsUsed;
    }

    public void setExpirationsUsed(String expirationsUsed) {
        this.expirationsUsed = expirationsUsed;
    }

    public Boolean getMarketOpen() {
        return marketOpen;
    }

    public void setMarketOpen(Boolean marketOpen) {
        this.marketOpen = marketOpen;
    }

    public List<GammaLevelEntity> getLevels() {
        return levels;
    }

    public void setLevels(List<GammaLevelEntity> levels) {
        this.levels = levels;
    }
}