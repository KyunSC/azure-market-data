package com.example.api_server.dto;

public class OhlcData {
    private String time;
    private Double open;
    private Double high;
    private Double low;
    private Double close;
    private Long volume;

    public OhlcData() {
    }

    public OhlcData(String time, Double open, Double high, Double low, Double close, Long volume) {
        this.time = time;
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume;
    }

    public String getTime() { return time; }
    public void setTime(String time) { this.time = time; }

    public Double getOpen() { return open; }
    public void setOpen(Double open) { this.open = open; }

    public Double getHigh() { return high; }
    public void setHigh(Double high) { this.high = high; }

    public Double getLow() { return low; }
    public void setLow(Double low) { this.low = low; }

    public Double getClose() { return close; }
    public void setClose(Double close) { this.close = close; }

    public Long getVolume() { return volume; }
    public void setVolume(Long volume) { this.volume = volume; }
}
