package com.example.api_server.dto;

public class GammaLevelData {

    private Double strikeQqq;
    private Double strikeNq;
    private Double gex;
    private Double gexCall;
    private Double gexPut;
    private String label;

    public Double getStrikeQqq() {
        return strikeQqq;
    }

    public void setStrikeQqq(Double strikeQqq) {
        this.strikeQqq = strikeQqq;
    }

    public Double getStrikeNq() {
        return strikeNq;
    }

    public void setStrikeNq(Double strikeNq) {
        this.strikeNq = strikeNq;
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