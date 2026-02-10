package com.example.api_server.dto;

import java.util.List;

public class HistoricalDataResponse {
    private String symbol;
    private String period;
    private String interval;
    private String timestamp;
    private List<OhlcData> data;

    public HistoricalDataResponse() {
    }

    public HistoricalDataResponse(String symbol, String period, String interval, String timestamp, List<OhlcData> data) {
        this.symbol = symbol;
        this.period = period;
        this.interval = interval;
        this.timestamp = timestamp;
        this.data = data;
    }

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public String getPeriod() { return period; }
    public void setPeriod(String period) { this.period = period; }

    public String getInterval() { return interval; }
    public void setInterval(String interval) { this.interval = interval; }

    public String getTimestamp() { return timestamp; }
    public void setTimestamp(String timestamp) { this.timestamp = timestamp; }

    public List<OhlcData> getData() { return data; }
    public void setData(List<OhlcData> data) { this.data = data; }
}
