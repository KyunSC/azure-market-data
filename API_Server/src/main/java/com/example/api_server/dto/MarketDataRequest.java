package com.example.api_server.dto;

import java.util.List;

public class MarketDataRequest {

    private List<String> tickers;

    public MarketDataRequest() {
    }

    public MarketDataRequest(List<String> tickers) {
        this.tickers = tickers;
    }

    public List<String> getTickers() {
        return tickers;
    }

    public void setTickers(List<String> tickers) {
        this.tickers = tickers;
    }
}
