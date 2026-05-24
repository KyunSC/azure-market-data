package com.example.api_server.service;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Java port of functions/GEXCalculator/gex_calculator.py.
 *
 * Fetches the option chain from Yahoo, applies Black-Scholes per strike, and
 * returns the aggregated levels (call wall / put wall / zero-gamma flip /
 * significant strikes) plus option-flow metrics (PCR + IV stats).
 *
 * Keep math + constants aligned with the Python source — the gamma_exposure
 * and gamma_levels rows feed the ML pipeline and any drift between writers
 * would corrupt the time series.
 */
@Service
public class GammaExposureComputeService {

    private static final double RISK_FREE_RATE = 0.05;
    private static final int MAX_EXPIRATIONS = 4;
    private static final int MAX_DAYS_OUT = 30;
    private static final double MIN_T_YEARS = 1.0 / 365.0;
    private static final double MIN_IV = 0.01;
    private static final Duration FETCH_TIMEOUT = Duration.ofSeconds(10);
    private static final ZoneId ET_ZONE = ZoneId.of("America/New_York");
    private static final DateTimeFormatter EXP_FMT = DateTimeFormatter.ISO_LOCAL_DATE;

    /** ETF → futures pair definitions. Mirror of GEX_PAIRS in the Python source. */
    public static final Map<String, String> GEX_PAIRS;
    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put("QQQ", "NQ=F");
        m.put("SPY", "ES=F");
        m.put("IWM", "RTY=F");
        m.put("DIA", "YM=F");
        GEX_PAIRS = Collections.unmodifiableMap(m);
    }

    private final WebClient webClient;

    public GammaExposureComputeService(WebClient webClient) {
        this.webClient = webClient;
    }

    public static boolean isMarketOpen() {
        ZonedDateTime nowEt = ZonedDateTime.now(ET_ZONE);
        int dow = nowEt.getDayOfWeek().getValue();
        if (dow >= 6) return false;
        int hour = nowEt.getHour();
        int minute = nowEt.getMinute();
        boolean afterOpen = hour > 9 || (hour == 9 && minute >= 30);
        boolean beforeClose = hour < 16;
        return afterOpen && beforeClose;
    }

    public GexResult fetchAndCompute(String etfSymbol) {
        String futuresSymbol = GEX_PAIRS.get(etfSymbol);
        if (futuresSymbol == null) {
            throw new IllegalArgumentException("Unsupported ETF symbol: " + etfSymbol);
        }

        double etfPrice = fetchLastPrice(etfSymbol);
        double futuresPrice = fetchLastPrice(futuresSymbol);
        if (etfPrice <= 0 || futuresPrice <= 0) {
            throw new IllegalStateException(
                    "Invalid prices: " + etfSymbol + "=" + etfPrice + ", " + futuresSymbol + "=" + futuresPrice);
        }

        OptionsChainSummary summary = fetchExpirationsAndFirstChain(etfSymbol);
        if (summary.expirations.isEmpty()) {
            throw new IllegalStateException("No option expirations available for " + etfSymbol);
        }

        LocalDate today = LocalDate.now(ET_ZONE);
        List<ExpirationData> selected = new ArrayList<>();
        for (long epoch : summary.expirations) {
            LocalDate expDate = LocalDate.ofEpochDay(epoch / 86400L);
            long daysOut = expDate.toEpochDay() - today.toEpochDay();
            if (daysOut < 0 || daysOut > MAX_DAYS_OUT) {
                continue;
            }
            ExpirationData ed = (selected.isEmpty() && summary.firstChain != null
                    && epoch == summary.firstExpiration)
                    ? new ExpirationData(epoch, expDate, (int) daysOut, summary.firstChain)
                    : new ExpirationData(epoch, expDate, (int) daysOut, fetchChain(etfSymbol, epoch));
            selected.add(ed);
            if (selected.size() >= MAX_EXPIRATIONS) {
                break;
            }
        }

        if (selected.isEmpty()) {
            throw new IllegalStateException("No option expirations within " + MAX_DAYS_OUT + " days for " + etfSymbol);
        }

        return computeGex(etfSymbol, futuresSymbol, etfPrice, futuresPrice, selected);
    }

    // --- Math ---

    private GexResult computeGex(String etfSymbol, String futuresSymbol,
                                 double etfPrice, double futuresPrice,
                                 List<ExpirationData> expirations) {
        double conversionRatio = futuresPrice / etfPrice;

        Map<Double, StrikeAccumulator> byStrike = new TreeMap<>();
        Map<Double, List<Double>> ivCall = new HashMap<>();
        Map<Double, List<Double>> ivPut = new HashMap<>();
        double totalCallVolume = 0.0;
        double totalPutVolume = 0.0;
        double totalCallOi = 0.0;
        double totalPutOi = 0.0;
        List<String> expirationStrings = new ArrayList<>();

        for (ExpirationData exp : expirations) {
            expirationStrings.add(exp.expDate.format(EXP_FMT));
            double t = Math.max(exp.daysOut / 365.0, MIN_T_YEARS);
            String dteBucket = dteKey(exp.daysOut);

            for (OptionContract c : exp.chain.calls) {
                if (c.iv >= MIN_IV) {
                    ivCall.computeIfAbsent(c.strike, k -> new ArrayList<>()).add(c.iv);
                }
                totalCallVolume += c.volume;
                totalCallOi += c.openInterest;
                if (c.openInterest <= 0 || c.iv < MIN_IV) continue;
                double gamma = blackScholesGamma(etfPrice, c.strike, t, RISK_FREE_RATE, c.iv);
                double gexCall = gamma * c.openInterest * 100.0 * etfPrice;
                StrikeAccumulator rec = byStrike.computeIfAbsent(c.strike, k -> new StrikeAccumulator());
                rec.gexCall += gexCall;
                rec.add(dteBucket, gexCall);
            }

            for (OptionContract p : exp.chain.puts) {
                if (p.iv >= MIN_IV) {
                    ivPut.computeIfAbsent(p.strike, k -> new ArrayList<>()).add(p.iv);
                }
                totalPutVolume += p.volume;
                totalPutOi += p.openInterest;
                if (p.openInterest <= 0 || p.iv < MIN_IV) continue;
                double gamma = blackScholesGamma(etfPrice, p.strike, t, RISK_FREE_RATE, p.iv);
                // Puts contribute negatively to dealer gamma exposure.
                double gexPut = -1.0 * gamma * p.openInterest * 100.0 * etfPrice;
                StrikeAccumulator rec = byStrike.computeIfAbsent(p.strike, k -> new StrikeAccumulator());
                rec.gexPut += gexPut;
                rec.add(dteBucket, gexPut);
            }
        }

        if (byStrike.isEmpty()) {
            throw new IllegalStateException("No valid option data found for " + etfSymbol);
        }

        double pcrVolume = round4(totalPutVolume / Math.max(totalCallVolume, 1.0));
        double pcrOi = round4(totalPutOi / Math.max(totalCallOi, 1.0));

        Double ivAtm = null;
        List<Double> bothSidesStrikes = new ArrayList<>();
        for (Double k : ivCall.keySet()) {
            if (ivPut.containsKey(k)) bothSidesStrikes.add(k);
        }
        if (!bothSidesStrikes.isEmpty()) {
            double atmStrike = bothSidesStrikes.get(0);
            double bestDist = Math.abs(atmStrike - etfPrice);
            for (Double k : bothSidesStrikes) {
                double d = Math.abs(k - etfPrice);
                if (d < bestDist) {
                    bestDist = d;
                    atmStrike = k;
                }
            }
            double callIvAtm = mean(ivCall.get(atmStrike));
            double putIvAtm = mean(ivPut.get(atmStrike));
            ivAtm = round4((callIvAtm + putIvAtm) / 2.0);
        }

        // IV skew: mean OTM-put IV (90-97% of spot) minus mean OTM-call IV (103-110% of spot).
        List<Double> otmPutIvs = new ArrayList<>();
        for (Map.Entry<Double, List<Double>> e : ivPut.entrySet()) {
            double k = e.getKey();
            if (k >= 0.90 * etfPrice && k <= 0.97 * etfPrice) otmPutIvs.addAll(e.getValue());
        }
        List<Double> otmCallIvs = new ArrayList<>();
        for (Map.Entry<Double, List<Double>> e : ivCall.entrySet()) {
            double k = e.getKey();
            if (k >= 1.03 * etfPrice && k <= 1.10 * etfPrice) otmCallIvs.addAll(e.getValue());
        }
        Double ivSkew = (!otmPutIvs.isEmpty() && !otmCallIvs.isEmpty())
                ? round4(mean(otmPutIvs) - mean(otmCallIvs))
                : null;

        List<StrikeData> allStrikes = new ArrayList<>(byStrike.size());
        for (Map.Entry<Double, StrikeAccumulator> e : byStrike.entrySet()) {
            StrikeAccumulator a = e.getValue();
            double totalGex = a.gexCall + a.gexPut;
            allStrikes.add(new StrikeData(
                    round2(e.getKey()),
                    round2(e.getKey() * conversionRatio),
                    round2(totalGex),
                    round2(a.gexCall),
                    round2(a.gexPut),
                    round2(a.gex0dte),
                    round2(a.gex1dte),
                    round2(a.gexWeekly),
                    round2(a.gexMonthly),
                    null
            ));
        }

        List<StrikeData> levels = identifyKeyLevels(allStrikes);

        return new GexResult(
                etfSymbol,
                futuresSymbol,
                round2(etfPrice),
                round2(futuresPrice),
                round4(conversionRatio),
                expirationStrings,
                isMarketOpen(),
                pcrVolume,
                pcrOi,
                ivAtm,
                ivSkew,
                levels
        );
    }

    private static double blackScholesGamma(double s, double k, double t, double r, double sigma) {
        if (t <= 0 || sigma <= 0 || s <= 0 || k <= 0) return 0.0;
        double d1 = (Math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / (sigma * Math.sqrt(t));
        return normPdf(d1) / (s * sigma * Math.sqrt(t));
    }

    private static double normPdf(double x) {
        return Math.exp(-0.5 * x * x) / Math.sqrt(2.0 * Math.PI);
    }

    private static String dteKey(int daysOut) {
        if (daysOut <= 0) return "gex_0dte";
        if (daysOut == 1) return "gex_1dte";
        if (daysOut <= 7) return "gex_weekly";
        return "gex_monthly";
    }

    private List<StrikeData> identifyKeyLevels(List<StrikeData> strikes) {
        List<StrikeData> levels = new ArrayList<>();
        if (strikes.isEmpty()) return levels;

        StrikeData callWall = null;
        for (StrikeData s : strikes) {
            if (s.gex() > 0 && (callWall == null || s.gex() > callWall.gex())) callWall = s;
        }
        if (callWall != null) levels.add(callWall.withLabel("call_wall"));

        StrikeData putWall = null;
        for (StrikeData s : strikes) {
            if (s.gex() < 0 && (putWall == null || s.gex() < putWall.gex())) putWall = s;
        }
        if (putWall != null) levels.add(putWall.withLabel("put_wall"));

        // Gamma flip: where cumulative GEX crosses zero. Linear-interpolate the
        // crossing point between the two strikes that straddle it.
        double cumulative = 0;
        Double prevCumulative = null;
        StrikeData prevStrike = null;
        for (StrikeData s : strikes) {
            cumulative += s.gex();
            if (prevCumulative != null && prevCumulative * cumulative < 0 && prevStrike != null) {
                double weight = Math.abs(prevCumulative) / (Math.abs(prevCumulative) + Math.abs(cumulative));
                double flipEtf = prevStrike.strikeEtf() + weight * (s.strikeEtf() - prevStrike.strikeEtf());
                double flipFutures = prevStrike.strikeFutures()
                        + weight * (s.strikeFutures() - prevStrike.strikeFutures());
                levels.add(new StrikeData(round2(flipEtf), round2(flipFutures),
                        0, 0, 0, 0, 0, 0, 0, "zero_gamma"));
                break;
            }
            prevCumulative = cumulative;
            prevStrike = s;
        }

        Double callWallStrike = callWall != null ? callWall.strikeEtf() : null;
        Double putWallStrike = putWall != null ? putWall.strikeEtf() : null;

        List<StrikeData> sigPositive = new ArrayList<>();
        for (StrikeData s : strikes) {
            if (s.gex() > 0 && (callWallStrike == null || s.strikeEtf() != callWallStrike.doubleValue())) {
                sigPositive.add(s);
            }
        }
        sigPositive.sort((a, b) -> Double.compare(b.gex(), a.gex()));
        for (int i = 0; i < Math.min(3, sigPositive.size()); i++) {
            levels.add(sigPositive.get(i).withLabel("significant_pos"));
        }

        List<StrikeData> sigNegative = new ArrayList<>();
        for (StrikeData s : strikes) {
            if (s.gex() < 0 && (putWallStrike == null || s.strikeEtf() != putWallStrike.doubleValue())) {
                sigNegative.add(s);
            }
        }
        sigNegative.sort((a, b) -> Double.compare(a.gex(), b.gex()));
        for (int i = 0; i < Math.min(3, sigNegative.size()); i++) {
            levels.add(sigNegative.get(i).withLabel("significant_neg"));
        }

        return levels;
    }

    // --- Yahoo fetch ---

    private double fetchLastPrice(String symbol) {
        Map<String, Object> body = webClient.get()
                .uri(uri -> uri
                        .path("/v8/finance/chart/{symbol}")
                        .queryParam("interval", "1d")
                        .queryParam("range", "1d")
                        .build(symbol))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(FETCH_TIMEOUT)
                .block();
        Map<String, Object> meta = unwrap(body, "chart", "result", "meta");
        if (meta == null) return -1;
        Object price = meta.get("regularMarketPrice");
        return price instanceof Number n ? n.doubleValue() : -1;
    }

    @SuppressWarnings("unchecked")
    private OptionsChainSummary fetchExpirationsAndFirstChain(String symbol) {
        Map<String, Object> body = webClient.get()
                .uri(uri -> uri.path("/v7/finance/options/{symbol}").build(symbol))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(FETCH_TIMEOUT)
                .block();
        Map<String, Object> result = firstResult(body);
        if (result == null) return new OptionsChainSummary(List.of(), 0, null);

        List<Long> expirations = new ArrayList<>();
        Object expArr = result.get("expirationDates");
        if (expArr instanceof List<?> list) {
            for (Object o : list) if (o instanceof Number n) expirations.add(n.longValue());
        }

        // The same response includes the first expiration's chain — reuse it
        // instead of refetching to save one HTTP round trip per symbol.
        OptionChain firstChain = null;
        long firstExp = 0;
        Object opts = result.get("options");
        if (opts instanceof List<?> optList && !optList.isEmpty()
                && optList.get(0) instanceof Map<?, ?> first) {
            Object expDate = ((Map<String, Object>) first).get("expirationDate");
            if (expDate instanceof Number n) firstExp = n.longValue();
            firstChain = parseChain((Map<String, Object>) first);
        }

        return new OptionsChainSummary(expirations, firstExp, firstChain);
    }

    @SuppressWarnings("unchecked")
    private OptionChain fetchChain(String symbol, long expirationEpoch) {
        Map<String, Object> body = webClient.get()
                .uri(uri -> uri
                        .path("/v7/finance/options/{symbol}")
                        .queryParam("date", expirationEpoch)
                        .build(symbol))
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .timeout(FETCH_TIMEOUT)
                .block();
        Map<String, Object> result = firstResult(body);
        if (result == null) return new OptionChain(List.of(), List.of());
        Object opts = result.get("options");
        if (!(opts instanceof List<?> list) || list.isEmpty()
                || !(list.get(0) instanceof Map<?, ?> first)) {
            return new OptionChain(List.of(), List.of());
        }
        return parseChain((Map<String, Object>) first);
    }

    @SuppressWarnings("unchecked")
    private static OptionChain parseChain(Map<String, Object> options) {
        List<OptionContract> calls = parseContracts((List<Map<String, Object>>) options.get("calls"));
        List<OptionContract> puts = parseContracts((List<Map<String, Object>>) options.get("puts"));
        return new OptionChain(calls, puts);
    }

    private static List<OptionContract> parseContracts(List<Map<String, Object>> raw) {
        if (raw == null) return List.of();
        List<OptionContract> out = new ArrayList<>(raw.size());
        for (Map<String, Object> r : raw) {
            double strike = doubleOf(r.get("strike"), 0);
            double iv = doubleOf(r.get("impliedVolatility"), 0);
            long oi = longOf(r.get("openInterest"), 0);
            long vol = longOf(r.get("volume"), 0);
            if (strike <= 0) continue;
            out.add(new OptionContract(strike, iv, oi, vol));
        }
        return out;
    }

    // --- helpers ---

    @SuppressWarnings("unchecked")
    private static Map<String, Object> firstResult(Map<String, Object> body) {
        if (body == null) return null;
        Object chain = body.get("optionChain");
        if (!(chain instanceof Map<?, ?> chainMap)) return null;
        Object result = ((Map<String, Object>) chainMap).get("result");
        if (!(result instanceof List<?> list) || list.isEmpty()) return null;
        Object first = list.get(0);
        return first instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> unwrap(Map<String, Object> body, String... path) {
        Object cur = body;
        for (String key : path) {
            if (cur instanceof Map<?, ?> m) {
                cur = ((Map<String, Object>) m).get(key);
            } else if (cur instanceof List<?> list && !list.isEmpty()) {
                cur = list.get(0);
                if (cur instanceof Map<?, ?> m) {
                    cur = ((Map<String, Object>) m).get(key);
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }
        return cur instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    private static double doubleOf(Object o, double fallback) {
        if (o instanceof Number n) {
            double v = n.doubleValue();
            return Double.isNaN(v) || Double.isInfinite(v) ? fallback : v;
        }
        return fallback;
    }

    private static long longOf(Object o, long fallback) {
        if (o instanceof Number n) {
            double v = n.doubleValue();
            return Double.isNaN(v) || Double.isInfinite(v) ? fallback : (long) v;
        }
        return fallback;
    }

    private static double mean(List<Double> xs) {
        double sum = 0;
        for (double x : xs) sum += x;
        return xs.isEmpty() ? 0 : sum / xs.size();
    }

    private static double round2(double v) { return Math.round(v * 100.0) / 100.0; }
    private static double round4(double v) { return Math.round(v * 10000.0) / 10000.0; }

    // --- internal types ---

    private static final class StrikeAccumulator {
        double gexCall, gexPut;
        double gex0dte, gex1dte, gexWeekly, gexMonthly;
        void add(String bucket, double v) {
            switch (bucket) {
                case "gex_0dte" -> gex0dte += v;
                case "gex_1dte" -> gex1dte += v;
                case "gex_weekly" -> gexWeekly += v;
                default -> gexMonthly += v;
            }
        }
    }

    private record OptionContract(double strike, double iv, long openInterest, long volume) {}
    private record OptionChain(List<OptionContract> calls, List<OptionContract> puts) {}
    private record OptionsChainSummary(List<Long> expirations, long firstExpiration, OptionChain firstChain) {}
    private record ExpirationData(long epoch, LocalDate expDate, int daysOut, OptionChain chain) {}

    // --- public result records ---

    public record GexResult(
            String etfSymbol,
            String futuresSymbol,
            double etfPrice,
            double futuresPrice,
            double conversionRatio,
            List<String> expirationsUsed,
            boolean marketOpen,
            Double pcrVolume,
            Double pcrOi,
            Double ivAtm,
            Double ivSkew,
            List<StrikeData> levels
    ) {}

    public record StrikeData(
            double strikeEtf,
            double strikeFutures,
            double gex,
            double gexCall,
            double gexPut,
            double gex0dte,
            double gex1dte,
            double gexWeekly,
            double gexMonthly,
            String label
    ) {
        StrikeData withLabel(String newLabel) {
            return new StrikeData(strikeEtf, strikeFutures, gex, gexCall, gexPut,
                    gex0dte, gex1dte, gexWeekly, gexMonthly, newLabel);
        }
    }
}
