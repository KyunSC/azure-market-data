import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  LAB, labPaths, runSpecs, finalize, lookaheadCheck, validateSpec, toDataset, loadLabData, leaderboard,
  verifySpec, finalizedSpecs,
} from '../../scripts/strategy-lab.mjs'

// --- synthetic lab data: 30 RTH sessions of 5m bars, seeded random walk ------

function rng(seed) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}

// Default: 30 sessions from Mon 2026-05-04 09:30 ET, well before the verify block.
function labJson(symbol, seed, { from = Date.UTC(2026, 4, 4, 13, 30) / 1000, sessions = 30, split } = {}) {
  const r = rng(seed)
  const cols = { time: [], open: [], high: [], low: [], close: [], volume: [] }
  const feat = { above_zero_gamma: [], dist_put_wall_atr: [], minutes_since_open: [] }
  let px = 400
  let day = from
  for (let d = 0; d < sessions; d++) {
    const dow = new Date(day * 1000).getUTCDay()
    if (dow === 0 || dow === 6) { day += 86400; d--; continue }
    for (let b = 0; b < 78; b++) {
      const o = px
      const c = o * (1 + (r() - 0.5) * 0.004)
      cols.time.push(day + b * 300)
      cols.open.push(o)
      cols.close.push(c)
      cols.high.push(Math.max(o, c) * 1.0005)
      cols.low.push(Math.min(o, c) * 0.9995)
      cols.volume.push(1000 + Math.floor(r() * 1000))
      feat.above_zero_gamma.push(r() > 0.5 ? 1 : -1)
      feat.dist_put_wall_atr.push((r() - 0.3) * 4)
      feat.minutes_since_open.push(b * 5)
      px = c
    }
    day += 86400
  }
  const n = cols.time.length
  return {
    symbol, interval: '5m', generatedAt: '2026-09-24T00:00:00+00:00', bars: n, split,
    start: new Date(cols.time[0] * 1000).toISOString(), end: new Date(cols.time[n - 1] * 1000).toISOString(),
    ...cols, features: feat,
    ml: { pred: Array(n).fill(null), target_return: Array(n).fill(null), fold: Array(n).fill(null), oosStart: n },
  }
}

const VERIFY_FROM = Date.UTC(2026, 7, 24, 13, 30) / 1000 // Mon 2026-08-24 09:30 ET

async function makeLab() {
  const root = await mkdtemp(path.join(tmpdir(), 'lab-test-'))
  // The verify block lives outside the lab root, as in the repo.
  const paths = labPaths(path.join(root, 'lab'), path.join(root, 'ml-data'))
  paths.tmp = root
  await mkdir(paths.data, { recursive: true })
  await mkdir(paths.strategies, { recursive: true })
  await mkdir(paths.verifyData, { recursive: true })
  await writeFile(path.join(paths.data, 'qqq_5m.json'), JSON.stringify(labJson('QQQ', 1)))
  await writeFile(path.join(paths.data, 'spy_5m.json'), JSON.stringify(labJson('SPY', 2)))
  await writeFile(path.join(paths.verifyData, 'qqq_5m.json'), JSON.stringify(labJson('QQQ', 11, { from: VERIFY_FROM, sessions: 12, split: 'verify' })))
  await writeFile(path.join(paths.verifyData, 'spy_5m.json'), JSON.stringify(labJson('SPY', 12, { from: VERIFY_FROM, sessions: 12, split: 'verify' })))
  return paths
}

const cleanup = (paths) => rm(paths.tmp, { recursive: true, force: true })

const jsSpec = (id, body, params = "[{ key: 'k', values: [1, 2] }]", family = 'test') => `
export default {
  id: '${id}',
  family: '${family}',
  rationale: 'synthetic spec used by the lab tests only',
  params: ${params},
  signal(i, s, ds, p, prev) { ${body} },
}
`

async function writeSpec(paths, id, body, params, family) {
  const file = path.join(paths.strategies, `${id}.js`)
  await writeFile(file, jsSpec(id, body, params, family))
  return file
}

// Loosen the discovery gates so random data can reach finalize.
function permissiveGates() {
  const saved = { ...LAB }
  Object.assign(LAB, { minTrades: 0, minPositiveFolds: 0, minBreakEvenBps: -Infinity })
  return () => Object.assign(LAB, saved)
}

// --- tests --------------------------------------------------------------------

