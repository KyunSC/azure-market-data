import { getSeries } from '../../lib/backtest/series.js'

// Session windows in minutes_since_open. The last lab bar is 370 (15:40 ET).
const WINDOWS = { open: [0, 60], midday: [120, 270], power: [330, 370] }

/**
 * In long gamma, dealers sell into rallies and buy dips to stay delta-neutral,
 * which should make short-horizon moves mean-revert. Fade a 30-minute move of
 * at least `thr` ATRs, only above zero gamma, only inside one session window,
 * and hold for at most 30 minutes.
 */
export default {
  id: 'regime-tod-fade-longgamma',
  family: 'regime-tod',
  rationale: 'Long-gamma dealer hedging is counter-cyclical, so a 30m move of thr ATRs above zero gamma should partly reverse within 30m; the window axis asks whether this is strongest at the open, midday or into the close.',
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
    if (!(m >= lo && m < hi) || !(s.regime[i] > 0) || !(s.atr[i] > 0)) return 0
    const z = (s.ret[i] * ds.close[i]) / s.atr[i]
    if (z >= p.thr) return -1
    if (z <= -p.thr) return 1
    return 0
  },
}
