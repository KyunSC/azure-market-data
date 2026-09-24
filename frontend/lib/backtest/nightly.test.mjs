import test from 'node:test'
import assert from 'node:assert/strict'
import { createJiti } from 'jiti'
import { makeFetch, verdict, evaluateDataset, toMarkdown } from '../../scripts/nightly-backtest.mjs'

const jiti = createJiti(import.meta.url)
const { loadResearchDataset } = await jiti.import('./datasets.js')

const row = (holdout, research = {}, breakEvenBps = 5) => ({
  holdout: { nTrades: 20, totalReturn: 0.02, sharpeCi: [0.1, 2], ...holdout },
  research: { dsr: 0.97, ...research },
  breakEvenBps,
})

test('verdict: every check must pass for CANDIDATE', () => {
  assert.equal(verdict(row({})), 'CANDIDATE')
  assert.equal(verdict(row({ nTrades: 9 })), 'INSUFFICIENT')
  assert.equal(verdict(row({ totalReturn: 0 })), 'NO EDGE')
  assert.equal(verdict(row({ totalReturn: -0.01 })), 'NO EDGE')
  assert.equal(verdict(row({ sharpeCi: [-0.1, 2] })), 'WEAK')
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
