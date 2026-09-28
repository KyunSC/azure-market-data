import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
import { makeFetch, verdict, evaluateDataset, toMarkdown, breakEven, isTransient, assignVerdicts } from '../../scripts/nightly-backtest.mjs'

const jiti = createJiti(import.meta.url)
const { loadResearchDataset } = await jiti.import('./datasets.js')

const row = (holdout, research = {}, breakEvenBps = 5) => ({
  holdout: { nTrades: 20, totalReturn: 0.02, familyCi: [0.1, 2], ...holdout },
  research: { dsr: 0.97, ...research },
  breakEvenBps,
})

test('verdict: every check must pass for CANDIDATE', () => {
  assert.equal(verdict(row({})), 'CANDIDATE')
  assert.equal(verdict(row({ nTrades: 9 })), 'INSUFFICIENT')
  assert.equal(verdict(row({ totalReturn: 0 })), 'NO EDGE')
  assert.equal(verdict(row({ totalReturn: -0.01 })), 'NO EDGE')
  assert.equal(verdict(row({ familyCi: [-0.1, 2] })), 'WEAK')
  assert.equal(verdict(row({}, { dsr: 0.94 })), 'WEAK')
  assert.equal(verdict(row({}, {}, 1.5)), 'WEAK')
  assert.equal(verdict(row({}, { dsr: Number.NaN })), 'WEAK')
})

test('research-plane run: every strategy reports a holdout disjoint from its sweep', async () => {
  const original = globalThis.fetch
  globalThis.fetch = makeFetch({ apiBase: null })
  try {
    const ds = await loadResearchDataset({ symbol: 'QQQ', example: true })
    const rows = evaluateDataset(ds)
    assert.ok(rows.length >= 5)
    for (const r of rows) {
      assert.equal(r.error, undefined, `${r.strategy}: ${r.error}`)
      assert.ok(Number.isFinite(r.holdout.sharpe), r.strategy)
      assert.ok(r.research.bars <= ds.close.length - r.holdout.bars, r.strategy)
      assert.ok(r.research.trials > 1, r.strategy)
      assert.ok(['CANDIDATE', 'WEAK', 'NO EDGE', 'INSUFFICIENT'].includes(r.verdict))
    }
    const md = toMarkdown({
      generatedAt: new Date().toISOString(), engineVersion: '2', holdoutPct: 25,
      costs: { slippageBps: 1.5, commissionPerTrade: 0.5 },
      datasets: [{ label: 'QQQ 5m · research', stale: true, end: '2026-07-10T19:40:00Z', rows }],
    })
    assert.equal(md.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Verdict')).length, rows.length)
    assert.match(md, /stale/)
  } finally {
    globalThis.fetch = original
  }
})

test('the fetch shim never reaches the network for unrouted URLs', async () => {
  const f = makeFetch({ apiBase: null })
  await assert.rejects(f('https://example.com/x'), /Unrouted/)
  await assert.rejects(f('/api/historical'), /API_BASE/)
  assert.equal((await f('/backtest/missing.json')).status, 404)
})

test('the shim, once installed globally, forwards /api calls to the real fetch', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url) => { seen.push(url); return { ok: true } }
  globalThis.fetch = makeFetch({ apiBase: 'https://api.test/' })
  try {
    await globalThis.fetch('/api/historical?symbol=QQQ')
    assert.deepEqual(seen, ['https://api.test/api/historical?symbol=QQQ'])
  } finally {
    globalThis.fetch = original
  }
})

test('break-even interpolates between the last profitable rung and the first losing one', () => {
  const curve = [0, 0.5, 1, 2, 3].map((bps) => ({ slippageBps: bps, totalReturn: 0.016 - 0.01 * bps }))
  assert.ok(Math.abs(breakEven(curve) - 1.6) < 1e-9)
  assert.equal(breakEven([{ slippageBps: 0, totalReturn: -0.01 }]), 0)
  assert.equal(breakEven([{ slippageBps: 0, totalReturn: 0.01 }]), Infinity)
})

test('only transient fetch failures are retried', () => {
  assert.ok(isTransient(Object.assign(new Error('x'), { name: 'TimeoutError' })))
  assert.ok(isTransient(new TypeError('fetch failed')))
  assert.ok(isTransient(new Error('Historical fetch failed (503)')))
  assert.ok(isTransient(new Error('Historical service temporarily unavailable — retry shortly')))
  assert.ok(!isTransient(new Error('Historical fetch failed (404)')))
  assert.ok(!isTransient(new Error('No 5m bars stored for NQ=F over 1mo')))
})

test('family-wise CIs widen with the number of rows judged together', () => {
  const mk = () => ({ holdout: { nTrades: 20, totalReturn: 0.02, sr: 0.03, se: 0.01, periodsPerYear: 252 }, research: { dsr: 0.99 }, breakEvenBps: 5 })
  const one = [mk()]
  assignVerdicts(one)
  const many = Array.from({ length: 50 }, mk)
  assignVerdicts(many)
  assert.equal(one[0].verdict, 'CANDIDATE') // z = 1.96: 0.03 - 0.0196 > 0
  assert.equal(many[0].verdict, 'WEAK') // z ≈ 3.29: 0.03 - 0.0329 < 0
  assert.ok(many[0].holdout.familyCi[0] < one[0].holdout.familyCi[0])
})
