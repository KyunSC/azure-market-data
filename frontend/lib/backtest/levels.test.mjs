import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { sessionLevels, floorPivots, swingPivots, buildZones, zoneSeries } = await jiti.import('../levels.js')
const { atr, getSeries } = await jiti.import('./series.js')
const { runBacktest } = await jiti.import('./engine.js')
const { default: srLevels } = await jiti.import('./strategies/srLevels.js')
const { defaultParams } = await jiti.import('./strategies/index.js')

// June 2026 is EDT: ET = UTC − 4h.
const et = (day, hh, mm) => Date.UTC(2026, 5, day, hh + 4, mm) / 1000

/** 5m bars from [startEt, endEt) with a flat 100 ± 0.5 body; `shape(t)` may
 *  override { h, l, c } for particular bars. */
function bars(ranges, shape = () => null) {
  const rows = []
  for (const [from, to] of ranges) {
    for (let t = from; t < to; t += 300) {
      const s = shape(t) || {}
      const c = s.c ?? 100
      rows.push({ time: t, open: c, high: s.h ?? c + 0.5, low: s.l ?? c - 0.5, close: c })
    }
  }
  return {
    time: rows.map(r => r.time), open: rows.map(r => r.open), high: rows.map(r => r.high),
    low: rows.map(r => r.low), close: rows.map(r => r.close), volume: rows.map(() => 1),
  }
}
const at = (ds, t) => ds.time.indexOf(t)

// Day A: RTH Mon Jun 1 plus a post-close hour. Day B: Globex from 18:00 ET Mon
// through Tue RTH.
const FUT_RANGES = [
  [et(1, 9, 30), et(1, 17, 0)],
  [et(1, 18, 0), et(2, 16, 0)],
]
function futShape(t) {
  if (t === et(1, 11, 0)) return { h: 110 }
  if (t === et(1, 14, 0)) return { l: 90 }
  if (t === et(1, 15, 55)) return { c: 100.25 }
  if (t === et(1, 16, 30)) return { h: 120 } // after the RTH close: not part of PDH
  if (t === et(2, 2, 0)) return { h: 105 }
  if (t === et(2, 4, 0)) return { l: 95 }
  if (t === et(2, 9, 40)) return { h: 104 }
  if (t === et(2, 9, 50)) return { l: 96 }
  return null
}

test('session levels: prior-day RTH HLC, overnight after 09:30, opening range after it closes', () => {
  const ds = bars(FUT_RANGES, futShape)
  const lv = sessionLevels(ds, { orMinutes: 30 })

  assert.ok(Number.isNaN(lv.pdh[at(ds, et(1, 12, 0))]), 'no prior day for the first day')

  const globex = at(ds, et(1, 20, 0))
  assert.equal(lv.pdh[globex], 110)
  assert.equal(lv.pdl[globex], 90)
  assert.equal(lv.pdc[globex], 100.25)
  assert.ok(Number.isNaN(lv.onh[globex]), 'overnight range still forming')

  const open = at(ds, et(2, 9, 30))
  assert.equal(lv.onh[open], 105)
  assert.equal(lv.onl[open], 95)
  assert.ok(Number.isNaN(lv.orh[open]))
  assert.ok(Number.isNaN(lv.orh[at(ds, et(2, 9, 55))]), 'opening range still forming')

  const ten = at(ds, et(2, 10, 0))
  assert.equal(lv.orh[ten], 104)
  assert.equal(lv.orl[ten], 96)
})

test('session levels: RTH-only (ETF) data has no overnight levels', () => {
  const ds = bars([[et(1, 9, 30), et(1, 16, 0)], [et(2, 9, 30), et(2, 16, 0)]], futShape)
  const lv = sessionLevels(ds)
  assert.ok(lv.onh.every(Number.isNaN))
  assert.equal(lv.pdh[at(ds, et(2, 12, 0))], 110)
})

