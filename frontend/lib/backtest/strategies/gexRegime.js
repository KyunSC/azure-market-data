import { getSeries } from '../series'

/**
 * Regime switch on the zero-gamma line.
 *
 * Above zero gamma dealers are long gamma and hedge *against* price, damping
 * moves — so mean-revert. Below it they hedge *with* price, amplifying moves —
 * so trend-follow. One dataset, two opposite behaviours selected by a single
 * feature: the cleanest expression of why historical GEX is worth having.
 */
export default {
  id: 'gexRegime',
  label: 'GEX Regime Switch',
  family: 'gex',
  plane: 'research',
  blurb: 'Mean-revert above zero gamma, trend-follow below it.',
  params: [
    { key: 'lookback', label: 'Momentum bars', type: 'number', default: 6, min: 1, max: 60, step: 1 },
    { key: 'revertZ', label: 'Revert trigger (%)', type: 'number', default: 0.15, min: 0.01, max: 2, step: 0.01 },
    { key: 'momentumBp', label: 'Trend trigger (bp)', type: 'number', default: 8, min: 0, max: 100, step: 1 },
    { key: 'minStrength', label: 'Min |regime|', type: 'number', default: 0, min: 0, max: 1, step: 0.02 },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: (p) => Math.round(p.lookback) + 20,

  prepare(ds, p) {
    const n = ds.close.length
    const lb = Math.round(p.lookback)
    const mom = new Float64Array(n).fill(Number.NaN)
    for (let i = lb; i < n; i++) mom[i] = ds.close[i] / ds.close[i - lb] - 1
    return {
      mom,
      regime: getSeries(ds, 'f:above_zero_gamma'),
      strength: getSeries(ds, 'f:gamma_regime_strength'),
      vsSma: getSeries(ds, 'f:close_vs_sma20'),
      sma20: getSeries(ds, 'sma:20'),
    }
  },

  signal(i, s, ds, p) {
    const regime = s.regime[i]
    if (Number.isNaN(regime)) return 0
    if (Math.abs(s.strength[i]) < p.minStrength) return 0

    const short = (v) => (p.shortSide ? v : 0)

    if (regime > 0) {
      // Long gamma → fade stretch from the 20-bar mean.
      let stretch = s.vsSma[i]
      if (Number.isNaN(stretch)) {
        const m = s.sma20[i]
        if (Number.isNaN(m)) return 0
        stretch = ds.close[i] / m - 1
      }
      const trigger = p.revertZ / 100
      if (stretch <= -trigger) return 1
      if (stretch >= trigger) return short(-1)
      return 0
    }

    // Short gamma → ride the move.
    const m = s.mom[i]
    if (Number.isNaN(m)) return 0
    const trigger = p.momentumBp / 10000
    if (m >= trigger) return 1
    if (m <= -trigger) return short(-1)
    return 0
  },
}
