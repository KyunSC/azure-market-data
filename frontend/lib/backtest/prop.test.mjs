import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
const jiti = createJiti(import.meta.url)
const { runBacktest } = await jiti.import('./engine.js')
const { flatByFlags, etMinuteOfDay } = await jiti.import('./series.js')
const { simulateAccount } = await jiti.import('./prop/account.js')
const { resolvePlan } = await jiti.import('./prop/firms.js')
const { propSetup, attachProp } = await jiti.import('./prop/index.js')

const T0 = Date.parse('2026-06-01T14:00:00Z') / 1000
const DAY = 86400

function dataset(rows, time) {
  const col = k => rows.map(r => r[k])
  return { id: 't', symbol: 'NQ=F', interval: '5m', time: time || rows.map((_, i) => T0 + i * 300), open: col(0), high: col(1), low: col(2), close: col(3), volume: rows.map(() => 1) }
}
const always = dir => ({ id: 'always', signal: () => dir })
const mnq = (extra = {}) => ({ initialCapital: 50000, instrument: { pointValue: 2, tickSize: 0.25, contracts: 2, commissionPerSide: 0, slippageTicks: 0, priceScale: 1, ...extra } })

test('futures sizing: 10 points on 2 MNQ is $40, less per-side commission and tick slippage', () => {
  const rows = [[100, 100, 100, 100], [100, 100, 100, 100], [110, 110, 110, 110], [110, 110, 110, 110]]
  const gross = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: mnq(), risk: {} })
  assert.equal(gross.trades[0].pnl, 40)
  const net = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: mnq({ commissionPerSide: 0.5, slippageTicks: 1 }), risk: {} })
  // 1 tick each side = 0.5 pt × $2 × 2 contracts = $2; commission $0.50 × 2 × 2 legs = $2.
  assert.equal(net.trades[0].pnl, 36)
  assert.equal(net.metrics.finalEquity, 50036)
})

test('priceScale turns ETF points into futures points linearly', () => {
  const rows = [[100, 100, 100, 100], [100, 100, 100, 100], [101, 101, 101, 101], [101, 101, 101, 101]]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: mnq({ priceScale: 40 }), risk: {} })
  assert.equal(r.trades[0].pnl, 40 * 2 * 2)
})

test('without an instrument the engine result is unchanged and carries no bar extremes', () => {
  const rows = Array.from({ length: 12 }, (_, i) => [100 + i, 101 + i, 99 + i, 100.5 + i])
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: { slippageBps: 1, commissionPerTrade: 1 }, risk: {} })
  assert.equal(r.barLo, null)
  assert.ok(r.metrics.finalEquity > 100000)
})

test('bar extremes: long equity dips to the low and peaks at the high', () => {
  const rows = [[100, 100, 100, 100], [100, 105, 95, 100], [100, 100, 100, 100]]
  const r = runBacktest({ dataset: dataset(rows), strategy: always(1), params: {}, costs: mnq(), risk: {} })
  assert.equal(r.barLo[1], 50000 - 5 * 4)
  assert.equal(r.barHi[1], 50000 + 5 * 4)
})

test('flat-by cutoff is 16:45 New York time in both EDT and EST', () => {
  const edt = Date.parse('2026-07-15T20:45:00Z') / 1000 // 16:45 EDT
  const est = Date.parse('2026-01-15T21:45:00Z') / 1000 // 16:45 EST
  assert.equal(etMinuteOfDay(edt), 1005)
  assert.equal(etMinuteOfDay(est), 1005)
  const times = [-2, -1, 0, 1].map(k => edt + k * 300) // 16:35, 16:40, 16:45, 16:50
  const { end, blocked } = flatByFlags(times, 1005)
  assert.deepEqual(Array.from(end), [0, 1, 0, 0])
  assert.deepEqual(Array.from(blocked), [0, 0, 1, 1])
})

// ── account replay ────────────────────────────────────────────────────────

/** Day table from per-day [lo, hi, close] P&L (relative to the day's open),
 *  one bar per day, every day active. */
function days(list) {
  const n = list.length
  return {
    n,
    start: Int32Array.from(list.map((_, i) => i)),
    end: Int32Array.from(list.map((_, i) => i)),
    active: new Uint8Array(n).fill(1),
    time: new Float64Array(n),
    lo: Float64Array.from(list.map(d => d[0])),
    hi: Float64Array.from(list.map(d => d[1])),
    open: new Float64Array(n),
    close: Float64Array.from(list.map(d => d[2])),
  }
}
const seq = (t) => (k) => (k < t.n ? k : -1)
const plan = (p, extra = {}) => ({ ...resolvePlan({ plan: p, size: '50k', dll: true }), ...extra })

test('EOD trailing: an intraday high does not move the threshold, the close does', () => {
  // 50K, $2,000 max loss. Day 1 runs up $1,500 intraday but closes flat;
  // day 2 dips $1,900 — inside the original $2,000 even though it is $3,400
  // below the intraday peak.
  const t = days([[0, 1500, 0], [-1900, 0, -1900], [-200, 0, -200]])
  const a = simulateAccount({ days: t, next: seq(t), plan: plan('pro', { dailyLossLimit: null }) })
  assert.equal(a.outcome, 'failed')
  assert.equal(a.evalDays, 3) // breached on day 3: 50,000 − 1,900 − 200 ≤ 48,000
})