test('session levels are empty on daily bars', () => {
  const n = 10
  const time = Array.from({ length: n }, (_, i) => et(1, 0, 0) + i * 86400)
  const px = new Array(n).fill(100)
  const lv = sessionLevels({ time, high: px, low: px, close: px })
  assert.ok(lv.pdh.every(Number.isNaN))
})

test('floor pivots match hand-computed values', () => {
  const one = (m) => floorPivots([110], [90], [100], m)
  const c = one('classic')
  assert.deepEqual([c.P[0], c.R1[0], c.S1[0], c.R2[0], c.S2[0], c.R3[0], c.S3[0]], [100, 110, 90, 120, 80, 130, 70])
  const cam = one('camarilla')
  assert.ok(Math.abs(cam.R1[0] - (100 + 22 / 12)) < 1e-9)
  assert.ok(Math.abs(cam.S3[0] - (100 - 22 / 4)) < 1e-9)
  const fib = one('fibonacci')
  assert.ok(Math.abs(fib.R1[0] - 107.64) < 1e-9)
  assert.ok(Math.abs(fib.S2[0] - 87.64) < 1e-9)
  assert.ok(Number.isNaN(floorPivots([NaN], [90], [100]).P[0]))
})

test('a swing pivot is only confirmed `right` bars later', () => {
  const high = [1, 2, 5, 2, 1, 1, 1]
  const low = [0, 1, 4, 1, 0.5, 0.5, 0.5]
  const hs = swingPivots(high, low, 2, 2).filter(p => p.kind === 'H')
  assert.deepEqual(hs, [{ idx: 2, price: 5, kind: 'H', confirmedAt: 4 }])
})

test('zones: nearby pivots merge, and a coincident session level raises the score', () => {
  const pivots = [{ price: 100, source: 'pivot', idx: 10 }, { price: 100.2, source: 'pivot', idx: 12 }, { price: 110, source: 'pivot', idx: 11 }]
  const z = buildZones(pivots, { tol: 0.5, now: 12, halfLife: 1e9 })
  assert.equal(z.length, 2)
  assert.equal(z[0].touches, 2)
  assert.ok(z[0].lo <= 100 && z[0].hi >= 100.2)

  const withPdl = buildZones([...pivots, { price: 100.1, source: 'session', label: 'PDL' }], { tol: 0.5, now: 12, halfLife: 1e9 })
  assert.equal(withPdl.length, 2)
  assert.ok(withPdl[0].score > z[0].score + 1, 'weight plus a confluence bonus')
  assert.deepEqual(withPdl[0].labels, ['PDL'])
})

/** Seeded random walk over three futures sessions. */
function walk(seed = 7) {
  let x = seed
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648)
  let p = 100
  return bars([[et(1, 9, 30), et(1, 17, 0)], [et(1, 18, 0), et(2, 17, 0)], [et(2, 18, 0), et(3, 16, 0)]], () => {
    p += (rnd() - 0.5) * 0.8
    const h = p + rnd() * 0.4
    const l = p - rnd() * 0.4
    return { c: p, h, l }
  })
}

test('no look-ahead: truncating the data never changes an earlier bar', () => {
  const full = walk()
  const n = full.close.length
  const zFull = zoneSeries(full, atr(full, 14), { left: 4, tolAtr: 0.3, minScore: 0.5 })
  const sFull = sessionLevels(full)
  for (const k of [60, 200, 333, n - 50]) {
    const cut = Object.fromEntries(Object.entries(full).map(([key, v]) => [key, v.slice(0, k)]))
    const z = zoneSeries(cut, atr(cut, 14), { left: 4, tolAtr: 0.3, minScore: 0.5 })
    const s = sessionLevels(cut)
    for (const key of ['supMid', 'supScore', 'resMid', 'resScore']) {
      assert.deepEqual(Array.from(z[key]), Array.from(zFull[key].slice(0, k)), `${key} @ ${k}`)
    }
    for (const key of ['pdh', 'onh', 'orl']) {
      assert.deepEqual(Array.from(s[key]), Array.from(sFull[key].slice(0, k)), `${key} @ ${k}`)
    }
  }
  assert.ok(zFull.supMid.some(Number.isFinite) && zFull.resMid.some(Number.isFinite), 'zones actually formed')
})

