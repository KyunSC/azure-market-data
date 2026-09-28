import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { runBacktest } = await jiti.import('./engine.js')

const T0 = Date.parse('2026-06-01T14:00:00Z') / 1000

/** Bars from [open, high, low, close] rows, 5 minutes apart in one session. */
function dataset(rows) {
  const col = k => rows.map(r => r[k])
  return { id: 't', symbol: 'T', interval: '5m', time: rows.map((_, i) => T0 + i * 300), open: col(0), high: col(1), low: col(2), close: col(3), volume: rows.map(() => 1) }
}
const frictionless = { slippageBps: 0, commissionPerTrade: 0 }
const always = dir => ({ id: 'always', signal: () => dir })

test('a stopped-out long does not re-enter while the signal is still long', () => {
  // Steady 1%-per-bar decline; an always-long strategy with a 0.5% stop.
  const rows = []
  let p = 100
  for (let i = 0; i < 12; i++) { rows.push([p, p, p * 0.99, p * 0.99]); p *= 0.99 }
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: frictionless, risk: { stopPct: 0.5 } })
  assert.equal(r.trades.length, 1)
  assert.equal(r.trades[0].reason, 'stop')
})

test('re-entry resumes once the signal leaves the stopped direction', () => {
  const rows = []
  let p = 100
  for (let i = 0; i < 10; i++) { rows.push([p, p, p * 0.99, p * 0.99]); p *= 0.99 }
  // Long on bars 0-2, flat on bar 3, long again afterwards.
  const strategy = { id: 'pulse', signal: i => (i === 3 ? 0 : 1) }
  const r = runBacktest({ dataset: dataset(rows), strategy, params: {}, costs: frictionless, risk: { stopPct: 0.5 } })
  assert.deepEqual(r.trades.map(t => t.entryIdx), [1, 5])
  assert.ok(r.trades.every(t => t.reason === 'stop'))
})

test('a time exit also waits for a fresh signal', () => {
  const rows = Array.from({ length: 10 }, () => [100, 101, 99, 100])
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: frictionless, risk: { maxBars: 2 } })
  assert.equal(r.trades.length, 1)
  assert.equal(r.trades[0].reason, 'time')
})

test('a long stop that the open gaps through fills at the open, not the stop', () => {
  const rows = [
    [100, 100, 100, 100],
    [100, 100.5, 99.5, 100], // entry at this open
    [100, 100.5, 99.5, 100],
    [90, 91, 89, 90], // gaps through a 2% stop at 98
    [90, 91, 89, 90],
  ]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: frictionless, risk: { stopPct: 2 } })
  const t = r.trades[0]
  assert.equal(t.reason, 'stop')
  assert.equal(t.exitIdx, 3)
  assert.equal(t.exitPrice, 90)
})

test('a short stop that the open gaps through fills at the open', () => {
  const rows = [
    [100, 100, 100, 100],
    [100, 100.5, 99.5, 100],
    [110, 111, 109, 110], // gaps through a 2% stop at 102
    [110, 111, 109, 110],
  ]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(-1), params: {}, costs: frictionless, risk: { stopPct: 2 } })
  assert.equal(r.trades[0].reason, 'stop')
  assert.equal(r.trades[0].exitPrice, 110)
})

test('an intrabar stop still fills at the stop price', () => {
  const rows = [
    [100, 100, 100, 100],
    [100, 100.5, 99.5, 100],
    [99.5, 99.8, 97, 97.5], // opens above the 98 stop, trades through it
    [97.5, 98, 97, 97.5],
  ]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: frictionless, risk: { stopPct: 2 } })
  assert.equal(r.trades[0].reason, 'stop')
  assert.equal(r.trades[0].exitPrice, 98)
})

test('a target the open gaps beyond fills at the open', () => {
  const rows = [
    [100, 100, 100, 100],
    [100, 100.5, 99.5, 100],
    [105, 106, 104, 105], // gaps beyond a 2% target at 102
    [105, 106, 104, 105],
  ]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: frictionless, risk: { targetPct: 2 } })
  assert.equal(r.trades[0].reason, 'target')
  assert.equal(r.trades[0].exitPrice, 105)
})

test('a stop in one session does not veto entries in the next', () => {
  const day = 86400
  const rows = [
    [100, 100, 100, 100],
    [100, 100, 97, 97], // stopped at 98 (2%)
    [97, 97, 96, 96], // last bar of session 1
    [96, 96.5, 95.5, 96], // session 2
    [96, 96.5, 95.5, 96],
    [96, 96.5, 95.5, 96],
  ]
  const ds = dataset(rows)
  ds.time = ds.time.map((t, i) => (i >= 3 ? t + day : t))
  const r = runBacktest({ dataset: ds, strategy: always(1), params: {}, costs: frictionless, risk: { stopPct: 2, flatAtSessionEnd: true } })
  assert.deepEqual(r.trades.map(t => [t.entryIdx, t.reason]), [[1, 'stop'], [4, 'session']])
})

