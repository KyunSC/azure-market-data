import { getSeries } from '../series'

/** Fade stretches away from session VWAP. Bands are measured in ATR so the
 *  same parameter means the same thing across symbols and volatility regimes. */
export default {
  id: 'vwapReversion',
  label: 'VWAP Fade',
  family: 'ta',
  blurb: 'Fade price back to session VWAP once it stretches N ATR away.',
  params: [
    { key: 'entryAtr', label: 'Entry (ATR)', type: 'number', default: 1.2, min: 0.1, max: 5, step: 0.1 },
    { key: 'exitAtr', label: 'Exit (ATR)', type: 'number', default: 0.2, min: 0, max: 3, step: 0.1 },
    { key: 'atrPeriod', label: 'ATR period', type: 'number', default: 14, min: 2, max: 100, step: 1 },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: (p) => Math.round(p.atrPeriod) + 1,

  prepare(ds, p) {
    return {
      vwap: getSeries(ds, 'vwap'),
      atr: getSeries(ds, `atr:${Math.round(p.atrPeriod)}`),
    }
  },

  signal(i, s, ds, p, prev) {
    const a = s.atr[i]
    if (!(a > 0)) return 0
    const dev = (ds.close[i] - s.vwap[i]) / a

    if (prev > 0) return dev >= -p.exitAtr ? 0 : 1
    if (prev < 0) return dev <= p.exitAtr ? 0 : -1

    if (dev <= -p.entryAtr) return 1
    if (dev >= p.entryAtr) return p.shortSide ? -1 : 0
    return 0
  },
}
