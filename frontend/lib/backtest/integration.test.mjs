import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const { normalizeBars, validateDataset, loadResearchDataset } = await jiti.import('./datasets.js')
const { runBacktest } = await jiti.import('./engine.js')
const { getStrategy, defaultParams } = await jiti.import('./strategies/index.js')
const { useBacktest } = await jiti.import('./store.js')

test('daily API timestamps normalize to UTC seconds', () => {
  const ds = normalizeBars([{ time: '2026-07-01', open: 1, high: 2, low: 1, close: 2, volume: 10 }], {})
  assert.equal(ds.time[0], Date.parse('2026-07-01T00:00:00Z') / 1000)
})

test('rejects duplicate timestamps and unequal feature columns', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../public/backtest/qqq_5m.json', import.meta.url), 'utf8'))
  const bad = structuredClone(fixture)
  bad.time[1] = bad.time[0]
  assert.throws(() => validateDataset(bad), /timestamps/)
  bad.time = fixture.time
  bad.features.bad = [1]
  assert.throws(() => validateDataset(bad), /feature/)
})

test('backend artifact preserves example trades and metrics; late dataset responses are ignored', async () => {
  const fixture = JSON.parse(await readFile(new URL('../../public/backtest/qqq_5m.json', import.meta.url), 'utf8'))
  const version = 'a'.repeat(64)
  const id = `qqq-5m-${version}`
  const artifact = { ...fixture, id, version, schemaVersion: 1, capabilities: { gex: true, ml: true } }
  const original = globalThis.fetch
  try {
    globalThis.fetch = async url => ({ ok: true, json: async () => url.startsWith('/api/') ? artifact : fixture })
    const example = await loadResearchDataset({ symbol: 'QQQ', example: true })
    const backend = await loadResearchDataset({ symbol: 'QQQ', id })
    const config = { strategy: getStrategy('gexWallFade'), params: defaultParams('gexWallFade') }
    const a = runBacktest({ ...config, dataset: example })
    const b = runBacktest({ ...config, dataset: backend })
    assert.deepEqual(a.trades, b.trades)
    assert.deepEqual(a.metrics, b.metrics)
    let release
    let calls = 0
    globalThis.fetch = async url => {
      if (url.endsWith('/datasets')) {
        if (++calls === 1) await new Promise(resolve => { release = resolve })
        return { ok: true, json: async () => ({ schemaVersion: 1, datasets: [{ symbol: 'QQQ', id }] }) }
      }
      return { ok: true, json: async () => artifact }
    }
    useBacktest.setState({ autoRun: false, example: false })
    const first = useBacktest.getState().loadDataset()
    const second = useBacktest.getState().loadDataset()
    await second
    release()
    await first
    assert.equal(useBacktest.getState().dataset.id, id)
    assert.equal(useBacktest.getState().datasetLoading, false)
    const pendingRun = useBacktest.getState().run()
    useBacktest.getState().setParam('band', 0.7)
    await pendingRun
    assert.equal(useBacktest.getState().result, null)
    assert.equal(useBacktest.getState().running, false)
  } finally { globalThis.fetch = original }
})

test('outages use a labeled cache; missing versions never use cache', async () => {
  const originalFetch = globalThis.fetch
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const memory = new Map()
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: key => memory.get(key) || null,
    setItem: (key, value) => memory.set(key, value),
  } })
  const fixture = JSON.parse(await readFile(new URL('../../public/backtest/spy_5m.json', import.meta.url), 'utf8'))
  const id = `spy-5m-${'b'.repeat(64)}`
  const artifact = { ...fixture, schemaVersion: 1, id }
  try {
    globalThis.fetch = async () => ({ ok: true, json: async () => artifact })
    const fresh = await loadResearchDataset({ symbol: 'SPY', id })
    assert.equal(fresh.cached, false)
    globalThis.fetch = async () => { throw new Error('offline') }
    const cached = await loadResearchDataset({ symbol: 'SPY', id })
    assert.equal(cached.cached, true)
    assert.deepEqual(cached.close, fresh.close)
    globalThis.fetch = async () => ({ ok: false, status: 404 })
    await assert.rejects(loadResearchDataset({ symbol: 'SPY', id }), /version unavailable/)
    const key = `/api/backtest/datasets/${id}`
    memory.set(`backtestCache:${key}`, JSON.stringify({ at: Date.now() - 86400001, data: artifact }))
    globalThis.fetch = async () => { throw new Error('offline') }
    await assert.rejects(loadResearchDataset({ symbol: 'SPY', id }), /offline/)
  } finally {
    globalThis.fetch = originalFetch
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})
