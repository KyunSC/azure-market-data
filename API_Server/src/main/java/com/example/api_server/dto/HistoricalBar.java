package com.example.api_server.dto;

import java.time.LocalDateTime;

/**
 * Trimmed projection over {@code historical_data}. Pulls only the columns the
 * read path actually uses (date + OHLCV), skipping {@code id}, {@code symbol},
 * {@code interval_type}, and {@code fetched_at}. Cuts Supabase egress per row
 * by ~30–40% versus hydrating the full {@code HistoricalDataEntity}.
 */
public record HistoricalBar(
        LocalDateTime date,
        Double open,
        Double high,
        Double low,
        Double close,
        Long volume
) {}
