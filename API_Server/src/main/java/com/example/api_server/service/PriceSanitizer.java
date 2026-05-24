package com.example.api_server.service;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Java port of functions/shared/sanitize.py. See that file for the reasoning
 * behind the threshold and the dual-witness approach.
 *
 * Phantom-tick removal for ≤5m OHLC bars: any open/high/low that disagrees
 * with BOTH `close` and a secondary anchor (rolling median of recent cleaned
 * closes, or prev_close) by more than {@link #DEFAULT_THRESHOLD_PCT} of close
 * gets clamped toward the anchor. Keep math aligned with the Python source —
 * any drift produces inconsistencies between bars written before and after
 * the cutover.
 */
public final class PriceSanitizer {

    public static final double DEFAULT_THRESHOLD_PCT = 0.003;

    private PriceSanitizer() {}

    public static final class Bar {
        public double open;
        public double high;
        public double low;
        public double close;

        public Bar(double open, double high, double low, double close) {
            this.open = open;
            this.high = high;
            this.low = low;
            this.close = close;
        }
    }

    public static Bar sanitize(Bar in, Double prevClose, List<Double> recentCloses) {
        return sanitize(in, prevClose, recentCloses, DEFAULT_THRESHOLD_PCT);
    }

    public static Bar sanitize(Bar in, Double prevClose, List<Double> recentCloses, double thresholdPct) {
        double close = in.close;
        if (close <= 0) return in;

        double threshold = Math.abs(close) * thresholdPct;
        Bar out = new Bar(in.open, in.high, in.low, in.close);

        Double secondaryAnchor = null;
        if (recentCloses != null && !recentCloses.isEmpty()) {
            List<Double> clean = new ArrayList<>();
            for (Double c : recentCloses) if (c != null && c > 0) clean.add(c);
            if (!clean.isEmpty()) secondaryAnchor = median(clean);
        }
        if (secondaryAnchor == null) secondaryAnchor = prevClose;

        if (isOutlier(out.open, close, threshold, secondaryAnchor)) {
            out.open = secondaryAnchor != null ? secondaryAnchor : close;
        }

        if (isOutlier(out.low, close, threshold, secondaryAnchor)) {
            out.low = Math.min(out.open, close);
        }
        if (isOutlier(out.high, close, threshold, secondaryAnchor)) {
            out.high = Math.max(out.open, close);
        }

        out.low = Math.min(out.low, Math.min(out.open, out.close));
        out.high = Math.max(out.high, Math.max(out.open, out.close));
        return out;
    }

    private static boolean isOutlier(double value, double close, double threshold, Double secondaryAnchor) {
        if (Math.abs(value - close) <= threshold) return false;
        if (secondaryAnchor != null && Math.abs(value - secondaryAnchor) <= threshold) return false;
        return true;
    }

    private static double median(List<Double> values) {
        List<Double> s = new ArrayList<>(values);
        Collections.sort(s);
        int n = s.size();
        if (n % 2 == 1) return s.get(n / 2);
        return (s.get(n / 2 - 1) + s.get(n / 2)) / 2.0;
    }
}
