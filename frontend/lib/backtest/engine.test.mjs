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
