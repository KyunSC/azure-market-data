/**
 * Support / resistance levels, shared by the chart and the backtest engine.
 *
 * Everything here is columnar (parallel arrays, epoch-second UTC `time`) and
 * causal: the value at bar `i` only uses bars `<= i`. The chart draws exactly
 * what the engine trades on, and `levels.test.mjs` checks that truncating the
 * data never changes an earlier bar's value.
 *
 * Four sources feed one scorer:
 *   - session levels   prior-day RTH high/low/close, overnight high/low, opening range
 *   - floor pivots     classic / camarilla / fibonacci from the prior day's HLC
 *   - swing pivots     N-bar fractal highs/lows, visible only once confirmed
 *   - chart extras     GEX walls and volume-profile nodes (chart only — the
 *                      engine has no columnar GEX strikes or profile)
 * `buildZones` clusters the candidates by price and scores each zone; a level
 * several independent sources agree on outranks one that only one source sees.
 */

import { tradingDay, etMinuteOfDay } from './backtest/time'

const NA = Number.NaN
const RTH_OPEN = 9 * 60 + 30
const RTH_CLOSE = 16 * 60
const GLOBEX_OPEN = 18 * 60

/** True when the bars are intraday (median spacing under a day). Session
 *  levels are meaningless on daily bars or on non-epoch times. */
export function isIntraday(time) {
  const n = time?.length || 0
  if (n < 2) return false
  const gaps = []
  for (let i = 1; i < n && gaps.length < 64; i++) {
    const g = time[i] - time[i - 1]
    if (Number.isFinite(g) && g > 0) gaps.push(g)
  }
  if (!gaps.length) return false
  gaps.sort((a, b) => a - b)
  return gaps[gaps.length >> 1] < 86400
}

const SESSION_KEYS = ['pdh', 'pdl', 'pdc', 'onh', 'onl', 'orh', 'orl']

/**
 * Per-bar session reference levels.
 *
 *   pdh/pdl/pdc  previous trading day's RTH (09:30–16:00 ET) high/low/close,
 *                falling back to the whole day when it had no RTH bars
 *   onh/onl      this trading day's pre-09:30 bars; emitted from 09:30 on,
 *                once the overnight range can no longer change
 *   orh/orl      first `orMinutes` of RTH; emitted once the window has closed
 *
 * Levels stop at the 18:00 ET Globex reopen, which starts a new trading day.
 */
export function sessionLevels(ds, { orMinutes = 30 } = {}) {
  const { time, high, low, close } = ds
  const n = close.length
  const out = {}
  for (const k of SESSION_KEYS) out[k] = new Float64Array(n).fill(NA)
  if (!isIntraday(time)) return out

  const orEnd = RTH_OPEN + orMinutes
  let day = null
  let prev = null // { h, l, c } of the previous trading day
  let cur = null

  const fresh = () => ({
    rthH: -Infinity, rthL: Infinity, rthC: NA,
    allH: -Infinity, allL: Infinity, allC: NA,
    onH: -Infinity, onL: Infinity,
    orH: -Infinity, orL: Infinity,
  })
  const summarize = (d) => (Number.isFinite(d.rthC)
    ? { h: d.rthH, l: d.rthL, c: d.rthC }
    : { h: d.allH, l: d.allL, c: d.allC })

  for (let i = 0; i < n; i++) {
    const t = time[i]
    if (!Number.isFinite(t)) continue
    const d = tradingDay(t)
    if (d !== day) {
      if (cur) prev = summarize(cur)
      day = d
      cur = fresh()
    }
    const m = etMinuteOfDay(t)
    const inDaySession = m >= RTH_OPEN && m < GLOBEX_OPEN // 09:30–18:00 ET
    const overnight = !inDaySession

    // Emit from state built by earlier bars (and this bar only where the
    // level is already closed to it).
    if (prev) {
      out.pdh[i] = prev.h
      out.pdl[i] = prev.l
      out.pdc[i] = prev.c
    }
    if (inDaySession && cur.onH > -Infinity) {
      out.onh[i] = cur.onH
      out.onl[i] = cur.onL
    }
    if (inDaySession && m >= orEnd && cur.orH > -Infinity) {
      out.orh[i] = cur.orH
      out.orl[i] = cur.orL
    }

    // Fold this bar in.
    const h = high[i]
    const l = low[i]
    cur.allH = Math.max(cur.allH, h)
    cur.allL = Math.min(cur.allL, l)
    cur.allC = close[i]
    if (m >= RTH_OPEN && m < RTH_CLOSE) {
      cur.rthH = Math.max(cur.rthH, h)
      cur.rthL = Math.min(cur.rthL, l)
      cur.rthC = close[i]
    }
    if (overnight) {
      cur.onH = Math.max(cur.onH, h)
      cur.onL = Math.min(cur.onL, l)
    }
    if (m >= RTH_OPEN && m < orEnd) {
      cur.orH = Math.max(cur.orH, h)
      cur.orL = Math.min(cur.orL, l)
    }
  }
  return out
}

