/**
 * Columnar series layer for the backtest engine.
 *
 * The chart uses row objects (`{ time, open, close, ... }`); the engine uses
 * parallel Float64Arrays because a 500-cell sweep re-reads the same bars
 * hundreds of times. The indicator definitions here are the columnar mirror of
 * `components/indicators.js` — SMA/EMA/Bollinger/VWAP use the same formulas, so
 * a line drawn on the chart and a signal fired by the engine agree.
 *
 * Warm-up positions are `NaN`. The engine treats a NaN signal input as "no
 * opinion" and holds flat, which is what keeps the first N bars from trading on
 * a half-formed average.
 */

const NA = Number.NaN

export function sma(src, period) {
  const n = src.length
  const out = new Float64Array(n).fill(NA)
  if (period < 1 || n < period) return out
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += src[i]
    if (i >= period) sum -= src[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(src, period) {
  const n = src.length
  const out = new Float64Array(n).fill(NA)
  if (period < 1 || n < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += src[i]
  let prev = seed / period
  out[period - 1] = prev
  for (let i = period; i < n; i++) {
    prev = (src[i] - prev) * k + prev
    out[i] = prev
  }
  return out
}

export function stdev(src, period) {
  const n = src.length
  const out = new Float64Array(n).fill(NA)
  if (period < 2 || n < period) return out
  const mean = sma(src, period)
  for (let i = period - 1; i < n; i++) {
    let sq = 0
    for (let j = i - period + 1; j <= i; j++) sq += (src[j] - mean[i]) ** 2
    out[i] = Math.sqrt(sq / period)
  }
  return out
}

export function rsi(src, period) {
  const n = src.length
  const out = new Float64Array(n).fill(NA)
  if (n <= period) return out
  let gain = 0
  let loss = 0
  for (let i = 1; i <= period; i++) {
    const d = src[i] - src[i - 1]
    if (d >= 0) gain += d
    else loss -= d
  }
  gain /= period
  loss /= period
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  for (let i = period + 1; i < n; i++) {
    const d = src[i] - src[i - 1]
    gain = (gain * (period - 1) + Math.max(d, 0)) / period
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss)
  }
  return out
}

export function atr(ds, period) {
  const { high, low, close } = ds
  const n = close.length
  const tr = new Float64Array(n)
  tr[0] = high[0] - low[0]
  for (let i = 1; i < n; i++) {
    tr[i] = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1]),
    )
  }
  return sma(tr, period)
}

/** Session-anchored VWAP — resets on each new UTC calendar day, matching the
 *  chart's intraday VWAP. Daily and slower intervals get a single running band. */
export function vwap(ds) {
  const { high, low, close, volume, time } = ds
  const n = close.length
  const out = new Float64Array(n).fill(NA)
  let day = -1
  let cumPv = 0
  let cumV = 0
  for (let i = 0; i < n; i++) {
    const d = Math.floor(time[i] / 86400)
    if (d !== day) {
      day = d
      cumPv = 0
      cumV = 0
    }
    const tp = (high[i] + low[i] + close[i]) / 3
    const v = volume[i] || 0
    cumPv += tp * v
    cumV += v
    out[i] = cumV > 0 ? cumPv / cumV : tp
  }
  return out
}

/** True on the last bar of a UTC calendar day (used for flat-at-close). */
export function sessionEndFlags(time) {
  const n = time.length
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? Math.floor(time[i + 1] / 86400) : -1
    out[i] = i === n - 1 || next !== Math.floor(time[i] / 86400) ? 1 : 0
  }
  return out
}

/**
 * Named-series resolver. Keys:
 *   `close` `open` `high` `low` `volume` `hl2` `typical`
 *   `sma:20` `ema:21` `rsi:14` `atr:14` `stdev:20` `vwap`
 *   `bbUpper:20:2` `bbLower:20:2` `bbMid:20`
 *   `f:net_gex`   — exported GEX/baseline feature (research plane only)
 *   `ml:pred`     — walk-forward OOS model prediction (research plane only)
 *
 * Results are memoised on the dataset so a parameter sweep computes each
 * distinct series exactly once.
 */
export function getSeries(ds, key) {
  if (!ds.__seriesCache) Object.defineProperty(ds, '__seriesCache', { value: new Map(), enumerable: false })
  const cache = ds.__seriesCache
  const hit = cache.get(key)
  if (hit) return hit
  const built = buildSeries(ds, key)
  cache.set(key, built)
  return built
}

function buildSeries(ds, key) {
  const n = ds.close.length
  const [name, ...args] = String(key).split(':')
  const p = (idx, dflt) => (args[idx] === undefined ? dflt : Number(args[idx]))

  switch (name) {
    case 'open': return ds.open
    case 'high': return ds.high
    case 'low': return ds.low
    case 'close': return ds.close
    case 'volume': return ds.volume
    case 'hl2': {
      const out = new Float64Array(n)
      for (let i = 0; i < n; i++) out[i] = (ds.high[i] + ds.low[i]) / 2
      return out
    }
    case 'typical': {
      const out = new Float64Array(n)
      for (let i = 0; i < n; i++) out[i] = (ds.high[i] + ds.low[i] + ds.close[i]) / 3
      return out
    }
    case 'sma': return sma(ds.close, p(0, 20))
    case 'ema': return ema(ds.close, p(0, 21))
    case 'rsi': return rsi(ds.close, p(0, 14))
    case 'atr': return atr(ds, p(0, 14))
    case 'stdev': return stdev(ds.close, p(0, 20))
    case 'vwap': return vwap(ds)
    case 'bbMid': return sma(ds.close, p(0, 20))
    case 'bbUpper':
    case 'bbLower': {
      const period = p(0, 20)
      const mult = p(1, 2)
      const mid = sma(ds.close, period)
      const sd = stdev(ds.close, period)
      const sign = name === 'bbUpper' ? 1 : -1
      const out = new Float64Array(n).fill(NA)
      for (let i = 0; i < n; i++) {
        if (!Number.isNaN(mid[i]) && !Number.isNaN(sd[i])) out[i] = mid[i] + sign * mult * sd[i]
      }
      return out
    }
    case 'f': {
      const col = ds.features?.[args.join(':')]
      return col || new Float64Array(n).fill(NA)
    }
    case 'ml': {
      const col = ds.ml?.[args.join(':')]
      return col || new Float64Array(n).fill(NA)
    }
    default:
      return new Float64Array(n).fill(NA)
  }
}

/** Constant-series helper so the rule evaluator can treat literals uniformly. */
export function constSeries(n, v) {
  return new Float64Array(n).fill(v)
}
