package com.example.api_server.dto;

import java.util.List;

public class GammaExposureResponse {

    private String timestamp;
    private Boolean marketOpen;
    private Double etfPrice;
    private Double futuresPrice;
    private Double conversionRatio;
    private List<String> expirationsUsed;
    private List<GammaLevelData> levels;

    public String getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(String timestamp) {
        this.timestamp = timestamp;
    }

    public Boolean getMarketOpen() {
        return marketOpen;
    }

    public void setMarketOpen(Boolean marketOpen) {
        this.marketOpen = marketOpen;
    }

    public Double getEtfPrice() {
        return etfPrice;
    }

    public void setEtfPrice(Double etfPrice) {
        this.etfPrice = etfPrice;
    }

    public Double getFuturesPrice() {
        return futuresPrice;
    }

    public void setFuturesPrice(Double futuresPrice) {
        this.futuresPrice = futuresPrice;
    }

    public Double getConversionRatio() {
        return conversionRatio;
    }

    public void setConversionRatio(Double conversionRatio) {
        this.conversionRatio = conversionRatio;
    }

    public List<String> getExpirationsUsed() {
        return expirationsUsed;
    }

    public void setExpirationsUsed(List<String> expirationsUsed) {
        this.expirationsUsed = expirationsUsed;
    }

    public List<GammaLevelData> getLevels() {
        return levels;
    }

    public void setLevels(List<GammaLevelData> levels) {
        this.levels = levels;
    }
}