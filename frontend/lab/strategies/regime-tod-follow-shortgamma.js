import { getSeries } from '../../lib/backtest/series.js'

const WINDOWS = { open: [0, 60], midday: [120, 270], power: [330, 370] }

/**
 * Below zero gamma dealers hedge with the move (buy rallies, sell dips), which
 * should make short-horizon moves extend. Follow a 30-minute move of at least
 * `thr` ATRs, only in short gamma, inside one session window, for at most
 * 30 minutes. The mirror image of regime-tod-fade-longgamma.
 */
export default {
  id: 'regime-tod-follow-shortgamma',
  family: 'regime-tod',
  rationale: 'Short-gamma dealer hedging is pro-cyclical, so a 30m move of thr ATRs below zero gamma should continue for the next 30m; tests the momentum half of the regime story per session window.',
  params: [
    { key: 'window', values: ['open', 'midday', 'power'] },
    { key: 'thr', values: [0.5, 1.0, 2.0] },
  ],
  risk: { maxBars: 6, flatAtSessionEnd: true },
  warmup: () => 1,
  prepare(ds) {
    return {
      mins: getSeries(ds, 'f:minutes_since_open'),
      regime: getSeries(ds, 'f:above_zero_gamma'),
      ret: getSeries(ds, 'f:log_return_30m'),
      atr: getSeries(ds, 'f:atr_14'),
    }
  },
  signal(i, s, ds, p, prev) {
    if (prev !== 0) return prev
    const [lo, hi] = WINDOWS[p.window]
    const m = s.mins[i]
    if (!(m >= lo && m < hi) || !(s.regime[i] < 0) || !(s.atr[i] > 0)) return 0
    const z = (s.ret[i] * ds.close[i]) / s.atr[i]
    if (z >= p.thr) return 1
    if (z <= -p.thr) return -1
    return 0
  },
}
