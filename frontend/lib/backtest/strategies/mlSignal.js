import { getSeries } from '../series'

/**
 * Trade the random forest's walk-forward prediction.
 *
 * `ml:pred` is populated only on out-of-sample bars — the export script writes
 * NaN everywhere a fold was still training. Those bars produce no position, so
 * the equity curve here is genuinely out-of-sample by construction; there is no
 * in-sample stretch quietly inflating the front of the curve.
 *
 * The model predicts a forward log return over `horizonMinutes`, so the default
 * exit is a time stop at that horizon rather than a signal flip.
 */
export default {
  id: 'mlSignal',
  label: 'ML Signal (RF)',
  family: 'ml',
  plane: 'research',
  blurb: 'Long/short when the OOS forest prediction clears ±θ, exit at the model horizon.',
  params: [
    { key: 'thresholdBp', label: 'Threshold θ (bp)', type: 'number', default: 3, min: 0, max: 50, step: 0.5 },
    { key: 'holdBars', label: 'Hold bars', type: 'number', default: 3, min: 1, max: 60, step: 1 },
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'hold',
      options: [
        { value: 'hold', label: 'Hold N bars' },
        { value: 'follow', label: 'Follow sign' },
      ],
    },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: () => 1,

  prepare(ds) {
    return { pred: getSeries(ds, 'ml:pred'), entryBar: -1 }
  },

  signal(i, s, ds, p, prev) {
    const v = s.pred[i]
    const theta = p.thresholdBp / 10000

    if (p.mode === 'follow') {
      if (Number.isNaN(v)) return 0
      if (v > theta) return 1
      if (v < -theta) return p.shortSide ? -1 : 0
      return 0
    }

    if (prev !== 0) {
      if (i - s.entryBar >= Math.round(p.holdBars)) {
        s.entryBar = -1
        return 0
      }
      return prev
    }

    if (Number.isNaN(v)) return 0
    if (v > theta) {
      s.entryBar = i
      return 1
    }
    if (v < -theta && p.shortSide) {
      s.entryBar = i
      return -1
    }
    return 0
  },
}