export const PIVOT_KEYS = ['P', 'R1', 'R2', 'R3', 'S1', 'S2', 'S3']
export const PIVOT_METHODS = ['classic', 'camarilla', 'fibonacci']

/** Floor-trader pivots from prior-day high/low/close arrays (NaN in → NaN out). */
export function floorPivots(pdh, pdl, pdc, method = 'classic') {
  const n = pdh.length
  const out = {}
  for (const k of PIVOT_KEYS) out[k] = new Float64Array(n).fill(NA)
  for (let i = 0; i < n; i++) {
    const H = pdh[i], L = pdl[i], C = pdc[i]
    if (!(Number.isFinite(H) && Number.isFinite(L) && Number.isFinite(C))) continue
    const P = (H + L + C) / 3
    const R = H - L
    out.P[i] = P
    if (method === 'camarilla') {
      out.R1[i] = C + R * 1.1 / 12
      out.R2[i] = C + R * 1.1 / 6
      out.R3[i] = C + R * 1.1 / 4
      out.S1[i] = C - R * 1.1 / 12
      out.S2[i] = C - R * 1.1 / 6
      out.S3[i] = C - R * 1.1 / 4
    } else if (method === 'fibonacci') {
      out.R1[i] = P + 0.382 * R
      out.R2[i] = P + 0.618 * R
      out.R3[i] = P + R
      out.S1[i] = P - 0.382 * R
      out.S2[i] = P - 0.618 * R
      out.S3[i] = P - R
    } else {
      out.R1[i] = 2 * P - L
      out.S1[i] = 2 * P - H
      out.R2[i] = P + R
      out.S2[i] = P - R
      out.R3[i] = H + 2 * (P - L)
      out.S3[i] = L - 2 * (H - P)
    }
  }
  return out
}

/**
 * Fractal swing points: a high above the `left` bars before it and at least
 * the `right` bars after it (ties resolve to the first bar of a flat top).
 * `confirmedAt = idx + right` is the first bar that can know about it.
 */
export function swingPivots(high, low, left = 5, right = left) {
  const n = high.length
  const out = []
  for (let j = left; j < n - right; j++) {
    let isH = true
    let isL = true
    for (let k = j - left; k < j && (isH || isL); k++) {
      if (!(high[j] > high[k])) isH = false
      if (!(low[j] < low[k])) isL = false
    }
    for (let k = j + 1; k <= j + right && (isH || isL); k++) {
      if (!(high[j] >= high[k])) isH = false
      if (!(low[j] <= low[k])) isL = false
    }
    if (isH) out.push({ idx: j, price: high[j], kind: 'H', confirmedAt: j + right })
    if (isL) out.push({ idx: j, price: low[j], kind: 'L', confirmedAt: j + right })
  }
  return out
}

/** Relative weight of one candidate from each source. */
export const SOURCE_WEIGHTS = { pivot: 1, session: 1, floor: 0.5, vp: 1, gex: 1.5 }
/** Added once for each distinct source beyond the first in a zone. */
export const CONFLUENCE_BONUS = 1

/**
 * Cluster candidate levels into scored zones.
 *
 * candidates: [{ price, source, label?, idx? }] — `idx` (bar index) makes a
 * pivot decay with age; levels without one count at full weight.
 * Candidates are merged greedily in price order while within `tol` of the
 * cluster's running mean. Each zone is padded by `tol / 2` on both sides so a
 * single-level zone still has thickness.
 *
 * score = Σ weight·0.5^(age/halfLife) + CONFLUENCE_BONUS·(distinct sources − 1)
 */
export function buildZones(candidates, { tol, now = 0, halfLife = 250 } = {}) {
  if (!(tol > 0)) return []
  const items = candidates
    .filter((c) => Number.isFinite(c.price))
    .sort((a, b) => a.price - b.price)
  const zones = []
  let cl = null
  const flush = () => {
    if (!cl) return
    const sources = [...cl.sources]
    const score = cl.weight + CONFLUENCE_BONUS * (sources.length - 1)
    zones.push({
      lo: cl.min - tol / 2,
      hi: cl.max + tol / 2,
      mid: cl.sumPW / cl.sumW,
      score,
      touches: cl.touches,
      sources,
      labels: cl.labels,
      firstIdx: cl.firstIdx,
    })
    cl = null
  }
  for (const c of items) {
    const base = SOURCE_WEIGHTS[c.source] ?? 1
    const w = c.idx != null && c.source === 'pivot'
      ? base * Math.pow(0.5, Math.max(0, now - c.idx) / halfLife)
      : base
    if (cl && c.price - cl.sumPW / cl.sumW > tol) flush()
    if (!cl) {
      cl = { min: c.price, max: c.price, sumPW: 0, sumW: 0, weight: 0, touches: 0, sources: new Set(), labels: [], firstIdx: Infinity }
    }
    cl.max = c.price
    // Weight the mean by base weight only, so old pivots still anchor position.
    cl.sumPW += c.price * base
    cl.sumW += base
    cl.weight += w
    cl.sources.add(c.source)
    if (c.source === 'pivot') cl.touches++
    else if (c.label && !cl.labels.includes(c.label)) cl.labels.push(c.label)
    if (c.idx != null && c.idx < cl.firstIdx) cl.firstIdx = c.idx
  }
  flush()
  return zones
}

