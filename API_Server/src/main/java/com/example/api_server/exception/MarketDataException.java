package com.example.api_server.exception;

public class MarketDataException extends RuntimeException {

    private final int statusCode;

    public MarketDataException(String message) {
        super(message);
        this.statusCode = 500;
    }

    public MarketDataException(String message, int statusCode) {
        super(message);
        this.statusCode = statusCode;
    }

    public MarketDataException(String message, Throwable cause) {
        super(message, cause);
        this.statusCode = 500;
    }

    public int getStatusCode() {
        return statusCode;
    }
}