test('series keys resolve the level calculators', () => {
  const ds = walk()
  const i = at(ds, et(2, 12, 0))
  assert.equal(getSeries(ds, 'pdh')[i], sessionLevels(ds).pdh[i])
  const piv = getSeries(ds, 'piv:classic:R1')
  assert.ok(Number.isFinite(piv[i]))
  const sup = getSeries(ds, 'srSup:4:0.3:0.5')
  const lo = getSeries(ds, 'srSupLo:4:0.3:0.5')
  assert.ok(Number.isFinite(sup[i]) && lo[i] <= sup[i])
  assert.ok(sup[i] <= ds.close[i])
})

/** Hand-built strategy state: one support zone at 100 and one resistance zone at 102. */
function stub(close, sup = [99.9, 100, 100.1], res = [101.9, 102, 102.1]) {
  const n = close.length
  const fill = v => new Array(n).fill(v)
  return {
    ds: { close },
    s: {
      atr: fill(1), zone: null,
      srSupLo: fill(sup[0]), srSup: fill(sup[1]), srSupHi: fill(sup[2]),
      srResLo: fill(res[0]), srRes: fill(res[1]), srResHi: fill(res[2]),
    },
  }
}

test('srLevels fade: buys just above support, exits when the level fails', () => {
  const p = defaultParams('srLevels')
  const { ds, s } = stub([100.2, 100.3, 99.8])
  assert.equal(srLevels.signal(0, s, ds, p, 0), 1)
  assert.equal(srLevels.signal(1, s, ds, p, 1), 1)
  assert.equal(srLevels.signal(2, s, ds, p, 1), 0, 'close below the zone low')
})

test('srLevels fade: takes profit exitAtr past the zone mid, shorts under resistance', () => {
  const p = defaultParams('srLevels')
  const { ds, s } = stub([100.2, 101.05, 101.95])
  assert.equal(srLevels.signal(0, s, ds, p, 0), 1)
  assert.equal(srLevels.signal(1, s, ds, p, 1), 0, '100 + 1 ATR reached')
  assert.equal(srLevels.signal(2, s, ds, p, 0), -1)
  assert.equal(srLevels.signal(2, s, ds, { ...p, shortSide: false }, 0), 0)
})

test('srLevels breakout: goes with a close through resistance, exits back inside', () => {
  const p = { ...defaultParams('srLevels'), mode: 'breakout' }
  const { ds, s } = stub([101.5, 102.3, 102.05])
  assert.equal(srLevels.signal(0, s, ds, p, 0), 0)
  assert.equal(srLevels.signal(1, s, ds, p, 0), 1)
  assert.equal(srLevels.signal(2, s, ds, p, 1), 0, 'back inside the zone')
})

test('srLevels runs through the engine and only enters near a zone', () => {
  const ds = { id: 'w', symbol: 'W', interval: '5m', ...walk(11) }
  const params = { ...defaultParams('srLevels'), left: 4, minScore: 0.5 }
  const r = runBacktest({ dataset: ds, strategy: srLevels, params, costs: { slippageBps: 0, commissionPerTrade: 0 } })
  assert.ok(r.trades.length > 0, 'the walk produces some trades')
  const a = getSeries(ds, 'atr:14')
  const sup = getSeries(ds, 'srSupHi:4:0.25:0.5')
  const res = getSeries(ds, 'srResLo:4:0.25:0.5')
  for (const t of r.trades) {
    const i = t.entryIdx - 1 // signal bar; the fill is one bar later
    const band = params.bandAtr * a[i] + 1e-9
    const nearSup = ds.close[i] - sup[i] <= band
    const nearRes = res[i] - ds.close[i] <= band
    assert.ok(t.side === 'long' ? nearSup : nearRes, `trade at ${t.entryIdx} entered away from its zone`)
  }
})