test('the look-ahead guard rejects a strategy that reads the next bar', () => {
  const ds = toDataset(labJson('QQQ', 3))
  const cheat = validateSpec({
    id: 'cheat', family: 't', rationale: 'reads tomorrow, must be caught',
    signal: (i, s, d) => (d.close[i + 1] > d.close[i] ? 1 : -1),
  }, 'cheat')
  const honest = validateSpec({
    id: 'honest', family: 't', rationale: 'reads only the past, must pass',
    signal: (i, s, d) => (i > 0 && d.close[i] > d.close[i - 1] ? 1 : -1),
  }, 'honest')
  assert.equal(lookaheadCheck(cheat, ds).ok, false)
  assert.equal(lookaheadCheck(honest, ds).ok, true)
})

test('the guard also catches a feature-level peek', () => {
  const ds = toDataset(labJson('QQQ', 4))
  const peek = validateSpec({
    id: 'peek', family: 't', rationale: 'reads a future feature value',
    signal: (i, s, d) => (d.features.above_zero_gamma[i + 3] > 0 ? 1 : 0),
  }, 'peek')
  assert.equal(lookaheadCheck(peek, ds).ok, false)
})

test('run only ever hands strategies discovery bars', async () => {
  const paths = await makeLab()
  try {
    const lab = await loadLabData(paths, { full: true })
    const file = await writeSpec(paths, 'probe-length', `
      globalThis.__labMaxBars = Math.max(globalThis.__labMaxBars ?? 0, ds.close.length)
      globalThis.__labMaxTime = Math.max(globalThis.__labMaxTime ?? 0, ds.time[ds.time.length - 1])
      return i % 20 < 10 ? 1 : 0`)
    const [res] = await runSpecs([file], paths, { night: 't1' })
    assert.equal(res.error, undefined, res.error)
    const maxCut = Math.max(...Object.values(lab).map((x) => x.split.cut))
    const holdoutStart = Math.min(...Object.values(lab).map((x) => x.full.time[x.split.cut]))
    assert.ok(globalThis.__labMaxBars <= maxCut, 'a strategy saw a holdout-length dataset')
    assert.ok(globalThis.__labMaxTime < holdoutStart, 'a strategy saw a holdout timestamp')
  } finally {
    delete globalThis.__labMaxBars
    delete globalThis.__labMaxTime
    await cleanup(paths)
  }
})

test('a look-ahead spec is refused and never reaches the ledger', async () => {
  const paths = await makeLab()
  try {
    const file = await writeSpec(paths, 'future-peek', 'return ds.close[i + 1] > ds.close[i] ? 1 : 0')
    const [res] = await runSpecs([file], paths, { night: 't1' })
    assert.match(res.error, /LOOK-AHEAD/)
    assert.equal((await leaderboard(paths)).length, 0)
  } finally {
    await cleanup(paths)
  }
})

test('the ledger deflates against every config ever tried, and ids cannot be re-run', async () => {
  const paths = await makeLab()
  try {
    const a = await writeSpec(paths, 'alt-a', 'return i % (8 * p.k) < 4 * p.k ? 1 : 0')
    const b = await writeSpec(paths, 'alt-b', 'return i % (6 * p.k) < 3 * p.k ? -1 : 0', "[{ key: 'k', values: [1, 2, 3] }]")
    const [ra] = await runSpecs([a], paths, { night: 't1' })
    const [rb] = await runSpecs([b], paths, { night: 't1' })
    assert.equal(ra.results[0].trials, 2)
    assert.equal(rb.results[0].trials, 5)
    const board = await leaderboard(paths)
    assert.ok(board.every((r) => r.results.every((x) => x.trials === 5)), 'leaderboard DSR must use the current ledger')
    const [again] = await runSpecs([a], paths, { night: 't1' })
    assert.match(again.error, /already tested/)
  } finally {
    await cleanup(paths)
  }
})

test('grids above the cap are refused', () => {
  const values = Array.from({ length: 7 }, (_, k) => k)
  assert.throws(() => validateSpec({
    id: 'too-big', family: 't', rationale: 'forty-nine cells is too many',
    params: [{ key: 'a', values }, { key: 'b', values }], signal: () => 0,
  }, 'x'), /cap/)
})

