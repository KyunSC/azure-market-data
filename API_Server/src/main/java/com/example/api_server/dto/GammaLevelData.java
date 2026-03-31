package com.example.api_server.dto;

public class GammaLevelData {

    private Double strikeEtf;
    private Double strikeFutures;
    private Double gex;
    private Double gexCall;
    private Double gexPut;
    private String label;

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