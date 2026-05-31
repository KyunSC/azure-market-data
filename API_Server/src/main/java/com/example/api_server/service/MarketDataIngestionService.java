package com.example.api_server.service;

import com.example.api_server.repository.supabase.SupabaseHistoricalDataRepository;
import com.example.api_server.repository.supabase.SupabaseMarketDataRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Java port of functions/ScheduledDataIngestion/__init__.py — the half that
 * handles the "extra" tickers Azure no longer ingests (IWM, RTY=F, DIA, YM=F
 * by default).
 *
 * Fetches prices and intraday OHLC from Yahoo's chart endpoint, runs the
 * ≤5m bars through {@link PriceSanitizer}, and upserts into the same
 * {@code market_data} and {@code historical_data} tables the Python writer
 * uses. Two writers touching the same tables is safe — the unique key
 * (symbol, date, interval_type) on historical_data is the contract.
 */
@Service
public class MarketDataIngestionService {

    private static final Logger logger = LoggerFactory.getLogger(MarketDataIngestionService.class);

    private static final Set<String> SANITIZE_INTERVALS = Set.of("1m", "2m", "5m");
    private static final int SANITIZE_WINDOW = 5;
    private static final Duration FETCH_TIMEOUT = Duration.ofSeconds(10);

    private final WebClient webClient;
    private final SupabaseMarketDataRepository marketRepo;
    private final SupabaseHistoricalDataRepository historicalRepo;

    public MarketDataIngestionService(WebClient webClient,
                                      SupabaseMarketDataRepository marketRepo,
                                      SupabaseHistoricalDataRepository historicalRepo) {
        this.webClient = webClient;
        this.marketRepo = marketRepo;
        this.historicalRepo = historicalRepo;
    }

    /**
     * Fetch last price + volume per ticker and upsert into {@code market_data}.
     * One row per symbol — the snapshot is replaced in place each tick.
     *
     * @param isMarketHours when false, equity tickers (no =F suffix) are skipped.
     *                      Matches the Python gating: futures trade nearly 24/5,
     *                      equities only during RTH.
     */
    public void ingestPrices(List<String> tickers, boolean isMarketHours) {
        LocalDateTime now = LocalDateTime.now(ZoneOffset.UTC);
        int saved = 0;
        for (String symbol : tickers) {
            if (!symbol.endsWith("=F") && !isMarketHours) continue;
            try {
                LastTick tick = fetchLastTick(symbol);
                if (tick.price <= 0) {
                    logger.warn("No valid price for {}", symbol);
                    continue;
                }
                marketRepo.upsertSnapshot(symbol, tick.price, tick.volume, now);
                saved++;
                logger.info("Saved {}: ${}", symbol, tick.price);
            } catch (Exception ex) {
                logger.error("Error fetching {}: {}", symbol, ex.getMessage());
            }
        }
        logger.info("Market data: {}/{} tickers saved", saved, tickers.size());
    }

    /**
     * Fetch 1m/5m/1h bars per ticker and upsert into {@code historical_data}.
     * Bars ≤5m run through the phantom-tick sanitizer.
     */
    public void ingestIntraday(List<String> tickers, boolean isMarketHours) {
        // Futures always; equities only during the equity session — matches Python.
        List<String> active = new ArrayList<>();
        for (String s : tickers) {
            if (s.endsWith("=F") || isMarketHours) active.add(s);
        }
        if (active.isEmpty()) {
            logger.info("Intraday: no active symbols (market closed and no futures)");
            return;
        }

        List<String[]> intervals = List.of(
                new String[]{"1m", "1d"},
                new String[]{"5m", "1d"},
                new String[]{"1h", "5d"}
        );

        for (String[] iv : intervals) {
            String interval = iv[0];
            String range = iv[1];
            for (String symbol : active) {
                try {
                    List<OhlcBar> bars = fetchBars(symbol, interval, range, true);
                    if (bars.isEmpty()) {
                        logger.warn("No {} data for {}", interval, symbol);
                        continue;
                    }
                    upsertBars(symbol, interval, bars);
                    logger.info("Saved {} rows of {} data for {}", bars.size(), interval, symbol);
                } catch (Exception ex) {
                    logger.error("Error fetching {} for {}: {}", interval, symbol, ex.getMessage());
                }
            }
        }
    }

