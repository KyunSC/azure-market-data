import { getSeries } from '../series'

/**
 * Trade the nearest support / resistance zone (see `lib/levels.js`).
 *
 * Zones cluster confirmed swing pivots with the session levels and floor
 * pivots, and score each cluster by touches, recency and how many independent
 * sources agree. Only price-derived sources are available here; the chart also
 * folds in GEX walls and volume-profile nodes, which have no columnar series.
 *
 *   fade      buy within `bandAtr` above support, short within `bandAtr` below
 *             resistance. Exit `exitAtr` past the zone mid, or when price closes
 *             through the far side of the zone (the level failed).
 *   breakout  go with a close through a zone that held the bar before. Exit
 *             `exitAtr` beyond the zone, or on a close back inside it.
 *
 * The zone a position was opened on is remembered for its exits, so a trade
 * is judged against the level it was taken at, not whichever zone is nearest now.
 */
export default {
  id: 'srLevels',
  label: 'S/R Levels',
  family: 'ta',
  blurb: 'Fade or break the nearest scored support/resistance zone.',
  params: [
    {
      key: 'mode',
      label: 'Mode',
      type: 'select',
      default: 'fade',
      options: [
        { value: 'fade', label: 'Fade' },
        { value: 'breakout', label: 'Breakout' },
      ],
    },
    { key: 'left', label: 'Pivot strength', type: 'number', default: 5, min: 2, max: 30, step: 1 },
    { key: 'tolAtr', label: 'Zone width (ATR)', type: 'number', default: 0.25, min: 0.05, max: 2, step: 0.05 },
    { key: 'minScore', label: 'Min zone score', type: 'number', default: 1.5, min: 0, max: 10, step: 0.25 },
    { key: 'bandAtr', label: 'Entry band (ATR)', type: 'number', default: 0.25, min: 0, max: 3, step: 0.05 },
    { key: 'exitAtr', label: 'Target (ATR)', type: 'number', default: 1, min: 0.1, max: 6, step: 0.1 },
    { key: 'atrPeriod', label: 'ATR period', type: 'number', default: 14, min: 2, max: 100, step: 1 },
    { key: 'shortSide', label: 'Short side', type: 'boolean', default: true },
  ],

  warmup: (p) => Math.max(Math.round(p.atrPeriod), 14, 2 * Math.round(p.left)) + 1,

  prepare(ds, p) {
    const args = `${Math.round(p.left)}:${p.tolAtr}:${p.minScore}`
    const s = {
      atr: getSeries(ds, `atr:${Math.round(p.atrPeriod)}`),
      zone: null, // { lo, mid, hi } the open position was taken at
    }
    for (const k of ['srSup', 'srSupLo', 'srSupHi', 'srRes', 'srResLo', 'srResHi']) s[k] = getSeries(ds, `${k}:${args}`)
    return s
  },

  signal(i, s, ds, p, prev) {
    const a = s.atr[i]
    const c = ds.close[i]
    if (prev === 0) s.zone = null
    if (!(a > 0)) return prev === 0 ? 0 : prev

    const z = s.zone
    if (p.mode === 'breakout') {
      if (prev > 0 && z) return c < z.hi || c >= z.hi + p.exitAtr * a ? 0 : 1
      if (prev < 0 && z) return c > z.lo || c <= z.lo - p.exitAtr * a ? 0 : -1
      if (i === 0) return 0
      const c0 = ds.close[i - 1]
      // Zones held on the previous bar: resistance above c0, support below it.
      if (s.srResHi[i - 1] >= c0 && c > s.srResHi[i - 1]) {
        s.zone = { lo: s.srResLo[i - 1], mid: s.srRes[i - 1], hi: s.srResHi[i - 1] }
        return 1
      }
      if (p.shortSide && s.srSupLo[i - 1] <= c0 && c < s.srSupLo[i - 1]) {
        s.zone = { lo: s.srSupLo[i - 1], mid: s.srSup[i - 1], hi: s.srSupHi[i - 1] }
        return -1
      }
      return 0
    }

    if (prev > 0 && z) return c < z.lo || c >= z.mid + p.exitAtr * a ? 0 : 1
    if (prev < 0 && z) return c > z.hi || c <= z.mid - p.exitAtr * a ? 0 : -1

    const nearSup = c >= s.srSupLo[i] && c - s.srSupHi[i] <= p.bandAtr * a
    const nearRes = c <= s.srResHi[i] && s.srResLo[i] - c <= p.bandAtr * a
    if (nearSup && !nearRes) {
      s.zone = { lo: s.srSupLo[i], mid: s.srSup[i], hi: s.srSupHi[i] }
      return 1
    }
    if (nearRes && !nearSup && p.shortSide) {
      s.zone = { lo: s.srResLo[i], mid: s.srRes[i], hi: s.srResHi[i] }
      return -1
    }
    return 0
  },
}