test('EOD trailing locks at start + $100', () => {
  // +2,500 EOD → threshold would be 50,500 but stops at 50,100.
  const t = days([[0, 2500, 2500], [-2350, 0, -2350], [-100, 0, -100]])
  const a = simulateAccount({ days: t, next: seq(t), plan: plan('pro', { dailyLossLimit: null, profitTarget: 1e9 }) })
  assert.equal(a.outcome, 'failed')
  assert.equal(a.evalDays, 3) // 52,500 − 2,350 = 50,150 survives; −100 → 50,050 ≤ 50,100
})

test('intraday trailing (Daily funded) trails the intraday peak', () => {
  const t = days([[0, 1500, 0], [-600, 0, -600]])
  const p = plan('daily', { hasEval: false, dailyLossLimit: null })
  const a = simulateAccount({ days: t, next: seq(t), plan: p })
  assert.equal(a.outcome, 'funded-breached') // peak 51,500 → threshold 49,500; 49,400 breaches
  const eod = simulateAccount({ days: t, next: seq(t), plan: { ...p, fundedDrawdown: 'eod' } })
  assert.equal(eod.outcome, 'funded-open')
})

test('soft daily loss limit freezes the day at the limit and trading resumes', () => {
  // DLL $1,200 on 50K Flex. Day 1's low is −1,500 but it would have closed −100:
  // the limit flattens it at −1,200. Max loss $2,000 is never touched.
  const t = days([[-1500, 0, -100], [0, 3000, 3000], [0, 1500, 1500]])
  const a = simulateAccount({ days: t, next: seq(t), plan: plan('flex', { evalConsistency: 0 }) })
  assert.equal(a.dllHits, 1)
  assert.equal(a.outcome, 'funded-open')
  assert.equal(a.evalDays, 3) // −1,200 + 3,000 + 1,500 = 3,300 ≥ 3,000 target
})

test('eval consistency postpones the pass instead of failing it', () => {
  // Flex 50%: one +3,000 day is 100% of profit; passes once a second day dilutes it.
  const t = days([[0, 3000, 3000], [0, 500, 500], [0, 2600, 2600], [0, 0, 0]])
  const a = simulateAccount({ days: t, next: seq(t), plan: plan('flex') })
  assert.equal(a.evalDays, 3)
  assert.notEqual(a.outcome, 'failed')
})

test('funded payouts are capped, split 90/10, reduce the balance and graduate', () => {
  // Pro 50K funded: buffer 52,100, 40% consistency, first cap 2,000 then 2,500.
  const p = plan('pro', { hasEval: false, dailyLossLimit: null, maxPayouts: 2 })
  const t = days(Array.from({ length: 20 }, () => [0, 1000, 1000]))
  const a = simulateAccount({ days: t, next: seq(t), plan: p })
  assert.equal(a.outcome, 'graduated')
  assert.deepEqual(a.payouts, [900, 2500])
  assert.equal(a.take, 0.9 * 3400)
})

test('propSetup clamps contracts to the plan limit and scales ETF bars', () => {
  const s = propSetup({ prop: { plan: 'flex', size: '50k', dll: true, contract: 'NQ', contracts: 99, ratio: { QQQ: 40 } }, symbol: 'QQQ', costs: {}, risk: {} })
  assert.equal(s.contracts, 4)
  assert.equal(s.costs.instrument.priceScale, 40)
  assert.equal(s.costs.initialCapital, 50000)
  assert.equal(s.risk.flatByEt, 1005)
  assert.ok(propSetup({ prop: { contract: 'MNQ' }, symbol: 'BTC-USD', costs: {}, risk: {} }).error)
})

test('end-to-end: a steady winner passes evaluations; the fee bounds the loss of a loser', () => {
  const time = []
  const rows = []
  for (let d = 0; d < 30; d++) {
    for (let b = 0; b < 6; b++) {
      time.push(T0 + d * DAY + b * 300)
      const p = 20000 + d * 60 + b * 10
      rows.push([p, p + 5, p - 5, p + 10])
    }
  }
  const ds = dataset(rows, time)
  for (const [dir, check] of [[1, (h) => h.passRate > 0.5], [-1, (h) => h.passRate === 0 && h.ev === -h.cost]]) {
    const s = propSetup({ prop: { plan: 'flex', size: '50k', dll: true, contract: 'NQ', contracts: 2 }, symbol: 'NQ=F', costs: {}, risk: {} })
    const r = runBacktest({ dataset: ds, strategy: always(dir), params: {}, costs: s.costs, risk: s.risk })
    attachProp(r, ds, { prop: s.plan, costs: s.costs }, { paths: 50 })
    assert.ok(check(r.prop.historical), JSON.stringify(r.prop.historical.outcomes))
    assert.equal(r.prop.days, 30)
  }
})