    /**
     * Fetch 1d bars (5-day lookback) per ticker and upsert. Called once per
     * day around the RTH close so the daily candle stamps as final.
     */
    public void ingestDaily(List<String> tickers) {
        for (String symbol : tickers) {
            try {
                List<OhlcBar> bars = fetchBars(symbol, "1d", "5d", false);
                if (bars.isEmpty()) {
                    logger.warn("No daily data for {}", symbol);
                    continue;
                }
                upsertBars(symbol, "1d", bars);
                logger.info("Saved daily data for {}", symbol);
            } catch (Exception ex) {
                logger.error("Error fetching daily for {}: {}", symbol, ex.getMessage());
            }
        }
    }

    // --- internals ---

    private void upsertBars(String symbol, String interval, List<OhlcBar> bars) {
        LocalDateTime fetchedAt = LocalDateTime.now(ZoneOffset.UTC);
        boolean shouldSanitize = SANITIZE_INTERVALS.contains(interval);
        List<Double> recentCloses = new ArrayList<>();
        Double prevClose = null;
        for (OhlcBar bar : bars) {
            PriceSanitizer.Bar clean = shouldSanitize
                    ? PriceSanitizer.sanitize(
                            new PriceSanitizer.Bar(bar.open, bar.high, bar.low, bar.close),
                            prevClose, recentCloses)
                    : new PriceSanitizer.Bar(bar.open, bar.high, bar.low, bar.close);

            if (shouldSanitize && (clean.open != bar.open || clean.high != bar.high || clean.low != bar.low)) {
                logger.warn("Sanitized phantom tick for {} {} @ {}: O {}→{}, H {}→{}, L {}→{}",
                        symbol, interval, bar.timestamp,
                        bar.open, clean.open, bar.high, clean.high, bar.low, clean.low);
            }

            historicalRepo.upsertBar(
                    symbol,
                    bar.timestamp,
                    interval,
                    round2(clean.open),
                    round2(clean.high),
                    round2(clean.low),
                    round2(clean.close),
                    bar.volume,
                    fetchedAt);

            prevClose = clean.close;
            recentCloses.add(clean.close);
            if (recentCloses.size() > SANITIZE_WINDOW) {
                recentCloses.remove(0);
            }
        }
    }

    // --- Yahoo fetch ---

    private LastTick fetchLastTick(String symbol) {
        Map<String, Object> body = chartCall(symbol, "1d", "1d");
        Map<String, Object> meta = unwrap(body, "chart", "result", "meta");
        if (meta == null) return new LastTick(-1, null);
        Object price = meta.get("regularMarketPrice");
        Object volume = meta.get("regularMarketVolume");
        return new LastTick(
                price instanceof Number n ? n.doubleValue() : -1,
                volume instanceof Number v ? v.longValue() : null);
    }

    private List<OhlcBar> fetchBars(String symbol, String interval, String range, boolean intraday) {
        Map<String, Object> body = chartCall(symbol, interval, range);
        return parseBars(body, intraday);
    }

    private Map<String, Object> chartCall(String symbol, String interval, String range) {
        return webClient.get()
                .uri(uri -> uri
                        .path("/v8/finance/chart/{symbol}")
                        .queryParam("interval", interval)
                        .queryParam("range", range)
                        .build(symbol))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(FETCH_TIMEOUT)
                .block();
    }

