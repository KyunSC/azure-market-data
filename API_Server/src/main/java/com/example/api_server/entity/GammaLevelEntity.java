package com.example.api_server.entity;

import jakarta.persistence.*;

@Entity
@Table(name = "gamma_levels")
public class GammaLevelEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "gamma_exposure_id", nullable = false)
    private GammaExposureEntity gammaExposure;

    @Column(name = "strike_etf")
    private Double strikeEtf;

    @Column(name = "strike_futures")
    private Double strikeFutures;

    private Double gex;

    @Column(name = "gex_call")
    private Double gexCall;

    @Column(name = "gex_put")
    private Double gexPut;

    private String label;

    public GammaLevelEntity() {
    }

    public Long getId() {
        return id;
    }

    public void setId(Long id) {
        this.id = id;
    }

    public GammaExposureEntity getGammaExposure() {
        return gammaExposure;
    }

    public void setGammaExposure(GammaExposureEntity gammaExposure) {
        this.gammaExposure = gammaExposure;
    }

    public Double getStrikeEtf() {
        return strikeEtf;
    }

    public void setStrikeEtf(Double strikeEtf) {
        this.strikeEtf = strikeEtf;
    }

    public Double getStrikeFutures() {
        return strikeFutures;
    }

    public void setStrikeFutures(Double strikeFutures) {
        this.strikeFutures = strikeFutures;
    }

    public Double getGex() {
        return gex;
    }

    public void setGex(Double gex) {
        this.gex = gex;
    }

    public Double getGexCall() {
        return gexCall;
    }

    public void setGexCall(Double gexCall) {
        this.gexCall = gexCall;
    }

    public Double getGexPut() {
        return gexPut;
    }

    public void setGexPut(Double gexPut) {
        this.gexPut = gexPut;
    }

    public String getLabel() {
        return label;
    }

    public void setLabel(String label) {
        this.label = label;
    }
}