test('walk-forward leaves an embargo between every training window and its test slice', async () => {
  const { runWalkForward } = await jiti.import('./analytics.js')
  const rows = Array.from({ length: 900 }, (_, i) => {
    const p = 100 + 5 * Math.sin(i / 25)
    return [p, p + 0.2, p - 0.2, p]
  })
  const ds = dataset(rows)
  const params = { fast: 5, slow: 20, maType: 'sma', shortSide: true }
  const costs = { ...frictionless, initialCapital: 100000 }
  const wf = runWalkForward({ dataset: ds, strategyId: 'smaCross', params, costs, risk: {}, nSplits: 3 })
  assert.equal(wf.embargoBars, 78) // one 5m session by default
  for (const f of wf.folds) assert.equal(f.testStart - f.trainEnd - 1, 78)

  const none = runWalkForward({ dataset: ds, strategyId: 'smaCross', params, costs, risk: {}, nSplits: 3, embargoBars: 0 })
  for (const f of none.folds) assert.equal(f.trainEnd, f.testStart - 1)
})

test('a stop in one session does not veto the next even when positions carry overnight', () => {
  const day = 86400
  const rows = [
    [100, 100, 100, 100],
    [100, 100, 97, 97], // stopped at 98 (2%)
    [97, 97, 96, 96], // last bar of session 1
    [96, 96.5, 95.5, 96], // session 2: re-entry allowed from here
    [96, 96.5, 95.5, 96],
    [96, 96.5, 95.5, 96],
  ]
  const ds = dataset(rows)
  ds.time = ds.time.map((t, i) => (i >= 3 ? t + day : t))
  const r = runBacktest({ dataset: ds, strategy: always(1), params: {}, costs: frictionless, risk: { stopPct: 2 } })
  assert.deepEqual(r.trades.map(t => [t.entryIdx, t.reason]), [[1, 'stop'], [3, 'end-of-data']])
})

test('futures are annualised on their own bars per day, not the RTH count', async () => {
  const { datasetPeriodsPerYear, periodsPerYear } = await jiti.import('./metrics.js')
  // Five 23-hour Globex sessions of 5m bars: 18:00–17:00 ET (22:00–21:00 UTC in EDT).
  const start = Date.parse('2026-06-07T22:00:00Z') / 1000
  const time = []
  for (let d = 0; d < 5; d++) for (let b = 0; b < 276; b++) time.push(start + d * 86400 + b * 300)
  assert.equal(datasetPeriodsPerYear({ interval: '5m', time }), 252 * 276)
  const rth = dataset(Array.from({ length: 10 }, () => [100, 100, 100, 100]))
  assert.equal(datasetPeriodsPerYear(rth), periodsPerYear('5m')) // too few days: label fallback
})

test('holdout split never cuts a Globex session at UTC midnight', async () => {
  const { holdoutSplit } = await jiti.import('./stats.js')
  const { tradingDay } = await jiti.import('./series.js')
  const start = Date.parse('2026-06-07T22:00:00Z') / 1000
  const time = []
  for (let d = 0; d < 4; d++) for (let b = 0; b < 276; b++) time.push(start + d * 86400 + b * 300)
  const { cut, holdoutBars } = holdoutSplit(time, 25)
  assert.ok(holdoutBars > 0)
  assert.notEqual(tradingDay(time[cut]), tradingDay(time[cut - 1]))
  assert.equal(new Date(time[cut] * 1000).getUTCHours(), 22) // a session open, not 00:00 UTC
  // One session only: no clean split, so no holdout rather than a mid-day one.
  assert.equal(holdoutSplit(time.slice(0, 276), 25).holdoutBars, 0)
})

test('walk-forward folds stay inside the window and after the longest warmup', async () => {
  const { runWalkForward } = await jiti.import('./analytics.js')
  const rows = Array.from({ length: 1200 }, (_, i) => {
    const p = 100 + 5 * Math.sin(i / 25)
    return [p, p + 0.2, p - 0.2, p]
  })
  const ds = dataset(rows)
  const params = { fast: 5, slow: 20, maType: 'sma', shortSide: true }
  const costs = { ...frictionless, initialCapital: 100000 }
  const wf = runWalkForward({
    dataset: ds, strategyId: 'smaCross', params, costs, risk: {}, nSplits: 3, embargoBars: 0,
    xKey: 'slow', xValues: [20, 300], window: { start: 400, end: 1100 },
  })
  for (const f of wf.folds) {
    assert.ok(f.trainStart >= 400 && f.trainStart >= 300, `trainStart ${f.trainStart}`)
    assert.ok(f.trainEnd > f.trainStart)
    assert.ok(f.testEnd <= 1100)
  }
  assert.throws(() => runWalkForward({
    dataset: ds, strategyId: 'smaCross', params, costs, risk: {}, nSplits: 3,
    xKey: 'slow', xValues: [20, 300], window: { start: 0, end: 380 },
  }), /too short/)
})

test('futures VWAP anchors at the Globex open, not UTC midnight', async () => {
  const { vwap } = await jiti.import('./series.js')
  // 22:00 UTC (18:00 ET open) through 02:00 UTC, then the next session's open.
  const start = Date.parse('2026-06-07T22:00:00Z') / 1000
  const time = [0, 1, 2, 3, 4].map((h) => start + h * 3600).concat(start + 86400)
  const px = [100, 102, 104, 106, 108, 120]
  const ds = { time, high: px, low: px, close: px, volume: px.map(() => 1) }
  const v = vwap(ds)
  assert.equal(v[3], 103) // 01:00 UTC still averages from 22:00, no midnight reset
  assert.equal(v[4], 104)
  assert.equal(v[5], 120) // next session starts fresh
})
