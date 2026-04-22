"""Volume profile computation for futures (NQ) using OHLCV bar data.

With only 1-minute OHLCV (no tick data), we approximate intra-bar volume
distribution with:
  1. OHLC-weighted split (body vs. wicks) with a dynamic body weight that
     tightens toward marubozu-style bars and loosens on high-wick bars.
  2. Uniform-distribution fallback for extreme moves where OHLC weighting
     has no informational basis (gap-ups, fast sprints > N*ATR).
  3. Gaussian smoothing on the final per-tick grid to mask bucketing artifacts.
"""

from __future__ import annotations

import math
from typing import Dict, List, Union

import numpy as np
import pandas as pd

NQ_TICK_SIZE = 0.25

ProfileDict = Dict[float, float]
ProfileResult = Union[ProfileDict, Dict[str, ProfileDict]]


def calculate_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Wilder-smoothed Average True Range.

    TR = max(H-L, |H - prev_close|, |L - prev_close|), smoothed with an EMA
    of alpha = 1/period (matches Wilder's original recursion).

    The first bar has no previous close, so TR collapses to H-L.
    """
    high = df["high"].astype(float)
    low = df["low"].astype(float)
    close = df["close"].astype(float)
    prev_close = close.shift(1)

    tr = pd.concat(
        [
            high - low,
            (high - prev_close).abs(),
            (low - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)

    if len(tr) > 0:
        tr.iloc[0] = float(high.iloc[0] - low.iloc[0])

    return tr.ewm(alpha=1.0 / period, adjust=False).mean()


def _round_to_tick(price: float, tick_size: float) -> float:
    """Snap a price to the nearest tick grid point."""
    return round(round(price / tick_size) * tick_size, 8)


def _tick_buckets(low: float, high: float, tick_size: float) -> List[float]:
    """All tick-aligned prices in [low, high], inclusive on both ends."""
    lo = _round_to_tick(low, tick_size)
    hi = _round_to_tick(high, tick_size)
    if hi < lo:
        return []
    n = int(round((hi - lo) / tick_size)) + 1
    return [round(lo + i * tick_size, 8) for i in range(n)]


def _add_uniform(
    profile: ProfileDict, low: float, high: float, volume: float, tick_size: float
) -> None:
    """Spread `volume` uniformly across tick buckets in [low, high]."""
    if volume <= 0:
        return
    buckets = _tick_buckets(low, high, tick_size)
    if not buckets:
        return
    share = volume / len(buckets)
    for price in buckets:
        profile[price] = profile.get(price, 0.0) + share


def _distribute_bar(
    profile: ProfileDict,
    o: float,
    h: float,
    l: float,
    c: float,
    volume: float,
    body_weight_base: float,
    bar_atr: float,
    extreme_threshold: float,
    tick_size: float,
) -> None:
    """Distribute a single bar's volume into the running profile."""
    if volume <= 0 or not all(math.isfinite(x) for x in (o, h, l, c, volume)):
        return

    # Snap OHLC to the tick grid so wick/body arithmetic lands exactly on ticks.
    o = _round_to_tick(o, tick_size)
    h = _round_to_tick(h, tick_size)
    l = _round_to_tick(l, tick_size)
    c = _round_to_tick(c, tick_size)

    bar_range = h - l

    # Degenerate / single-tick bar → everything at one bucket.
    if bar_range < tick_size / 2:
        price = _round_to_tick((h + l) / 2.0, tick_size)
        profile[price] = profile.get(price, 0.0) + volume
        return

    # Extreme move: bar range >> typical. OHLC weighting has no basis when
    # price sprints through levels that likely saw no trading at all.
    if bar_atr > 0 and bar_range > extreme_threshold * bar_atr:
        _add_uniform(profile, l, h, volume, tick_size)
        return

    body_low = min(o, c)
    body_high = max(o, c)
    body_size = body_high - body_low

    # Dynamic body weight:
    #   wick_ratio ∈ [0, 1]: fraction of the bar range that is wick
    #     (0 = marubozu, 1 = all wick — impossible unless O=C=H or O=C=L).
    #   At wick_ratio = 0.5 (typical bar), body_weight = body_weight_base.
    #   Tight bar (wick_ratio → 0) → up to 0.8 (body dominates).
    #   Volatile bar (wick_ratio → 1) → down to 0.5 (body and wicks even).
    wick_ratio = (bar_range - body_size) / bar_range
    body_weight = float(
        np.clip(body_weight_base + (0.5 - wick_ratio) * 0.3, 0.5, 0.8)
    )
    wick_weight = 1.0 - body_weight

    body_vol = volume * body_weight
    wick_vol = volume * wick_weight

    # --- Body ---
    if body_size < tick_size / 2:
        # Doji: open ≈ close → body collapses to one tick.
        price = _round_to_tick(body_low, tick_size)
        profile[price] = profile.get(price, 0.0) + body_vol
    else:
        _add_uniform(profile, body_low, body_high, body_vol, tick_size)

    # --- Wicks ---
    upper_wick = h - body_high
    lower_wick = body_low - l
    total_wick = upper_wick + lower_wick

    if total_wick < tick_size / 2:
        # Marubozu: no wicks to distribute into. Fold wick share back into body.
        if body_size < tick_size / 2:
            price = _round_to_tick(body_low, tick_size)
            profile[price] = profile.get(price, 0.0) + wick_vol
        else:
            _add_uniform(profile, body_low, body_high, wick_vol, tick_size)
        return

    # Split wick volume proportionally to wick length. Wicks are the range
    # *above* body_high / *below* body_low — the body bounds themselves are
    # already covered by the body distribution above.
    if upper_wick >= tick_size / 2:
        share = wick_vol * (upper_wick / total_wick)
        _add_uniform(profile, body_high + tick_size, h, share, tick_size)
    if lower_wick >= tick_size / 2:
        share = wick_vol * (lower_wick / total_wick)
        _add_uniform(profile, l, body_low - tick_size, share, tick_size)


def _gaussian_smooth(
    profile: ProfileDict, sigma: float, tick_size: float
) -> ProfileDict:
    """Convolve the profile with a Gaussian kernel on a contiguous tick grid.

    sigma is in tick units, so sigma=1.5 blurs across ~±4 ticks (3σ cutoff).
    Uses edge-padding so mass near the profile's extremes isn't attenuated.
    """
    if not profile or sigma <= 0:
        return dict(profile)

    prices = sorted(profile.keys())
    min_p, max_p = prices[0], prices[-1]
    n = int(round((max_p - min_p) / tick_size)) + 1
    if n <= 1:
        return dict(profile)

    grid = np.zeros(n, dtype=float)
    for p, v in profile.items():
        idx = int(round((p - min_p) / tick_size))
        if 0 <= idx < n:
            grid[idx] = v

    # Normalized Gaussian kernel covering ±3σ.
    half = max(1, int(math.ceil(3.0 * sigma)))
    x = np.arange(-half, half + 1, dtype=float)
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel /= kernel.sum()

    padded = np.pad(grid, half, mode="edge")
    smoothed_grid = np.convolve(padded, kernel, mode="valid")

    out: ProfileDict = {}
    for i, v in enumerate(smoothed_grid):
        if v > 0:
            price = round(min_p + i * tick_size, 8)
            out[price] = float(v)
    return out


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Accept either lowercase or capitalized OHLCV column names (yfinance default)."""
    rename = {}
    for col in df.columns:
        if isinstance(col, str) and col.lower() in {"open", "high", "low", "close", "volume"}:
            rename[col] = col.lower()
    return df.rename(columns=rename) if rename else df


def calculate_volume_profile(
    df: pd.DataFrame,
    tick_size: float = NQ_TICK_SIZE,
    body_weight_base: float = 0.7,
    extreme_move_threshold: float = 3.0,
    atr_period: int = 14,
    smoothing_sigma: float = 1.5,
    return_both: bool = True,
) -> ProfileResult:
    """Compute a volume profile from OHLCV bar data.

    Each bar's volume is distributed across tick-aligned price buckets using
    a dynamic OHLC weighting (body vs. wicks). Bars whose range exceeds
    `extreme_move_threshold * ATR` fall back to uniform distribution.

    Args:
        df: DataFrame with columns ['open', 'high', 'low', 'close', 'volume'].
            Capitalized names (yfinance default) are auto-lowercased.
        tick_size: Minimum price increment. 0.25 for NQ/ES.
        body_weight_base: Baseline fraction of volume assigned to the O-C body.
            Clipped per-bar into [0.5, 0.8] based on wick ratio.
        extreme_move_threshold: Bar range (in ATR multiples) above which the
            bar switches to uniform distribution.
        atr_period: Lookback for Wilder ATR smoothing.
        smoothing_sigma: Gaussian kernel sigma in tick units. 0 disables smoothing.
        return_both: If True, return {'raw', 'smoothed'}. Otherwise just smoothed.

    Returns:
        When return_both=True: {'raw': {price: volume}, 'smoothed': {price: volume}}.
        When return_both=False: {price: volume} (smoothed).
        Prices are tick-aligned and the dict is sorted ascending by price.

    Example:
        >>> import yfinance as yf
        >>> df = yf.download('NQ=F', period='1d', interval='1m')
        >>> result = calculate_volume_profile(df)
        >>> result['smoothed']  # {18450.0: 234.1, 18450.25: 456.7, ...}
    """
    empty: ProfileResult = {"raw": {}, "smoothed": {}} if return_both else {}
    if df is None or len(df) == 0:
        return empty

    df = _normalize_columns(df)
    required = {"open", "high", "low", "close", "volume"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"DataFrame missing required columns: {sorted(missing)}")

    if body_weight_base < 0.5 or body_weight_base > 0.8:
        raise ValueError("body_weight_base must be in [0.5, 0.8]")
    if tick_size <= 0:
        raise ValueError("tick_size must be positive")
    if atr_period < 1:
        raise ValueError("atr_period must be >= 1")

    atr = calculate_atr(df, atr_period)

    raw: ProfileDict = {}
    for i, row in enumerate(df.itertuples(index=False)):
        bar_atr = atr.iloc[i]
        if pd.isna(bar_atr):
            bar_atr = 0.0
        _distribute_bar(
            raw,
            float(row.open),
            float(row.high),
            float(row.low),
            float(row.close),
            float(row.volume),
            body_weight_base=body_weight_base,
            bar_atr=float(bar_atr),
            extreme_threshold=extreme_move_threshold,
            tick_size=tick_size,
        )

    raw = dict(sorted(raw.items()))
    smoothed = _gaussian_smooth(raw, smoothing_sigma, tick_size)

    if return_both:
        return {"raw": raw, "smoothed": smoothed}
    return smoothed
