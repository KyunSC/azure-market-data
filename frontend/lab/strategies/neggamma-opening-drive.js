import { getSeries } from '../../lib/backtest/series.js'

/**
 * Below zero gamma dealers hedge WITH the move, so an opening push should
 * extend rather than fade. Trade the direction of the first `window` minutes'
 * return, only in negative gamma, and only if the move is at least `minAtr`
 * ATRs. Flat at the close.
 */
export default {
  id: 'neggamma-opening-drive',
  family: 'gex',
  rationale: 'Negative gamma amplifies moves (dealer hedging is pro-cyclical), so the opening-range direction should persist into midday.',
  params: [
    { key: 'window', values: [15, 30, 60] },
    { key: 'minAtr', values: [0.5, 1.0, 1.5] },
    { key: 'holdUntil', values: [180, 390] },
  ],
  risk: { flatAtSessionEnd: true },
  warmup: () => 1,
  prepare(ds) {
    return {
      mins: getSeries(ds, 'f:minutes_since_open'),
      regime: getSeries(ds, 'f:above_zero_gamma'),
      atr: getSeries(ds, 'f:atr_14'),
      open: new Map(), // trading-day open price, filled as bars are seen
    }
  },
  signal(i, s, ds, p, prev) {
    const m = s.mins[i]
    if (!Number.isFinite(m)) return 0
    if (m <= 5) s.open.set(Math.floor(ds.time[i] / 86400), ds.open[i])
    if (prev !== 0) return m >= p.holdUntil ? 0 : prev
    if (m < p.window || m >= p.window + 5) return 0
    if (!(s.regime[i] < 0)) return 0
    const o = s.open.get(Math.floor(ds.time[i] / 86400))
    const atr = s.atr[i]
    if (!(o > 0) || !(atr > 0)) return 0
    const move = (ds.close[i] - o) / atr
    if (move >= p.minAtr) return 1
    if (move <= -p.minAtr) return -1
    return 0
  },
}
