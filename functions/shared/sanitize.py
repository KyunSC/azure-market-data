"""Price sanitization for yfinance-sourced OHLC bars.

yfinance's intraday feed occasionally emits a phantom tick — most often as an
`open` that matches a flash quote from a different moment, producing a bar
with a 50–100 point range on NQ when the close-to-close movement is only a
few points. Those bars render as tall spurious wicks on the chart.

We anchor repairs on `close`. The close is the latest datapoint in the bucket
and is the value that stitches cleanly onto the next bar's open, so it's the
most trustworthy field. Any other OHLC field that deviates more than
`threshold_pct` from close is almost certainly a bad tick — we clamp it toward
close rather than drop the bar entirely.

A second witness (prev_close, or — preferred — the median of a recent-closes
window) is required before we flag a value as an outlier. This avoids
clamping legitimate gap-opens where the whole bar really moved. Using a
median window instead of a single prior close makes the witness robust to
one dirty neighbor: the previous failure mode where a phantom bar followed
by another phantom bar slipped through is no longer reachable as long as
the window has more clean bars than dirty ones.
"""

from typing import Iterable, Optional


DEFAULT_THRESHOLD_PCT = 0.003  # 0.3% — loose enough to let real market-open
                                # candles through, tight enough to catch the
                                # 0.2%+ phantom wicks we've been seeing.


def _median(values):
    s = sorted(values)
    n = len(s)
    if n == 0:
        return None
    if n % 2 == 1:
        return s[n // 2]
    return (s[n // 2 - 1] + s[n // 2]) / 2.0


def sanitize_bar(row: dict, threshold_pct: float = DEFAULT_THRESHOLD_PCT,
                 prev_close: Optional[float] = None,
                 recent_closes: Optional[Iterable[float]] = None) -> dict:
    """Return a copy of `row` with obvious phantom values clamped.

    `row` must have float keys: open, high, low, close.

    `recent_closes`, when given, is a window of nearby clean close prices
    (caller decides what to include — typically the prior N bars). The median
    of that window is used as the secondary witness, replacing prev_close.
    Median is used because it ignores one bad neighbor; mean would be poisoned
    by it.

    `prev_close` is the legacy single-witness fallback when no window is
    provided. It is also used if recent_closes is empty.
    """
    close = row.get('close')
    if close is None or not isinstance(close, (int, float)) or close <= 0:
        return row

    threshold = abs(close) * threshold_pct
    result = dict(row)

    secondary_anchor: Optional[float] = None
    if recent_closes is not None:
        clean_window = [c for c in recent_closes
                        if isinstance(c, (int, float)) and c > 0]
        if clean_window:
            secondary_anchor = _median(clean_window)
    if secondary_anchor is None:
        secondary_anchor = prev_close

    def is_outlier(value: Optional[float]) -> bool:
        if value is None:
            return False
        # Outlier only if it disagrees with BOTH close and the secondary
        # witness. Using close alone would flag legitimate gap-open bars.
        if abs(value - close) <= threshold:
            return False
        if secondary_anchor is not None and abs(value - secondary_anchor) <= threshold:
            return False
        return True

    open_p = result.get('open')
    low_p = result.get('low')
    high_p = result.get('high')

    if is_outlier(open_p):
        result['open'] = secondary_anchor if secondary_anchor is not None else close

    # After open is fixed, re-derive low/high bounds if they're phantom.
    if is_outlier(low_p):
        result['low'] = min(result['open'], close)

    if is_outlier(high_p):
        result['high'] = max(result['open'], close)

    # Enforce invariants regardless — guards against residual inconsistency
    # after clamping, and against inputs that already violated them.
    result['low'] = min(result['low'], result['open'], result['close'])
    result['high'] = max(result['high'], result['open'], result['close'])

    return result
