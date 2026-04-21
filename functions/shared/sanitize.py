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
"""

from typing import Optional


DEFAULT_THRESHOLD_PCT = 0.003  # 0.3% — loose enough to let real market-open
                                # candles through, tight enough to catch the
                                # 0.2%+ phantom wicks we've been seeing.


def sanitize_bar(row: dict, threshold_pct: float = DEFAULT_THRESHOLD_PCT,
                 prev_close: Optional[float] = None) -> dict:
    """Return a copy of `row` with obvious phantom values clamped.

    `row` must have float keys: open, high, low, close. `prev_close`, when
    given, is used as a secondary anchor: if open/low/high deviates from both
    close AND prev_close by more than threshold, it's replaced. This avoids
    clamping legitimate gaps where the whole bar really did move.
    """
    close = row.get('close')
    if close is None or not isinstance(close, (int, float)) or close <= 0:
        return row

    threshold = abs(close) * threshold_pct
    result = dict(row)

    def is_outlier(value: Optional[float]) -> bool:
        if value is None:
            return False
        # Outlier only if it disagrees with BOTH close and prev_close.
        # Using close alone would flag legitimate gap-open bars.
        if abs(value - close) <= threshold:
            return False
        if prev_close is not None and abs(value - prev_close) <= threshold:
            return False
        return True

    open_p = result.get('open')
    low_p = result.get('low')
    high_p = result.get('high')

    if is_outlier(open_p):
        result['open'] = prev_close if prev_close is not None else close

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
