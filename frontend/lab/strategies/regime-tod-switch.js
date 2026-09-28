import { getSeries } from '../../lib/backtest/series.js'

const WINDOWS = { open: [0, 60], midday: [120, 270], power: [330, 370] }

/**
 * The full regime claim in one rule: the sign of short-horizon autocorrelation
 * flips at zero gamma. Fade 30-minute moves above zero gamma, follow them
 * below it. Requires |gamma_regime_strength| >= `minStrength` so the regime
 * label is not a coin flip near the flip level.
 */
export default {
  id: 'regime-tod-switch',
  family: 'regime-tod',
  rationale: 'If dealer gamma sets the sign of intraday autocorrelation, one rule that fades in long gamma and follows in short gamma should beat either half alone; minStrength drops bars where net GEX is near zero and the regime is ambiguous.',
  params: [
    { key: 'window', values: ['open', 'midday', 'power'] },
    { key: 'thr', values: [0.5, 1.0] },
    { key: 'minStrength', values: [0, 0.25] },
  ],
  risk: { maxBars: 6, flatAtSessionEnd: true },
  warmup: () => 1,
  prepare(ds) {
    return {
      mins: getSeries(ds, 'f:minutes_since_open'),
      regime: getSeries(ds, 'f:above_zero_gamma'),
      strength: getSeries(ds, 'f:gamma_regime_strength'),
      ret: getSeries(ds, 'f:log_return_30m'),
      atr: getSeries(ds, 'f:atr_14'),
    }
  },
  signal(i, s, ds, p, prev) {
    if (prev !== 0) return prev
    const [lo, hi] = WINDOWS[p.window]
    const m = s.mins[i]
    if (!(m >= lo && m < hi) || !(s.atr[i] > 0) || !(Math.abs(s.strength[i]) >= p.minStrength)) return 0
    const z = (s.ret[i] * ds.close[i]) / s.atr[i]
    if (!(Math.abs(z) >= p.thr)) return 0
    const side = s.regime[i] > 0 ? -1 : s.regime[i] < 0 ? 1 : 0
    return side * Math.sign(z)
  },
}
