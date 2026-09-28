/**
 * Session clock shared by the series layer and the level calculators. Kept in
 * its own module so `lib/levels.js` can use it without importing `series.js`,
 * which itself imports the level calculators.
 */

/**
 * Trading-day number for a bar time (epoch seconds). The day rolls at 22:00
 * UTC, not midnight: that lands inside CME's daily halt in both EDT (21–22 UTC)
 * and EST (22–23 UTC), so a Globex session from 18:00 ET to 17:00 ET is one
 * day, and it sits after the equity close (20:00/21:00 UTC), so RTH days are
 * unchanged.
 */
export function tradingDay(t) {
  return Math.floor((t + 7200) / 86400)
}

const etOffsetCache = new Map()
const etFormat = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
  : null

/** Minutes to add to UTC to get New York wall time (-240 in EDT, -300 in EST).
 *  Cached per UTC hour — DST switches on the hour, and a year of 5m bars
 *  would otherwise be ~20k Intl calls per backtest. */
function etOffsetMinutes(t) {
  const hour = Math.floor(t / 3600)
  const hit = etOffsetCache.get(hour)
  if (hit !== undefined) return hit
  const at = hour * 3600
  const parts = Object.fromEntries(etFormat.formatToParts(new Date(at * 1000)).map((p) => [p.type, p.value]))
  const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute) / 1000
  const off = Math.round((wall - at) / 60)
  etOffsetCache.set(hour, off)
  return off
}

/** Minute of the New York day for a bar time (epoch seconds). */
export function etMinuteOfDay(t) {
  const m = Math.floor(t / 60) + etOffsetMinutes(t)
  return ((m % 1440) + 1440) % 1440
}
