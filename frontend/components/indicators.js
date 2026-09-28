import { atr } from '../lib/backtest/series'
import { sessionLevels, floorPivots, zoneSeries, buildZones, isIntraday, PIVOT_KEYS, PIVOT_METHODS } from '../lib/levels'

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
  { id: 'trend-logic', label: 'EMA Trend Friend Pro', type: 'trend-logic', fastPeriod: 21, slowPeriod: 200, color: '#4caf50' },
  { id: 'sr-session', label: 'Session Levels', type: 'sr-session', orMinutes: 30, color: '#ff7043' },
  { id: 'sr-pivots', label: 'Floor Pivots', type: 'sr-pivots', method: 'classic', color: '#ffee58' },
  { id: 'sr-zones', label: 'S/R Zones', type: 'sr-zones', left: 5, tolAtr: 0.25, minScore: 1.5, maxZones: 6, color: '#29b6f6' },
]

export const TREND_COLORS = {
  bullish: '#4caf50',
  bearish: '#ef5350',
  neutral: '#9e9e9e',
}

export const INDICATORS_STORAGE_KEY = 'chart-active-indicators'
export const INDICATOR_OVERRIDES_STORAGE_KEY = 'chart-indicator-overrides'

// Per-type editable numeric fields. Color is editable on every indicator and
// handled separately by the UI.
export const EDITABLE_FIELDS_BY_TYPE = {
  sma:            [{ key: 'period',     label: 'Period', min: 1, max: 1000 }],
  ema:            [{ key: 'period',     label: 'Period', min: 1, max: 1000 }],
  bb:             [
    { key: 'period', label: 'Period', min: 1,   max: 1000 },
    { key: 'stdDev', label: 'StdDev', min: 0.1, max: 10, step: 0.1 },
  ],
  'trend-logic':  [
    { key: 'fastPeriod', label: 'Fast', min: 1, max: 1000 },
    { key: 'slowPeriod', label: 'Slow', min: 1, max: 1000 },
  ],
  'sr-session':   [{ key: 'orMinutes', label: 'Opening range (min)', min: 5, max: 390 }],
  'sr-pivots':    [{ key: 'method', label: 'Method', options: PIVOT_METHODS }],
  'sr-zones':     [
    { key: 'left',     label: 'Pivot strength', min: 2,    max: 50 },
    { key: 'tolAtr',   label: 'Width (ATR)',    min: 0.05, max: 5,  step: 0.05 },
    { key: 'minScore', label: 'Min score',      min: 0.25, max: 20, step: 0.25 },
    { key: 'maxZones', label: 'Max zones',      min: 1,    max: 20 },
  ],
}

export function resolveIndicator(id, overrides) {
  const base = AVAILABLE_INDICATORS.find(i => i.id === id)
  if (!base) return null
  const patch = overrides?.[id]
  return patch ? { ...base, ...patch } : base
}

export function indicatorDisplayLabel(ind) {
  if (!ind) return ''
  switch (ind.type) {
    case 'sma':          return `SMA ${ind.period}`
    case 'ema':          return `EMA ${ind.period}`
    case 'trend-logic':  return 'EMA Trend Friend Pro'
    case 'sr-pivots':    return `Floor Pivots (${ind.method})`
    default:             return ind.label
  }
}

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

const SESSION_LINES = [
  { key: 'pdh', label: 'PDH', color: '#ff7043' },
  { key: 'pdl', label: 'PDL', color: '#26a69a' },
  { key: 'pdc', label: 'PDC', color: '#bdbdbd', style: 2 },
  { key: 'onh', label: 'ONH', color: '#ffa726', style: 2 },
  { key: 'onl', label: 'ONL', color: '#66bb6a', style: 2 },
  { key: 'orh', label: 'ORH', color: '#ab47bc', style: 1 },
  { key: 'orl', label: 'ORL', color: '#7e57c2', style: 1 },
]

const pivotColor = (k) => (k === 'P' ? '#ffee58' : k.startsWith('R') ? '#ef5350' : '#26a69a')

// Level arrays → line-series data. A change of value (new day, level just
// formed) gets a whitespace point so the chart breaks the line there instead
// of drawing a vertical connector.
function levelLine(data, values) {
  const out = []
  let prev = NaN
  for (let i = 0; i < data.length; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) { out.push({ time: data[i].time }); prev = NaN; continue }
    out.push(v === prev ? { time: data[i].time, value: v } : { time: data[i].time })
    prev = v
  }
  return out
}

// Chart rows → the columnar shape `lib/levels.js` takes. Session math needs
// real UTC epochs, so this reads `utc` (set by the chart's parser) rather than
// the display-shifted `time`.
function toColumns(data) {
  return {
    time: data.map(d => (typeof d.utc === 'number' ? d.utc : NaN)),
    high: data.map(d => d.high),
    low: data.map(d => d.low),
    close: data.map(d => d.close),
  }
}

/**
 * `context.extraLevels` ([{ price, source, label }]) lets the chart add GEX
 * walls and volume-profile nodes to the S/R zone scoring.
 */
export function computeIndicator(indicator, data, context = {}) {
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
    case 'sr-session': {
      const cols = toColumns(data)
      if (!isIntraday(cols.time)) return null
      const lv = sessionLevels(cols, { orMinutes: indicator.orMinutes || 30 })
      return {
        type: 'levels',
        lines: SESSION_LINES.map(l => ({ ...l, data: levelLine(data, lv[l.key]) })),
      }
    }
    case 'sr-pivots': {
      const cols = toColumns(data)
      if (!isIntraday(cols.time)) return null
      const lv = sessionLevels(cols)
      const piv = floorPivots(lv.pdh, lv.pdl, lv.pdc, indicator.method || 'classic')
      return {
        type: 'levels',
        lines: PIVOT_KEYS.map(k => ({
          key: k, label: k, color: pivotColor(k), style: k === 'P' ? 0 : 2, data: levelLine(data, piv[k]),
        })),
      }
    }
    case 'sr-zones': {
      const cols = toColumns(data)
      const zs = zoneSeries(cols, atr(cols, 14), {
        left: indicator.left || 5,
        tolAtr: indicator.tolAtr || 0.25,
      })
      const { candidates, tol, now, halfLife } = zs.last
      if (!(tol > 0)) return null
      // Same scorer and tolerance as the engine's zones, plus the chart-only sources.
      const extras = (context.extraLevels || []).filter(c => Number.isFinite(c.price))
      const minScore = indicator.minScore ?? 1.5
      const zones = buildZones([...candidates, ...extras], { tol, now, halfLife })
        .filter(z => z.score >= minScore)
      // Keep the strongest `maxZones`, then return them in price order.
      zones.sort((a, b) => b.score - a.score)
      const kept = zones.slice(0, indicator.maxZones || 6).sort((a, b) => a.mid - b.mid)
      const close = data[data.length - 1].close
      return {
        type: 'zones',
        color: indicator.color,
        zones: kept.map(z => ({
          ...z,
          side: z.mid <= close ? 'S' : 'R',
          firstTime: Number.isFinite(z.firstIdx) ? data[z.firstIdx].time : null,
        })),
      }
    }
    default:
      return null
  }
}
