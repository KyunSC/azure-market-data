package com.example.api_server.dto;

import java.util.List;

public class MarketDataResponse {
    private String timestamp;
    private List<TickerData> tickers;

    public String getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(String timestamp) {
        this.timestamp = timestamp;
    }

    public List<TickerData> getTickers() {
        return tickers;
    }

    public void setTickers(List<TickerData> tickers) {
        this.tickers = tickers;
    }
}
