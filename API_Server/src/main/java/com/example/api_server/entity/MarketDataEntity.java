package com.example.api_server.entity;

import jakarta.persistence.*;
import java.time.LocalDateTime;

@Entity
@Table(name = "market_data")
public class MarketDataEntity {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private String symbol;

    private Double price;

    private Long volume;

    @Column(nullable = false)
    private LocalDateTime timestamp;

    public MarketDataEntity() {
    }

    public MarketDataEntity(String symbol, Double price, Long volume, LocalDateTime timestamp) {
        this.symbol = symbol;
        this.price = price;
        this.volume = volume;
        this.timestamp = timestamp;
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

    public Double getPrice() {
        return price;
    }

    public void setPrice(Double price) {
        this.price = price;
    }

    public Long getVolume() {
        return volume;
    }

    public void setVolume(Long volume) {
        this.volume = volume;
    }

    public LocalDateTime getTimestamp() {
        return timestamp;
    }

    public void setTimestamp(LocalDateTime timestamp) {
        this.timestamp = timestamp;
    }
}
