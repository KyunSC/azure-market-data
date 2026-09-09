import { drawdown, sharpe } from './metrics'

export const BENCHMARKS = [
  { symbol: 'SPY', label: 'S&P 500 (SPY)', currency: 'USD' },
  { symbol: 'QQQ', label: 'QQQ', currency: 'USD' },
  { symbol: 'XEQT.TO', label: 'XEQT', currency: 'CAD' },
]

const dateFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
const closeFormat = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const barSeconds = { '1m': 60, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400 }

/** Use the last available near-close strategy mark on each date.
 * Research exports omit their final forward-label bars, so these marks can
 * precede the official close; the comparison UI explicitly labels this.
 * Daily bars are date-labeled UTC; intraday bars are timestamped at bucket start.
 */
export function dailyStrategy(dataset, result) {
  const observations = new Map()
  for (let i = result.windowStart; i <= result.windowEnd; i++) {
    const time = dataset.time[i]
    const date = dataset.interval === '1d' ? new Date(time * 1000).toISOString().slice(0, 10) : dateFormat.format(new Date(time * 1000))
    if (dataset.interval !== '1d') {
      const seconds = barSeconds[dataset.interval]
      if (!seconds) throw new Error('Daily benchmark comparison is unavailable for this interval')
      const closeTime = new Date((time + seconds) * 1000)
      const clock = closeFormat.format(closeTime)
      if (clock < '15:30' || clock > '16:00' || dateFormat.format(closeTime) !== date) continue
    }
    if (Number.isFinite(result.equity[i])) observations.set(date, result.equity[i])
  }
  return observations
}

function metrics(values, dates, missingSessions) {
  const returns = values.slice(1).map((value, i) => value / values[i] - 1)
  // Missing sessions make annualized daily Sharpe misleading; retain return/DD.
  const gaps = dates.slice(1).some((date, i) => (Date.parse(date) - Date.parse(dates[i])) / 86400000 > 4)
  return { totalReturn: values.at(-1) / values[0] - 1, maxDd: drawdown(values).maxDd,
    sharpe: missingSessions || gaps || returns.length < 2 || !returns.every(Number.isFinite) ? null : sharpe(returns, 252) }
}

export function compareBenchmark(observations, payload) {
  if (payload.priceBasis !== 'adjusted-close' || !Array.isArray(payload.data)) throw new Error('Invalid benchmark response')
  const seen = new Set()
  const points = payload.data.filter(point => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date) || !Number.isFinite(point.adjustedClose) || point.adjustedClose <= 0 || seen.has(point.date)) throw new Error('Invalid benchmark prices')
    seen.add(point.date)
    return observations.has(point.date)
  }).sort((a, b) => a.date.localeCompare(b.date))
  if (points.length < 2) throw new Error('Need at least two matching daily observations to compare')
  const dates = points.map(point => point.date)
  const strategy = points.map(point => observations.get(point.date))
  const benchmark = points.map(point => point.adjustedClose)
  if (strategy[0] <= 0) throw new Error('Strategy must have positive equity at comparison start')
  const missingSessions = payload.data.some(point => point.date >= dates[0] && point.date <= dates.at(-1) && !observations.has(point.date))
  return { dates, strategy: metrics(strategy, dates, missingSessions), benchmark: metrics(benchmark, dates, missingSessions), currency: payload.currency,
    points: points.map((point, i) => ({ date: point.date, strategy: strategy[i] / strategy[0], benchmark: benchmark[i] / benchmark[0] })) }
}
