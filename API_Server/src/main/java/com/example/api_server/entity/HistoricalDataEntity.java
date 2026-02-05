package com.example.api_server.entity;

import jakarta.persistence.*;
import java.time.LocalDate;
import java.time.LocalDateTime;

@Entity
@Table(name = "historical_data", uniqueConstraints = {
    @UniqueConstraint(columnNames = {"symbol", "date", "interval_type"})
})
public class HistoricalDataEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String symbol;

    @Column(nullable = false)
    private LocalDate date;

    @Column(name = "interval_type", nullable = false)
    private String intervalType;

    @Column(nullable = false)
    private Double open;

    @Column(nullable = false)
    private Double high;

    @Column(nullable = false)
    private Double low;

    @Column(name = "close_price", nullable = false)
    private Double close;

    private Long volume;

    @Column(name = "fetched_at", nullable = false)
    private LocalDateTime fetchedAt;

    public HistoricalDataEntity() {
    }

    public HistoricalDataEntity(String symbol, LocalDate date, String intervalType,
                                 Double open, Double high, Double low, Double close,
                                 Long volume, LocalDateTime fetchedAt) {
        this.symbol = symbol;
        this.date = date;
        this.intervalType = intervalType;
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume;
        this.fetchedAt = fetchedAt;
    }

    public Long getId() { return id; }
    public void setId(Long id) { this.id = id; }

    public String getSymbol() { return symbol; }
    public void setSymbol(String symbol) { this.symbol = symbol; }

    public LocalDate getDate() { return date; }
    public void setDate(LocalDate date) { this.date = date; }

    public String getIntervalType() { return intervalType; }
    public void setIntervalType(String intervalType) { this.intervalType = intervalType; }

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

    public LocalDateTime getFetchedAt() { return fetchedAt; }
    public void setFetchedAt(LocalDateTime fetchedAt) { this.fetchedAt = fetchedAt; }
}