test('finalize pre-registers, scores once, and never re-scores a spec', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const a = await writeSpec(paths, 'fin-a', 'return i % (10 * p.k) < 5 * p.k ? 1 : 0')
    await runSpecs([a], paths, { night: 'n1' })
    const { report } = await finalize(paths, { night: 'n1', top: 3 })
    assert.equal(report.finalists.length, 1)
    assert.ok(existsSync(path.join(paths.runs, 'n1', 'preregistered.json')))
    const row = report.scored[0].rows[0]
    assert.ok(new Date(row.holdout.start) > new Date(0))
    assert.ok(['CANDIDATE', 'WEAK', 'NO EDGE', 'INSUFFICIENT'].includes(row.verdict))

    await assert.rejects(finalize(paths, { night: 'n1' }), /already finalized/)
    await assert.rejects(runSpecs([a], paths, { night: 'n1' }), /already finalized/)

    // A later night spends the same holdout: fin-a is not eligible again, and
    // the Bonferroni family counts every spec ever finalized.
    const b = await writeSpec(paths, 'fin-b', 'return i % (12 * p.k) < 6 * p.k ? -1 : 0')
    await runSpecs([b], paths, { night: 'n2' })
    const second = await finalize(paths, { night: 'n2', top: 3 })
    assert.deepEqual(second.report.finalists.map((f) => f.id), ['fin-b'])
    assert.equal(second.report.familySize, 2 * LAB.symbols.length)
  } finally {
    restore()
    await cleanup(paths)
  }
})

test('finalize never picks a control, even an eligible one', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const c = await writeSpec(paths, 'ctl-lucky', 'return i % (10 * p.k) < 5 * p.k ? 1 : 0', undefined, 'control')
    const a = await writeSpec(paths, 'real-a', 'return i % (12 * p.k) < 6 * p.k ? -1 : 0')
    await runSpecs([c, a], paths, { night: 'n1' })
    assert.ok((await leaderboard(paths)).find((r) => r.id === 'ctl-lucky').eligible)
    const { report } = await finalize(paths, { night: 'n1', top: 5 })
    assert.deepEqual(report.finalists.map((f) => f.id), ['real-a'])
  } finally {
    restore()
    await cleanup(paths)
  }
})

test('finalize refuses a spec edited after it was run', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const a = await writeSpec(paths, 'edited', 'return i % 10 < 5 ? 1 : 0')
    await runSpecs([a], paths, { night: 'n1' })
    await writeFile(a, (await readFile(a, 'utf8')).replace('i % 10 < 5', 'i % 10 < 4'))
    const { report } = await finalize(paths, { night: 'n1' })
    assert.match(report.scored[0].error, /changed/)
  } finally {
    restore()
    await cleanup(paths)
  }
})

// --- verify -------------------------------------------------------------------

