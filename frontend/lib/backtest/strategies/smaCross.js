import { getSeries } from '../series'

/** Classic dual moving-average crossover — the sanity check every other
 *  strategy is measured against. */
export default {
  id: 'smaCross',
  label: 'MA Cross',
  family: 'ta',
  blurb: 'Long while the fast average is above the slow one; short (optionally) below.',
  params: [
    { key: 'fast', label: 'Fast', type: 'number', default: 10, min: 2, max: 200, step: 1 },
    { key: 'slow', label: 'Slow', type: 'number', default: 50, min: 3, max: 400, step: 1 },
    {
      key: 'maType',
      label: 'MA type',
      type: 'select',
      default: 'ema',
      options: [
        { value: 'sma', label: 'SMA' },
        { value: 'ema', label: 'EMA' },
      ],
    },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: (p) => Math.max(p.fast, p.slow) + 1,

  prepare(ds, p) {
    return {
      fast: getSeries(ds, `${p.maType}:${Math.round(p.fast)}`),
      slow: getSeries(ds, `${p.maType}:${Math.round(p.slow)}`),
    }
  },

  signal(i, s, ds, p, prev) {
    const f = s.fast[i]
    const sl = s.slow[i]
    if (Number.isNaN(f) || Number.isNaN(sl)) return 0
    if (f > sl) return 1
    if (f < sl) return p.shortSide ? -1 : 0
    return prev
  },
}
