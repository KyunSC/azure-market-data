import { getSeries } from '../series'

/** Bollinger band mean reversion: enter on a band touch, exit back at the mid.
 *  Stateful — it holds through the middle of the band, so it reads `prev`. */
export default {
  id: 'bbReversion',
  label: 'BB Reversion',
  family: 'ta',
  blurb: 'Buy the lower band, sell the upper, flatten at the mid.',
  params: [
    { key: 'period', label: 'Period', type: 'number', default: 20, min: 5, max: 200, step: 1 },
    { key: 'stdDev', label: 'Std dev', type: 'number', default: 2, min: 0.5, max: 4, step: 0.1 },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: (p) => Math.round(p.period) + 1,

  prepare(ds, p) {
    const period = Math.round(p.period)
    const mult = p.stdDev
    return {
      upper: getSeries(ds, `bbUpper:${period}:${mult}`),
      lower: getSeries(ds, `bbLower:${period}:${mult}`),
      mid: getSeries(ds, `bbMid:${period}`),
    }
  },

  signal(i, s, ds, p, prev) {
    const close = ds.close[i]
    const mid = s.mid[i]
    if (Number.isNaN(mid)) return 0

    if (prev > 0) return close >= mid ? 0 : 1
    if (prev < 0) return close <= mid ? 0 : -1

    if (close <= s.lower[i]) return 1
    if (close >= s.upper[i]) return p.shortSide ? -1 : 0
    return 0
  },
}
