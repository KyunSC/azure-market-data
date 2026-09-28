import { getSeries } from '../../lib/backtest/series.js'

/**
 * NEGATIVE CONTROL. gex-put-wall-bounce-longgamma with the regime read from
 * `lag` sessions earlier at the same time of day. The shifted series keeps the
 * regime's base rate and persistence but breaks its alignment with today's
 * price, the same null as functions/ml/null_test.py.
 */
export default {
  id: 'control-putwall-bounce-shifted-regime',
  family: 'control',
  rationale: 'Time-shift null for the put-wall bounce: if dealers buying dips into the put wall in long gamma is real, gating on last week\'s regime (same distribution, wrong day) should score clearly worse than gating on today\'s.',
  params: [
    { key: 'band', values: [0.25, 0.5, 1.0] },
    { key: 'exit', values: [1.0, 2.0] },
    { key: 'lag', values: [5, 10] },
  ],
  risk: { flatAtSessionEnd: true },
  warmup: () => 1,
  prepare(ds, p) {
    const mins = getSeries(ds, 'f:minutes_since_open')
    const regime = getSeries(ds, 'f:above_zero_gamma')
    const n = ds.close.length
    const shifted = new Float64Array(n).fill(Number.NaN)
    const sessions = [] // per session: minute-of-session -> bar index
    for (let i = 0; i < n; i++) {
      if (i === 0 || mins[i] < mins[i - 1]) sessions.push(new Map())
      sessions.at(-1).set(mins[i], i)
      const j = sessions[sessions.length - 1 - p.lag]?.get(mins[i])
      if (j !== undefined) shifted[i] = regime[j]
    }
    return { shifted, dist: getSeries(ds, 'f:dist_put_wall_atr') }
  },
  signal(i, s, ds, p, prev) {
    const d = s.dist[i]
    if (!Number.isFinite(d)) return prev
    if (prev === 1) return d >= p.exit || d < -1.5 ? 0 : 1
    return s.shifted[i] > 0 && d <= p.band && d >= -0.5 ? 1 : 0
  },
}
