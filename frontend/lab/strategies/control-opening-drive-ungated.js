import { getSeries } from '../../lib/backtest/series.js'

/**
 * ABLATION CONTROL for neggamma-opening-drive: the same opening-drive rule
 * with no regime gate. The negative-gamma version only earns credit for the
 * gate if it beats this one on both symbols.
 */
export default {
  id: 'control-opening-drive-ungated',
  family: 'control',
  rationale: 'Ablation: trade the opening-range direction on every day, not only negative-gamma days. If neggamma-opening-drive cannot beat this, pro-cyclical dealer hedging is not what drives it.',
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
      atr: getSeries(ds, 'f:atr_14'),
      open: new Map(),
    }
  },
  signal(i, s, ds, p, prev) {
    const m = s.mins[i]
    if (!Number.isFinite(m)) return 0
    if (m <= 5) s.open.set(Math.floor(ds.time[i] / 86400), ds.open[i])
    if (prev !== 0) return m >= p.holdUntil ? 0 : prev
    if (m < p.window || m >= p.window + 5) return 0
    const o = s.open.get(Math.floor(ds.time[i] / 86400))
    const atr = s.atr[i]
    if (!(o > 0) || !(atr > 0)) return 0
    const move = (ds.close[i] - o) / atr
    if (move >= p.minAtr) return 1
    if (move <= -p.minAtr) return -1
    return 0
  },
}
