/** Number formatting for the terminal. Everything is fixed-width and
 *  tabular-nums so columns line up without a table layout. */

export const fmtNum = (v, dp = 2) =>
  v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(dp)

export const fmtSigned = (v, dp = 2) => {
  if (!Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`
}

export const fmtPct = (v, dp = 2) => {
  if (!Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(dp)}%`
}

export const fmtPctAbs = (v, dp = 1) =>
  Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—'

export const fmtMoney = (v, dp = 0) => {
  if (!Number.isFinite(v)) return '—'
  const sign = v < 0 ? '-' : ''
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

export const fmtMoneySigned = (v, dp = 0) => {
  if (!Number.isFinite(v)) return '—'
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}

export const fmtCompact = (v) => {
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`
  return v.toFixed(a < 10 ? 2 : 0)
}

export const fmtRatio = (v) => {
  if (!Number.isFinite(v)) return v === Infinity ? '∞' : '—'
  return v.toFixed(2)
}

const TS_OPTS = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }

export const fmtTime = (epochSeconds) =>
  Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toLocaleString(undefined, { ...TS_OPTS, timeZone: 'America/New_York' })
    : '—'

export const fmtDate = (epochSeconds) =>
  Number.isFinite(epochSeconds)
    ? new Date(epochSeconds * 1000).toLocaleDateString(undefined, { month: '2-digit', day: '2-digit', timeZone: 'America/New_York' })
    : '—'

export const fmtDateRange = (startMs, endMs) => {
  if (!startMs || !endMs) return '—'
  const o = { month: '2-digit', day: '2-digit', timeZone: 'America/New_York' }
  return `${new Date(startMs).toLocaleDateString(undefined, o)}→${new Date(endMs).toLocaleDateString(undefined, o)}`
}

/** Sign class used across every panel: green up, red down, dim at zero. */
export const signClass = (v) => (v > 0 ? 'text-pos' : v < 0 ? 'text-neg' : 'text-dim')

/** Parameter values for labels: no trailing zeros, no 4-decimal noise from the
 *  sweep's linear axis (1.0833 → 1.08). */
export const fmtParam = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return String(v)
  return String(Number(v.toPrecision(3)))
}
