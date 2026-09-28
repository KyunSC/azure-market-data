"""Vectorized Black-Scholes price and Greeks (first and second order) for the research pipeline.

Conventions (all inputs broadcast; numpy arrays in, float arrays out):
  - right: "C"/"P"/"CALL"/"PUT" (any case) or a boolean call mask (True = call)
  - T in years, sigma as a decimal (0.20), r and q continuously compounded
  - vega, vanna, volga are per 1.00 of vol (divide by 100 for per vol point)
  - theta and charm are per YEAR of calendar time, signed as time passes (T shrinking):
      theta = dV/dt = -dV/dT,  charm = dDelta/dt = -dDelta/dT
  - vanna = dDelta/dsigma = dVega/dS,  volga = dVega/dsigma
  - guards match thetadata_gex.bs_gamma: every output is 0 where S, K, T or sigma <= 0
    (callers floor T themselves; the live MIN_T_YEARS = 1 day is too coarse for intraday 0DTE)

Constants RISK_FREE_RATE, MIN_IV and MIN_T_YEARS are re-exported from the live calculator
(functions/GEXCalculator/gex_calculator.py) so research and live code share one spec.

Run: python -m unittest functions/ml/test_greeks.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from scipy.special import ndtr

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "GEXCalculator"))
from gex_calculator import MIN_IV, MIN_T_YEARS, RISK_FREE_RATE  # noqa: E402,F401  — the live calculator is the spec

_INV_SQRT_2PI = 1.0 / np.sqrt(2 * np.pi)


def is_call(right) -> np.ndarray:
    """Boolean call mask from a boolean array or "C"/"P"/"CALL"/"PUT" labels."""
    r = np.asarray(right)
    if r.dtype == bool:
        return r
    return np.char.upper(r.astype(str)).astype("U1") == "C"


def _prep(S, K, T, sigma, right=None):
    """Broadcast inputs, mask valid entries, and return d1/d2 on the valid subset."""
    arrs = [np.asarray(x, dtype=float) for x in (S, K, T, sigma)]
    if right is not None:
        arrs.append(is_call(right))
    b = np.broadcast_arrays(*arrs)
    shape = b[0].shape
    s, k, t, v = b[:4]
    ok = (s > 0) & (k > 0) & (t > 0) & (v > 0)
    s, k, t, v = s[ok], k[ok], t[ok], v[ok]
    c = b[4][ok] if right is not None else None
    sqt = np.sqrt(t)
    return shape, ok, s, k, t, v, c, sqt


def _d12(s, k, t, v, sqt, r, q):
    d1 = (np.log(s / k) + (r - q + 0.5 * v * v) * t) / (v * sqt)
    return d1, d1 - v * sqt


def _fill(shape, ok, vals) -> np.ndarray:
    out = np.zeros(shape)
    out[ok] = vals
    return out[()] if out.ndim == 0 else out


def bs_price(S, K, T, sigma, right, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    shape, ok, s, k, t, v, c, sqt = _prep(S, K, T, sigma, right)
    d1, d2 = _d12(s, k, t, v, sqt, r, q)
    dq, dr = np.exp(-q * t), np.exp(-r * t)
    call = s * dq * ndtr(d1) - k * dr * ndtr(d2)
    put = k * dr * ndtr(-d2) - s * dq * ndtr(-d1)
    return _fill(shape, ok, np.where(c, call, put))


def delta(S, K, T, sigma, right, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    shape, ok, s, k, t, v, c, sqt = _prep(S, K, T, sigma, right)
    d1, _ = _d12(s, k, t, v, sqt, r, q)
    dq = np.exp(-q * t)
    return _fill(shape, ok, np.where(c, dq * ndtr(d1), dq * (ndtr(d1) - 1.0)))


def gamma(S, K, T, sigma, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """Same for calls and puts."""
    shape, ok, s, k, t, v, _, sqt = _prep(S, K, T, sigma)
    d1, _ = _d12(s, k, t, v, sqt, r, q)
    return _fill(shape, ok, np.exp(-q * t) * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI / (s * v * sqt))


def vega(S, K, T, sigma, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """dV/dsigma per 1.00 of vol. Same for calls and puts."""
    shape, ok, s, k, t, v, _, sqt = _prep(S, K, T, sigma)
    d1, _ = _d12(s, k, t, v, sqt, r, q)
    return _fill(shape, ok, s * np.exp(-q * t) * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI * sqt)


def theta(S, K, T, sigma, right, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """dV/dt per year of calendar time (negative for a long vanilla, r=q=0)."""
    shape, ok, s, k, t, v, c, sqt = _prep(S, K, T, sigma, right)
    d1, d2 = _d12(s, k, t, v, sqt, r, q)
    dq, dr = np.exp(-q * t), np.exp(-r * t)
    decay = -s * dq * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI * v / (2 * sqt)
    call = decay - r * k * dr * ndtr(d2) + q * s * dq * ndtr(d1)
    put = decay + r * k * dr * ndtr(-d2) - q * s * dq * ndtr(-d1)
    return _fill(shape, ok, np.where(c, call, put))


def vanna(S, K, T, sigma, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """dDelta/dsigma (= dVega/dS). Same for calls and puts."""
    shape, ok, s, k, t, v, _, sqt = _prep(S, K, T, sigma)
    d1, d2 = _d12(s, k, t, v, sqt, r, q)
    return _fill(shape, ok, -np.exp(-q * t) * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI * d2 / v)


def volga(S, K, T, sigma, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """dVega/dsigma (vomma). Same for calls and puts."""
    shape, ok, s, k, t, v, _, sqt = _prep(S, K, T, sigma)
    d1, d2 = _d12(s, k, t, v, sqt, r, q)
    vg = s * np.exp(-q * t) * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI * sqt
    return _fill(shape, ok, vg * d1 * d2 / v)


def charm(S, K, T, sigma, right, r: float = RISK_FREE_RATE, q: float = 0.0) -> np.ndarray:
    """dDelta/dt per year of calendar time (delta decay as expiry approaches)."""
    shape, ok, s, k, t, v, c, sqt = _prep(S, K, T, sigma, right)
    d1, d2 = _d12(s, k, t, v, sqt, r, q)
    dq = np.exp(-q * t)
    common = -dq * np.exp(-0.5 * d1 * d1) * _INV_SQRT_2PI * (2 * (r - q) * t - d2 * v * sqt) / (2 * t * v * sqt)
    call = q * dq * ndtr(d1) + common
    put = -q * dq * ndtr(-d1) + common
    return _fill(shape, ok, np.where(c, call, put))
