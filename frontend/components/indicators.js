export const AVAILABLE_INDICATORS = [
  { id: 'sma20', label: 'SMA 20', type: 'sma', period: 20, color: '#ff9800' },
  { id: 'sma50', label: 'SMA 50', type: 'sma', period: 50, color: '#e91e63' },
  { id: 'sma200', label: 'SMA 200', type: 'sma', period: 200, color: '#9c27b0' },
  { id: 'ema12', label: 'EMA 12', type: 'ema', period: 12, color: '#00bcd4' },
  { id: 'ema26', label: 'EMA 26', type: 'ema', period: 26, color: '#ffeb3b' },
  { id: 'bb20', label: 'Bollinger Bands', type: 'bb', period: 20, stdDev: 2, color: '#7c4dff' },
  { id: 'volume', label: 'Volume', type: 'volume', color: '#5c6bc0' },
  { id: 'gex', label: 'GEX Levels (NQ)', type: 'gex', color: '#ffff00' },
]

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
    case 'bb':
      if (data.length < indicator.period) return null
      const bands = calcBollingerBands(data, indicator.period, indicator.stdDev)
      return {
        type: 'bb',
        upper: { data: bands.upper, color: indicator.color },
        middle: { data: bands.middle, color: indicator.color },
        lower: { data: bands.lower, color: indicator.color },
      }
    default:
      return null
  }
}