const SESSION_LABELS = { pdh: 'PDH', pdl: 'PDL', pdc: 'PDC', onh: 'ONH', onl: 'ONL', orh: 'ORH', orl: 'ORL' }

/**
 * Rolling S/R zones and, per bar, the nearest qualifying support (zone mid at
 * or below the close) and resistance (zone mid above it).
 *
 * Zones are rebuilt only when the candidate set changes — a pivot confirms or
 * ages out, or a session/floor level appears or moves — so tolerance
 * (`tolAtr × atr`) and pivot recency are evaluated at the rebuild bar. That
 * keeps a sweep cheap and is still causal.
 *
 * `atr` is passed in (the series layer's ATR) so the chart and the engine use
 * the same tolerance. Returns the per-bar arrays plus `last`, the candidates
 * and tolerance of the final rebuild, so the chart can re-score the current
 * zones with its extra (GEX / volume-profile) candidates.
 */
export function zoneSeries(ds, atr, {
  left = 5,
  right = left,
  tolAtr = 0.25,
  minScore = 1,
  lookback = 500,
  halfLife = lookback / 2,
  session = true,
  floor = true,
  pivotMethod = 'classic',
  orMinutes = 30,
} = {}) {
  const n = ds.close.length
  const keys = ['supMid', 'supLo', 'supHi', 'supScore', 'resMid', 'resLo', 'resHi', 'resScore']
  const out = {}
  for (const k of keys) out[k] = new Float64Array(n).fill(NA)

  const pivots = swingPivots(ds.high, ds.low, left, right)
  const sess = session || floor ? sessionLevels(ds, { orMinutes }) : null
  const piv = floor && sess ? floorPivots(sess.pdh, sess.pdl, sess.pdc, pivotMethod) : null

  let nextPivot = 0 // pivots[] is sorted by idx, hence by confirmedAt
  const active = []
  let zones = []
  let dirty = true
  let lastSig = ''
  let last = { candidates: [], tol: NA, now: 0, halfLife }

  for (let i = 0; i < n; i++) {
    while (nextPivot < pivots.length && pivots[nextPivot].confirmedAt <= i) {
      active.push(pivots[nextPivot++])
      dirty = true
    }
    while (active.length && active[0].idx < i - lookback) {
      active.shift()
      dirty = true
    }

    const fixed = []
    if (session && sess) {
      for (const k of SESSION_KEYS) {
        const v = sess[k][i]
        if (Number.isFinite(v)) fixed.push({ price: v, source: 'session', label: SESSION_LABELS[k] })
      }
    }
    if (piv) {
      for (const k of PIVOT_KEYS) {
        const v = piv[k][i]
        if (Number.isFinite(v)) fixed.push({ price: v, source: 'floor', label: k })
      }
    }
    const sig = fixed.map((c) => c.price).join(',')
    if (sig !== lastSig) {
      lastSig = sig
      dirty = true
    }

    if (dirty) {
      const tol = tolAtr * atr[i]
      if (tol > 0) {
        const candidates = active.map((p) => ({ price: p.price, source: 'pivot', idx: p.idx })).concat(fixed)
        zones = buildZones(candidates, { tol, now: i, halfLife })
        last = { candidates, tol, now: i, halfLife }
        dirty = false
      } else {
        zones = []
      }
    }

    const c = ds.close[i]
    let sup = null
    let res = null
    for (const z of zones) {
      if (z.score < minScore) continue
      if (z.mid <= c) sup = z // zones are price-ascending: last one wins
      else if (!res) res = z
    }
    if (sup) {
      out.supMid[i] = sup.mid; out.supLo[i] = sup.lo; out.supHi[i] = sup.hi; out.supScore[i] = sup.score
    }
    if (res) {
      out.resMid[i] = res.mid; out.resLo[i] = res.lo; out.resHi[i] = res.hi; out.resScore[i] = res.score
    }
  }
  out.last = last
  return out
}
