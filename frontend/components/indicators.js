export const AVAILABLE_INDICATORS = [
  { id: 'sma20', label: 'SMA 20', type: 'sma', period: 20, color: '#ff9800' },
  { id: 'sma50', label: 'SMA 50', type: 'sma', period: 50, color: '#e91e63' },
  { id: 'sma200', label: 'SMA 200', type: 'sma', period: 200, color: '#9c27b0' },
  { id: 'ema12', label: 'EMA 12', type: 'ema', period: 12, color: '#00bcd4' },
  { id: 'ema21', label: 'EMA 21', type: 'ema', period: 21, color: '#4caf50' },
  { id: 'ema26', label: 'EMA 26', type: 'ema', period: 26, color: '#ffeb3b' },
  { id: 'ema200', label: 'EMA 200', type: 'ema', period: 200, color: '#f44336' },
  { id: 'bb20', label: 'Bollinger Bands', type: 'bb', period: 20, stdDev: 2, color: '#7c4dff' },
  { id: 'vwap', label: 'VWAP', type: 'vwap', color: '#2196f3' },
  { id: 'vpro', label: 'Volume Profile', type: 'vpro', color: '#5c6bc0' },
  { id: 'volume', label: 'Volume', type: 'volume', color: '#5c6bc0' },
  { id: 'gex', label: 'GEX Levels', type: 'gex', color: '#ffff00' },
  { id: 'trend-logic', label: 'Trend Logic (21/200 EMA)', type: 'trend-logic', fastPeriod: 21, slowPeriod: 200, color: '#4caf50' },
]

export const TREND_COLORS = {
  bullish: '#4caf50',
  bearish: '#ef5350',
  neutral: '#9e9e9e',
}

export const INDICATORS_STORAGE_KEY = 'chart-active-indicators'

function calcSMA(data, period) {
  const result = []
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j].close
    }
    result.push({ time: data[i].time, value: sum / period })
  }
  return result
}

function calcEMA(data, period) {
  const result = []
  const multiplier = 2 / (period + 1)

  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += data[i].close
  }
  let ema = sum / period
  result.push({ time: data[period - 1].time, value: ema })

  for (let i = period; i < data.length; i++) {
    ema = (data[i].close - ema) * multiplier + ema
    result.push({ time: data[i].time, value: ema })
  }
  return result
}

function calcBollingerBands(data, period, stdDev) {
  const upper = []
  const middle = []
  const lower = []

  for (let i = period - 1; i < data.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sum += data[j].close
    }
    const mean = sum / period

    let sqSum = 0
    for (let j = i - period + 1; j <= i; j++) {
      sqSum += (data[j].close - mean) ** 2
    }
    const std = Math.sqrt(sqSum / period)

    const time = data[i].time
    middle.push({ time, value: mean })
    upper.push({ time, value: mean + stdDev * std })
    lower.push({ time, value: mean - stdDev * std })
  }

  return { upper, middle, lower }
}

function calcVWAP(data) {
  const result = []
  let cumVolume = 0
  let cumTPV = 0

  for (let i = 0; i < data.length; i++) {
    const tp = (data[i].high + data[i].low + data[i].close) / 3
    const vol = data[i].volume || 0
    cumVolume += vol
    cumTPV += tp * vol
    if (cumVolume > 0) {
      result.push({ time: data[i].time, value: cumTPV / cumVolume })
    }
  }
  return result
}

// Returns a state array aligned to `data` (same length). Each entry is one of
// 'bullish' | 'bearish' | 'neutral' | null (null = before EMAs are warmed up).
export function calcTrendLogic(data, fastPeriod = 21, slowPeriod = 200) {
  const n = data?.length || 0
  const states = new Array(n).fill(null)
  if (n < slowPeriod) return states

  const fastEma = calcEMA(data, fastPeriod)
  const slowEma = calcEMA(data, slowPeriod)
  // calcEMA aligns its first sample to index `period - 1`. The two series share
  // the slow-period tail, so we walk by absolute bar index and look each up.
  const fastByTime = new Map(fastEma.map(p => [p.time, p.value]))
  const slowByTime = new Map(slowEma.map(p => [p.time, p.value]))
  for (let i = slowPeriod - 1; i < n; i++) {
    const t = data[i].time
    const f = fastByTime.get(t)
    const s = slowByTime.get(t)
    if (f == null || s == null) continue
    const close = data[i].close
    if (f > s && close > f) states[i] = 'bullish'
    else if (f < s && close < f) states[i] = 'bearish'
    else states[i] = 'neutral'
  }
  return states
}

// Returns the trend state for the latest bar of `data`. Convenience wrapper
// for callers (e.g. the multi-TF table) that only care about the current value.
export function latestTrendState(data, fastPeriod = 21, slowPeriod = 200) {
  const states = calcTrendLogic(data, fastPeriod, slowPeriod)
  for (let i = states.length - 1; i >= 0; i--) {
    if (states[i]) return states[i]
  }
  return null
}

export function computeIndicator(indicator, data) {
  if (!data || data.length === 0) return null

  switch (indicator.type) {
    case 'volume':
      return {
        type: 'volume',
        data: data.map(d => ({
          time: d.time,
          value: d.volume || 0,
          color: d.close >= d.open ? '#26a69a80' : '#ef535080',
        })),
      }
    case 'sma':
      if (data.length < indicator.period) return null
      return { type: 'line', data: calcSMA(data, indicator.period), color: indicator.color }
    case 'ema':
      if (data.length < indicator.period) return null
      return { type: 'line', data: calcEMA(data, indicator.period), color: indicator.color }
    case 'vwap':
      return { type: 'line', data: calcVWAP(data), color: indicator.color }
    case 'bb':
      if (data.length < indicator.period) return null
      const bands = calcBollingerBands(data, indicator.period, indicator.stdDev)
      return {
        type: 'bb',
        upper: { data: bands.upper, color: indicator.color },
        middle: { data: bands.middle, color: indicator.color },
        lower: { data: bands.lower, color: indicator.color },
      }
    case 'trend-logic': {
      const fast = indicator.fastPeriod || 21
      const slow = indicator.slowPeriod || 200
      if (data.length < slow) return null
      const fastLine = calcEMA(data, fast)
      const slowLine = calcEMA(data, slow)
      return {
        type: 'trend-logic',
        states: calcTrendLogic(data, fast, slow),
        fast: { data: fastLine, color: '#26c6da' },
        slow: { data: slowLine, color: '#ab47bc' },
      }
    }
    default:
      return null
  }
}