    private static List<OhlcBar> parseBars(Map<String, Object> body, boolean intraday) {
        List<OhlcBar> bars = new ArrayList<>();
        if (body == null) return bars;
        Object chart = body.get("chart");
        if (!(chart instanceof Map<?, ?> cm)) return bars;
        Object resultList = cm.get("result");
        if (!(resultList instanceof List<?> results) || results.isEmpty()) return bars;
        Object first = results.get(0);
        if (!(first instanceof Map<?, ?> firstMap)) return bars;

        Object tsRaw = firstMap.get("timestamp");
        if (!(tsRaw instanceof List<?> timestamps)) return bars;

        Object indicators = firstMap.get("indicators");
        if (!(indicators instanceof Map<?, ?> indMap)) return bars;
        Object quoteList = indMap.get("quote");
        if (!(quoteList instanceof List<?> qList) || qList.isEmpty()) return bars;
        Object quoteFirst = qList.get(0);
        if (!(quoteFirst instanceof Map<?, ?> quote)) return bars;

        List<?> opens = asList(quote.get("open"));
        List<?> highs = asList(quote.get("high"));
        List<?> lows = asList(quote.get("low"));
        List<?> closes = asList(quote.get("close"));
        List<?> volumes = asList(quote.get("volume"));

        // Yahoo can return nulls for empty buckets (e.g. pre-market gaps in
        // intraday bars where no trades printed). Skip those — the Python
        // code does the same via pd.DataFrame iteration which already drops
        // NaN rows for numeric coercion in our pipeline.
        Set<Long> seen = new LinkedHashSet<>();
        for (int i = 0; i < timestamps.size(); i++) {
            Long ts = readLong(timestamps.get(i));
            if (ts == null) continue;
            Double open = readDouble(get(opens, i));
            Double high = readDouble(get(highs, i));
            Double low = readDouble(get(lows, i));
            Double close = readDouble(get(closes, i));
            Long volume = readLong(get(volumes, i));
            if (open == null || high == null || low == null || close == null) continue;
            if (!seen.add(ts)) continue;

            LocalDateTime barTime = intraday
                    ? LocalDateTime.ofInstant(Instant.ofEpochSecond(ts), ZoneOffset.UTC)
                    : LocalDateTime.ofInstant(Instant.ofEpochSecond(ts), ZoneOffset.UTC)
                            .toLocalDate().atStartOfDay();
            bars.add(new OhlcBar(barTime, open, high, low, close, volume == null ? 0 : volume));
        }
        return bars;
    }

    private static Map<String, Object> unwrap(Map<String, Object> body, String... path) {
        Object cur = body;
        for (String key : path) {
            if (cur instanceof Map<?, ?> m) {
                cur = ((Map<?, ?>) m).get(key);
            } else if (cur instanceof List<?> list && !list.isEmpty()) {
                cur = list.get(0);
                if (cur instanceof Map<?, ?> m) cur = ((Map<?, ?>) m).get(key);
                else return null;
            } else {
                return null;
            }
        }
        if (cur instanceof Map<?, ?> m) {
            @SuppressWarnings("unchecked")
            Map<String, Object> out = (Map<String, Object>) m;
            return out;
        }
        return null;
    }

    private static List<?> asList(Object o) { return o instanceof List<?> l ? l : List.of(); }
    private static Object get(List<?> l, int i) { return i < l.size() ? l.get(i) : null; }
    private static Double readDouble(Object v) {
        if (!(v instanceof Number n)) return null;
        double d = n.doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? null : d;
    }
    private static Long readLong(Object v) {
        if (!(v instanceof Number n)) return null;
        double d = n.doubleValue();
        return Double.isNaN(d) || Double.isInfinite(d) ? null : (long) d;
    }
    private static double round2(double v) { return Math.round(v * 100.0) / 100.0; }

    private record OhlcBar(LocalDateTime timestamp, double open, double high,
                           double low, double close, long volume) {}
    private record LastTick(double price, Long volume) {}
}