const readLog = async (paths) => existsSync(paths.verifyLog)
  ? (await readFile(paths.verifyLog, 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []

test('LAB.verifyStart matches holdout.py VERIFY_START', async () => {
  const py = await readFile(fileURLToPath(new URL('../../../functions/ml/holdout.py', import.meta.url)), 'utf8')
  const [, date] = py.match(/VERIFY_START = pd\.Timestamp\("(\d{4}-\d{2}-\d{2})", tz="America\/New_York"\)/)
  assert.equal(LAB.verifyStart.slice(0, 10), date)
  // 00:00 New York on that date (EDT in late August).
  assert.equal(new Date(LAB.verifyStart).toISOString(), `${date}T04:00:00.000Z`)
})

test('lab data that reaches the verify block is refused by run and finalize', async () => {
  const paths = await makeLab()
  try {
    // A verify export copied into lab/data …
    await writeFile(path.join(paths.data, 'qqq_5m.json'), await readFile(path.join(paths.verifyData, 'qqq_5m.json'), 'utf8'))
    await assert.rejects(loadLabData(paths), /sealed verify block/)
    // … or a research export whose last bars run past VERIFY_START.
    await writeFile(path.join(paths.data, 'qqq_5m.json'), JSON.stringify(labJson('QQQ', 1, { from: Date.UTC(2026, 6, 20, 13, 30) / 1000, sessions: 30 })))
    await assert.rejects(loadLabData(paths), /sealed verify block/)
    const file = await writeSpec(paths, 'never-runs', 'return 0')
    await assert.rejects(runSpecs([file], paths, { night: 'n1' }), /sealed verify block/)
  } finally {
    await cleanup(paths)
  }
})

test('verify refuses a spec that was never finalized, and logs nothing', async () => {
  const paths = await makeLab()
  try {
    const a = await writeSpec(paths, 'not-final', 'return i % 10 < 5 ? 1 : 0')
    await runSpecs([a], paths, { night: 'n1' })
    await assert.rejects(verifySpec(paths, 'not-final'), /never finalized/)
    assert.deepEqual(await readLog(paths), [])
  } finally {
    await cleanup(paths)
  }
})

test('verify trades frozen params on verify bars only, logs the look, and never looks twice', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const a = await writeSpec(paths, 'ver-a', `
      globalThis.__verMinTime = Math.min(globalThis.__verMinTime ?? Infinity, ds.time[0])
      globalThis.__verParams = p
      return i % (10 * p.k) < 5 * p.k ? 1 : 0`, "[{ key: 'k', values: [1, 2, 3] }]")
    await runSpecs([a], paths, { night: 'n1' })
    const { report } = await finalize(paths, { night: 'n1' })
    const frozen = report.finalists[0].params
    globalThis.__verMinTime = Infinity

    const r = await verifySpec(paths, 'ver-a')
    assert.ok(globalThis.__verMinTime >= Date.parse(LAB.verifyStart) / 1000, 'verify traded a pre-verify bar')
    assert.deepEqual(r.rows.map((x) => x.params), LAB.symbols.map((s) => frozen[s]))
    assert.deepEqual(globalThis.__verParams, frozen.SPY, 'the last symbol ran with its own frozen params')
    assert.ok(r.rows.every((x) => x.holdout.start >= '2026-08-24' && x.holdout.nTrades > 0))
    assert.ok(['CANDIDATE', 'LEAD', 'WEAK', 'NO EDGE', 'INSUFFICIENT'].includes(r.verdict))
    assert.equal(r.familySize, LAB.symbols.length)

    const log = await readLog(paths)
    assert.deepEqual(log.map((l) => l.event), ['look', 'result'])
    assert.equal(log[0].id, 'ver-a')
    assert.ok(log[0].at <= log[1].at, 'the look is logged before the result')

    await assert.rejects(verifySpec(paths, 'ver-a'), /already had its look/)
    assert.equal((await readLog(paths)).length, 2, 'a refused verify must not log another look')
    assert.ok((await finalizedSpecs(paths))[0].verified)

    // A second spec is the second look: the Bonferroni family grows.
    const b = await writeSpec(paths, 'ver-b', 'return i % (12 * p.k) < 6 * p.k ? -1 : 0')
    await runSpecs([b], paths, { night: 'n2' })
    await finalize(paths, { night: 'n2' })
    const r2 = await verifySpec(paths, 'ver-b')
    assert.equal(r2.look, 2)
    assert.equal(r2.familySize, 2 * LAB.symbols.length)
  } finally {
    restore()
    delete globalThis.__verMinTime
    delete globalThis.__verParams
    await cleanup(paths)
  }
})

test('verify refuses a spec edited after pre-registration, before logging a look', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const a = await writeSpec(paths, 'ver-edit', 'return i % 10 < 5 ? 1 : 0')
    await runSpecs([a], paths, { night: 'n1' })
    await finalize(paths, { night: 'n1' })
    await writeFile(a, (await readFile(a, 'utf8')).replace('i % 10 < 5', 'i % 10 < 4'))
    await assert.rejects(verifySpec(paths, 'ver-edit'), /changed since it was pre-registered/)
    assert.deepEqual(await readLog(paths), [])
  } finally {
    restore()
    await cleanup(paths)
  }
})

test('verify refuses research data in the verify slot', async () => {
  const paths = await makeLab()
  const restore = permissiveGates()
  try {
    const a = await writeSpec(paths, 'ver-wrong-data', 'return i % 10 < 5 ? 1 : 0')
    await runSpecs([a], paths, { night: 'n1' })
    await finalize(paths, { night: 'n1' })
    await writeFile(path.join(paths.verifyData, 'spy_5m.json'), await readFile(path.join(paths.data, 'spy_5m.json'), 'utf8'))
    await assert.rejects(verifySpec(paths, 'ver-wrong-data'), /not a verify-only export/)
    assert.deepEqual(await readLog(paths), [])
  } finally {
    restore()
    await cleanup(paths)
  }
})
