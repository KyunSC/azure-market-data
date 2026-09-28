/**
 * Strategy lab: an unattended hypothesis → backtest loop that cannot fool itself.
 *
 * Each lab dataset (see `export_backtest_data.py --research-only`) is split
 * three ways before any strategy code sees it:
 *
 *   [ discovery ~70% ][ lab holdout ~30% ]  · · ·  [ sealed verify — outside lab/ ]
 *
 *   run        evaluates specs on DISCOVERY bars only. The dataset handed to the
 *              strategy is physically truncated at the cut, so a spec cannot
 *              peek at the holdout even by accident. Every config tried is
 *              appended to a ledger, and deflated Sharpe is computed against
 *              the whole ledger (every night, every spec) — not just this spec.
 *   leaderboard ranks specs by walk-forward OOS Sharpe inside discovery.
 *   finalize   pre-registers the top K (written to disk BEFORE scoring), then
 *              trades each once on the lab holdout. A spec can be finalized once
 *              ever, and the Bonferroni family grows with every spec finalized
 *              on any night, because every look spends the same holdout.
 *   verify     trades ONE finalized spec, at its pre-registered params, on the
 *              sealed verify block (>= VERIFY_START, exported with
 *              `export_backtest_data.py --verify-only` to functions/ml/data/,
 *              never into lab/). Every look is logged to
 *              functions/ml/data/lab_verify_log.jsonl before scoring, and a
 *              spec that has been looked at once is refused forever.
 *
 * Specs live in `lab/strategies/`:
 *   <id>.json  rule-AST (see lib/backtest/ruleAst.js); `{t:'param',k}` nodes are
 *              filled from the grid.
 *   <id>.js    ESM strategy module: { id, family, rationale, params:[{key,values}],
 *              risk?, warmup?, prepare?, signal }.
 *
 * Usage (from frontend/):
 *   node scripts/strategy-lab.mjs run lab/strategies/foo.json [more specs…]
 *   node scripts/strategy-lab.mjs leaderboard [--all]
 *   node scripts/strategy-lab.mjs status
 *   node scripts/strategy-lab.mjs finalize [--top 5]
 *   node scripts/strategy-lab.mjs verify [<spec-id>]   (no id: list finalized specs)
 */

import { readFile, writeFile, mkdir, appendFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createJiti } from 'jiti'
import { verdict, breakEven } from './nightly-backtest.mjs'

const jiti = createJiti(import.meta.url, { moduleCache: false })
const lib = (f) => jiti.import(new URL(`../lib/backtest/${f}`, import.meta.url).href)
const { runBacktest, DEFAULT_COSTS, DEFAULT_RISK } = await lib('engine.js')
const { runSweep, runWalkForward, runCostCurve } = await lib('analytics.js')
const { holdoutSplit, deflatedSharpe, normInv, sharpeInference, configKey } = await lib('stats.js')
const { validateDataset } = await lib('datasets.js')
const { datasetPeriodsPerYear } = await lib('metrics.js')
const custom = (await lib('strategies/custom.js')).default

const FRONTEND_DIR = fileURLToPath(new URL('../', import.meta.url))
const ML_DATA_DIR = fileURLToPath(new URL('../../functions/ml/data/', import.meta.url))

export const LAB = {
  symbols: ['QQQ', 'SPY'],
  holdoutPct: 30,
  wfSplits: 4,
  maxGrid: 36,
  maxSpecsPerNight: 150,
  stopAt: '06:30', // local time; `status` reports when the night is over
  guardProbes: 40,
  // Leaderboard gates — a spec must clear all of them on every symbol to be
  // eligible for finalize.
  minTrades: 30,
  minPositiveFolds: 3,
  minBreakEvenBps: DEFAULT_COSTS.slippageBps,
  familyAlpha: 0.05,
  // functions/ml/holdout.py VERIFY_START (00:00 America/New_York). Lab data must
  // end before it; verify data must start on or after it.
  verifyStart: '2026-08-24T00:00:00-04:00',
}

export function labPaths(
  root = process.env.LAB_DIR ?? path.join(FRONTEND_DIR, 'lab'),
  verifyRoot = process.env.LAB_VERIFY_DIR ?? ML_DATA_DIR,
) {
  return {
    root,
    data: path.join(root, 'data'),
    strategies: path.join(root, 'strategies'),
    runs: path.join(root, 'runs'),
    ledger: path.join(root, 'runs', 'ledger.jsonl'),
    finalized: path.join(root, 'runs', 'finalized.jsonl'),
    results: path.join(root, 'runs', 'results'),
    // Deliberately outside `root`: nothing under lab/ can reach the verify block.
    verifyData: path.join(verifyRoot, 'lab_verify'),
    verifyLog: path.join(verifyRoot, 'lab_verify_log.jsonl'),
  }
}

/** A night runs past midnight, so it is named for the evening it started. */
export function nightId(now = new Date()) {
  const d = new Date(now.getTime() - 12 * 3600_000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// --- data -------------------------------------------------------------------

const f64 = (a) => Float64Array.from(a, (v) => (v === null ? Number.NaN : v))

/** Lab JSON → engine dataset. The ML block keeps only the OOS prediction: the
 *  forward-return target is look-ahead by construction. */
export function toDataset(j) {
  validateDataset(j)
  const features = {}
  for (const [k, v] of Object.entries(j.features || {})) features[k] = f64(v)
  return {
    id: `lab:${j.symbol}:${j.generatedAt}`,
    plane: 'research',
    symbol: j.symbol,
    interval: j.interval,
    n: j.bars,
    time: f64(j.time),
    open: f64(j.open),
    high: f64(j.high),
    low: f64(j.low),
    close: f64(j.close),
    volume: f64(j.volume),
    features,
    ml: j.ml ? { pred: f64(j.ml.pred), oosStart: j.ml.oosStart } : null,
    start: j.time[0] * 1000,
    end: j.time[j.bars - 1] * 1000,
  }
}

/** First `end + 1` bars as a fresh dataset (fresh series cache, copied arrays). */
export function sliceDataset(ds, end) {
  const k = end + 1
  const cut = (a) => a.slice(0, k)
  const features = {}
  for (const [key, v] of Object.entries(ds.features || {})) features[key] = cut(v)
  return {
    ...ds,
    n: k,
    time: cut(ds.time),
    open: cut(ds.open),
    high: cut(ds.high),
    low: cut(ds.low),
    close: cut(ds.close),
    volume: cut(ds.volume),
    features,
    ml: ds.ml ? { ...ds.ml, pred: cut(ds.ml.pred) } : null,
    end: ds.time[end] * 1000,
  }
}

export function splitLab(ds) {
  const { cut, researchEnd, holdoutBars } = holdoutSplit(ds.time, LAB.holdoutPct)
  if (!holdoutBars) throw new Error(`${ds.symbol}: too short for a lab holdout`)
  return { cut, researchEnd, holdoutBars }
}

const verifyStartSec = () => Date.parse(LAB.verifyStart) / 1000

export async function loadLabData(paths, { full = false } = {}) {
  const out = {}
  for (const symbol of LAB.symbols) {
    const file = path.join(paths.data, `${symbol.toLowerCase()}_5m.json`)
    if (!existsSync(file)) {
      throw new Error(`Missing ${file}. Run: python functions/ml/export_backtest_data.py --research-only --out frontend/lab/data`)
    }
    const j = JSON.parse(await readFile(file, 'utf8'))
    if (j.split === 'verify' || j.time.at(-1) >= verifyStartSec()) {
      throw new Error(`${file} reaches the sealed verify block (>= ${LAB.verifyStart}); re-export with --research-only`)
    }
    const ds = toDataset(j)
    const split = splitLab(ds)
    out[symbol] = { full: full ? ds : null, discovery: sliceDataset(ds, split.researchEnd), split }
  }
  return out
}

// --- specs ------------------------------------------------------------------

function substituteParams(node, p) {
  if (Array.isArray(node)) return node.map((x) => substituteParams(x, p))
  if (!node || typeof node !== 'object') return node
  if (node.t === 'param') {
    if (!(node.k in p)) throw new Error(`Rule references unknown param "${node.k}"`)
    return { t: 'const', v: p[node.k] }
  }
  const out = {}
  for (const [k, v] of Object.entries(node)) out[k] = substituteParams(v, p)
  return out
}

/** Rule-AST JSON spec → strategy object, via the existing custom strategy. */
function fromRuleSpec(spec) {
  const base = { direction: spec.direction ?? 'long', warmupBars: spec.warmupBars ?? 50 }
  const toCustom = (p) => ({ ...base, rule: substituteParams(spec.rule, p) })
  return {
    ...spec,
    warmup: (p, ds) => custom.warmup(toCustom(p), ds),
    prepare: (ds, p) => {
      const cp = toCustom(p)
      return { state: custom.prepare(ds, cp), cp }
    },
    signal: (i, s, ds, p, prev) => custom.signal(i, s.state, ds, s.cp, prev),
  }
}

export function gridOf(spec) {
  const axes = (spec.params ?? []).map((a) => {
    const values = Array.isArray(a.values) && a.values.length ? a.values : [a.default]
    if (values[0] === undefined) throw new Error(`Param "${a.key}" needs values or a default`)
    return { key: a.key, values }
  })
  let grid = [{}]
  for (const a of axes) grid = grid.flatMap((g) => a.values.map((v) => ({ ...g, [a.key]: v })))
  return grid
}

export async function loadSpec(file) {
  const abs = path.resolve(file)
  const source = await readFile(abs, 'utf8')
  let spec
  if (abs.endsWith('.json')) {
    spec = fromRuleSpec(JSON.parse(source))
  } else if (abs.endsWith('.js') || abs.endsWith('.mjs')) {
    const mod = await jiti.import(pathToFileURL(abs).href)
    spec = mod.default ?? mod
  } else {
    throw new Error(`${file}: specs are .json (rule AST) or .js (strategy module)`)
  }
  return validateSpec(spec, source, file)
}

export function validateSpec(spec, source, file = spec?.id) {
  const fail = (m) => { throw new Error(`${file}: ${m}`) }
  if (!spec || typeof spec !== 'object') fail('no default export')
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(spec.id ?? '')) fail('id must be kebab-case, 3–64 chars')
  if (!spec.family) fail('missing family')
  if (!(typeof spec.rationale === 'string' && spec.rationale.trim().length >= 20)) fail('rationale must say which mechanism is being tested (≥ 20 chars)')
  if (typeof spec.signal !== 'function') fail('missing signal(i, state, ds, params, prev)')
  const grid = gridOf(spec)
  if (grid.length > LAB.maxGrid) fail(`grid has ${grid.length} cells; cap is ${LAB.maxGrid}`)
  return { ...spec, risk: { ...DEFAULT_RISK, ...(spec.risk ?? {}) }, grid, hash: configKey(source) }
}

/**
 * Collapse an N-d grid into one `_cell` axis so the stock sweep and
 * walk-forward runners (and their warm-up/embargo handling) are reused as is.
 */
export function cellStrategy(spec) {
  const at = (p) => spec.grid[p._cell]
  return {
    id: spec.id,
    warmup: (p, ds) => (spec.warmup ? spec.warmup(at(p), ds) : 0),
    prepare: (ds, p) => (spec.prepare ? spec.prepare(ds, at(p)) : null),
    signal: (i, s, ds, p, prev) => spec.signal(i, s, ds, at(p), prev),
  }
}

// --- look-ahead guard -------------------------------------------------------

function signalPath(strategy, ds, p, last) {
  const state = strategy.prepare ? strategy.prepare(ds, p) : null
  const warm = strategy.warmup ? strategy.warmup(p, ds) : 0
  const out = new Int8Array(last + 1)
  let prev = 0
  for (let i = Math.max(0, warm); i <= last; i++) {
    let t = strategy.signal(i, state, ds, p, prev)
    if (!Number.isFinite(t)) t = prev
    t = Math.max(-1, Math.min(1, Math.round(t)))
    out[i] = t
    prev = t
  }
  return out
}

/**
 * A strategy that only reads the past produces the same signals on a
 * truncated copy of the data. Probes `probes` truncation points spread across
 * the dataset for every grid cell and reports the first divergence.
 */
export function lookaheadCheck(spec, ds, probes = LAB.guardProbes) {
  const s = cellStrategy(spec)
  const n = ds.close.length
  const cells = spec.grid.length <= 4 ? spec.grid.map((_, k) => k) : [0, spec.grid.length - 1, Math.floor(spec.grid.length / 2)]
  for (const cell of cells) {
    const p = { _cell: cell }
    const full = signalPath(s, ds, p, n - 1)
    const perCell = Math.max(3, Math.ceil(probes / cells.length))
    for (let q = 1; q <= perCell; q++) {
      const k = Math.min(n - 2, Math.floor(((n - 1) * q) / (perCell + 1)))
      const part = signalPath(s, sliceDataset(ds, k), p, k)
      for (let i = 0; i <= k; i++) {
        if (part[i] !== full[i]) {
          return { ok: false, cell, bar: i, truncatedAt: k, full: full[i], truncated: part[i] }
        }
      }
    }
  }
  return { ok: true }
}

// --- evaluation -------------------------------------------------------------

function wfOosInference(wf, ds) {
  const r = []
  for (let i = wf.firstTest + 1; i < wf.stitched.length; i++) {
    const a = wf.stitched[i - 1]
    const b = wf.stitched[i]
    if (Number.isFinite(a) && Number.isFinite(b) && a > 0) r.push(b / a - 1)
  }
  return sharpeInference(r, datasetPeriodsPerYear(ds))
}

/** Discovery-only evaluation of one spec on one symbol. */
export function evaluateDiscovery(spec, ds) {
  const strategy = cellStrategy(spec)
  const costs = { ...DEFAULT_COSTS }
  const risk = spec.risk
  const xValues = spec.grid.map((_, k) => k)
  const base = { _cell: 0 }

  const sweep = runSweep({ dataset: ds, strategy, params: base, costs, risk, xKey: '_cell', yKey: '_unused', xValues, yValues: [0] })
  const bestCell = sweep.best?.x ?? 0
  const bestRun = runBacktest({ dataset: ds, strategy, params: { _cell: bestCell }, costs, risk })
  const m = bestRun.metrics

  let wf
  try {
    const w = runWalkForward({ dataset: ds, strategy, params: base, costs, risk, xKey: '_cell', xValues, nSplits: LAB.wfSplits })
    const inf = wfOosInference(w, ds)
    wf = {
      avgOosSharpe: w.avgOosSharpe,
      avgIsSharpe: w.avgIsSharpe,
      stitchedSharpe: inf.sharpe,
      positiveFolds: w.positiveFolds,
      folds: w.folds.length,
      oosTrades: w.folds.reduce((a, f) => a + f.oosTrades, 0),
      totalReturn: w.totalReturn,
      foldDetail: w.folds.map((f) => ({ oosSharpe: f.oosSharpe, oosReturn: f.oosReturn, oosTrades: f.oosTrades, cell: f.params._cell })),
    }
  } catch (e) {
    wf = { error: e.message || String(e) }
  }

  const costCurve = runCostCurve({ dataset: ds, strategy, params: { _cell: bestCell }, costs, risk })
  const { sr, n, skew, kurt } = m.inference
  return {
    symbol: ds.symbol,
    bars: ds.close.length,
    cells: sweep.cells.map((c) => c.sr),
    bestCell,
    bestParams: spec.grid[bestCell],
    medianSweepSharpe: sweep.median,
    best: {
      sharpe: m.sharpe,
      totalReturn: m.totalReturn,
      maxDd: m.maxDd,
      nTrades: m.nTrades,
      hitRate: m.hitRate,
      exposure: m.exposure,
      inference: { sr, n, skew, kurt },
    },
    wf,
    breakEvenBps: breakEven(costCurve),
  }
}

// --- ledger -----------------------------------------------------------------

async function readJsonl(file) {
  if (!existsSync(file)) return []
  const text = await readFile(file, 'utf8')
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l, jsonRevive))
}

const trialSrs = (ledger, symbol) => ledger.flatMap((r) => r.results.filter((x) => x.symbol === symbol).flatMap((x) => x.cells)).filter(Number.isFinite)

/** DSR of each symbol's best cell against every config ever tried on that symbol. */
export function withDsr(record, ledger) {
  return record.results.map((x) => ({ ...x, ...deflatedSharpe(x.best.inference, trialSrs(ledger, x.symbol)) }))
}

export function scoreRecord(record, ledger) {
  const res = withDsr(record, ledger)
  const reasons = []
  for (const x of res) {
    if (x.wf.error) reasons.push(`${x.symbol}: WF ${x.wf.error}`)
    if (!(x.best.nTrades >= LAB.minTrades)) reasons.push(`${x.symbol}: ${x.best.nTrades} trades`)
    if (!(x.breakEvenBps > LAB.minBreakEvenBps)) reasons.push(`${x.symbol}: break-even ${fmt(x.breakEvenBps, 1)} bps`)
    if (!(x.wf.positiveFolds >= LAB.minPositiveFolds)) reasons.push(`${x.symbol}: ${x.wf.positiveFolds ?? 0}/${LAB.wfSplits} +folds`)
  }
  const score = Math.min(...res.map((x) => (Number.isFinite(x.wf.avgOosSharpe) ? x.wf.avgOosSharpe : -Infinity)))
  return { id: record.id, family: record.family, night: record.night, results: res, score, eligible: reasons.length === 0, reasons }
}

export async function leaderboard(paths) {
  const ledger = await readJsonl(paths.ledger)
  return ledger.map((r) => scoreRecord(r, ledger)).sort((a, b) => b.score - a.score)
}

export async function nightStatus(paths, night = nightId(), now = new Date()) {
  const ledger = await readJsonl(paths.ledger)
  const tonight = ledger.filter((r) => r.night === night)
  // The night of D ends at stopAt on D+1, local time.
  const [y, mo, d] = night.split('-').map(Number)
  const [hh, mm] = LAB.stopAt.split(':').map(Number)
  const pastStop = now >= new Date(y, mo - 1, d + 1, hh, mm)
  return {
    night,
    specs: tonight.length,
    configs: tonight.reduce((a, r) => a + r.gridSize, 0),
    budget: LAB.maxSpecsPerNight,
    remaining: Math.max(0, LAB.maxSpecsPerNight - tonight.length),
    totalSpecs: ledger.length,
    finalized: existsSync(path.join(paths.runs, night, 'finalize.lock')),
    shouldFinalize: tonight.length >= LAB.maxSpecsPerNight || pastStop,
  }
}

export async function runSpecs(files, paths, { night = nightId(), data } = {}) {
  await mkdir(paths.results, { recursive: true })
  const status = await nightStatus(paths, night)
  if (status.finalized) throw new Error(`Night ${night} is already finalized; no more runs.`)
  const ledger = await readJsonl(paths.ledger)
  const lab = data ?? (await loadLabData(paths))
  const out = []
  let budget = status.remaining

  for (const file of files) {
    try {
      if (budget <= 0) throw new Error(`nightly budget of ${LAB.maxSpecsPerNight} specs is spent — run finalize`)
      const spec = await loadSpec(file)
      const dup = ledger.find((r) => r.id === spec.id || r.hash === spec.hash)
      if (dup) throw new Error(`already tested as "${dup.id}" on ${dup.night}; a variant needs a new id and a real change`)

      for (const symbol of LAB.symbols) {
        const g = lookaheadCheck(spec, lab[symbol].discovery)
        if (!g.ok) throw new Error(`LOOK-AHEAD on ${symbol}: cell ${g.cell} bar ${g.bar} signals ${g.full} with full data but ${g.truncated} when data ends at bar ${g.truncatedAt}`)
      }

      const results = LAB.symbols.map((symbol) => evaluateDiscovery(spec, lab[symbol].discovery))
      const record = {
        id: spec.id,
        hash: spec.hash,
        family: spec.family,
        rationale: spec.rationale,
        file: path.relative(paths.root, path.resolve(file)),
        night,
        at: new Date().toISOString(),
        gridSize: spec.grid.length,
        risk: spec.risk,
        results,
      }
      ledger.push(record)
      await appendFile(paths.ledger, JSON.stringify(record, jsonSafe) + '\n')
      budget--
      const scored = scoreRecord(record, ledger)
      await writeFile(path.join(paths.results, `${spec.id}.json`), JSON.stringify(scored, jsonSafe, 2))
      out.push(scored)
    } catch (e) {
      out.push({ id: path.basename(file), error: e.message || String(e) })
    }
  }
  return out
}

// --- finalize ---------------------------------------------------------------

export async function finalize(paths, { night = nightId(), top = 5, data } = {}) {
  const dir = path.join(paths.runs, night)
  const lock = path.join(dir, 'finalize.lock')
  if (existsSync(lock)) throw new Error(`Night ${night} was already finalized — the holdout is not scored twice.`)
  await mkdir(dir, { recursive: true })

  const already = new Set((await readJsonl(paths.finalized)).map((r) => r.id))
  // Controls are the noise floor, not candidates; one that clears the gates by
  // luck must not spend a holdout look or a Bonferroni slot.
  const board = (await leaderboard(paths)).filter((r) => r.eligible && r.family !== 'control' && !already.has(r.id))
  const picks = board.slice(0, top)
  const ledger = await readJsonl(paths.ledger)

  // Pre-registration lands on disk before a single holdout bar is traded.
  const prereg = {
    night,
    at: new Date().toISOString(),
    rule: `top ${top} eligible non-control specs by min over symbols of discovery walk-forward OOS Sharpe; params frozen at the discovery sweep's best cell`,
    finalists: picks.map((p) => {
      const rec = ledger.find((r) => r.id === p.id)
      return { id: p.id, hash: rec.hash, file: rec.file, score: p.score, params: Object.fromEntries(rec.results.map((x) => [x.symbol, x.bestParams])) }
    }),
  }
  await writeFile(path.join(dir, 'preregistered.json'), JSON.stringify(prereg, jsonSafe, 2))
  await writeFile(lock, prereg.at + '\n')
  for (const f of prereg.finalists) await appendFile(paths.finalized, JSON.stringify({ id: f.id, hash: f.hash, night }) + '\n')

  // Every spec ever finalized has spent the same holdout; they are one family.
  const family = (await readJsonl(paths.finalized)).length * LAB.symbols.length
  const z = normInv(1 - LAB.familyAlpha / (2 * Math.max(1, family)))
  const lab = data ?? (await loadLabData(paths, { full: true }))
  const scored = []

  for (const f of prereg.finalists) {
    const rec = ledger.find((r) => r.id === f.id)
    const specPath = path.resolve(paths.root, rec.file)
    const entry = { id: f.id, rows: [] }
    try {
      const spec = await loadSpec(specPath)
      if (spec.hash !== rec.hash) throw new Error('spec file changed since it was run; refusing to score an edited spec')
      for (const x of withDsr(rec, ledger)) {
        const { full, split } = lab[x.symbol]
        const strategy = cellStrategy(spec)
        const params = { _cell: x.bestCell }
        const window = { start: split.cut, end: full.close.length - 1 }
        const oos = runBacktest({ dataset: full, strategy, params, costs: { ...DEFAULT_COSTS }, risk: spec.risk, window })
        const m = oos.metrics
        const { sr, se } = m.inference
        const ann = Math.sqrt(m.periodsPerYear)
        const costCurve = runCostCurve({ dataset: full, strategy, params, costs: { ...DEFAULT_COSTS }, risk: spec.risk, window })
        const row = {
          symbol: x.symbol,
          params: x.bestParams,
          research: { dsr: x.dsr, trials: x.trials, wfOosSharpe: x.wf.avgOosSharpe },
          holdout: {
            bars: split.holdoutBars,
            start: new Date(full.time[split.cut] * 1000).toISOString(),
            end: new Date(full.time[full.close.length - 1] * 1000).toISOString(),
            sharpe: m.sharpe,
            familyCi: Number.isFinite(se) ? [(sr - z * se) * ann, (sr + z * se) * ann] : [Number.NaN, Number.NaN],
            totalReturn: m.totalReturn,
            buyHoldReturn: oos.buyHold[full.close.length - 1] / DEFAULT_COSTS.initialCapital - 1,
            maxDd: m.maxDd,
            nTrades: m.nTrades,
            hitRate: m.hitRate,
          },
          breakEvenBps: breakEven(costCurve),
        }
        row.verdict = verdict(row)
        entry.rows.push(row)
      }
      // A GEX edge should show on both underlyings; one symbol is a lead, not a result.
      entry.verdict = entry.rows.every((r) => r.verdict === 'CANDIDATE') ? 'CANDIDATE'
        : entry.rows.some((r) => r.verdict === 'CANDIDATE') ? 'LEAD' : worstVerdict(entry.rows)
    } catch (e) {
      entry.error = e.message || String(e)
    }
    scored.push(entry)
  }

  const report = { ...prereg, familySize: family, z, costs: DEFAULT_COSTS, scored }
  await writeFile(path.join(dir, 'holdout.json'), JSON.stringify(report, jsonSafe, 2))
  const md = reportMarkdown(report, await leaderboard(paths), await nightStatus(paths, night))
  await writeFile(path.join(dir, 'REPORT.md'), md)
  return { report, md }
}

// --- verify -----------------------------------------------------------------

export async function loadVerifyData(paths) {
  const out = {}
  for (const symbol of LAB.symbols) {
    const file = path.join(paths.verifyData, `${symbol.toLowerCase()}_5m.json`)
    if (!existsSync(file)) {
      throw new Error(`Missing ${file}. Run: .venv/bin/python functions/ml/export_backtest_data.py --verify-only`)
    }
    const j = JSON.parse(await readFile(file, 'utf8'))
    if (j.split !== 'verify' || j.time[0] < verifyStartSec()) {
      throw new Error(`${file} is not a verify-only export (it must start on/after ${LAB.verifyStart})`)
    }
    out[symbol] = toDataset(j)
  }
  return out
}

/** Every finalized spec, with its night's pre-registration and holdout result. */
export async function finalizedSpecs(paths) {
  const looks = (await readJsonl(paths.verifyLog)).filter((r) => r.event === 'look')
  const out = []
  for (const f of await readJsonl(paths.finalized)) {
    const dir = path.join(paths.runs, f.night)
    const prereg = JSON.parse(await readFile(path.join(dir, 'preregistered.json'), 'utf8'))
    const holdoutFile = path.join(dir, 'holdout.json')
    const holdout = existsSync(holdoutFile) ? JSON.parse(await readFile(holdoutFile, 'utf8'), jsonRevive) : null
    out.push({
      ...f,
      finalist: prereg.finalists.find((x) => x.id === f.id),
      holdout: holdout?.scored.find((x) => x.id === f.id) ?? null,
      verified: looks.find((l) => l.id === f.id || l.hash === f.hash) ?? null,
    })
  }
  return out
}

/** A spec's frozen params as a plain strategy (no grid, no `_cell`). */
function frozenStrategy(spec, params) {
  return {
    id: spec.id,
    warmup: (_, ds) => (spec.warmup ? spec.warmup(params, ds) : 0),
    prepare: (ds) => (spec.prepare ? spec.prepare(ds, params) : null),
    signal: (i, s, ds, _, prev) => spec.signal(i, s, ds, params, prev),
  }
}

/**
 * One look at the sealed verify block for one finalized spec. Everything that
 * can fail is checked before the look is logged; the look is logged before a
 * single verify bar is traded; and a logged look is never repeated.
 */
export async function verifySpec(paths, id, { data } = {}) {
  const entry = (await finalizedSpecs(paths)).find((f) => f.id === id)
  if (!entry) throw new Error(`"${id}" was never finalized; only a pre-registered finalist can be verified`)
  const { finalist, night } = entry
  if (!finalist) throw new Error(`"${id}" is in finalized.jsonl but missing from runs/${night}/preregistered.json`)
  if (entry.verified) {
    throw new Error(`"${id}" already had its look at the verify block (${entry.verified.at}); a spec is verified once, ever`)
  }

  const spec = await loadSpec(path.resolve(paths.root, finalist.file))
  if (spec.hash !== finalist.hash) throw new Error('spec file changed since it was pre-registered; refusing to verify an edited spec')
  const ledger = await readJsonl(paths.ledger)
  const rec = ledger.find((r) => r.id === id)
  if (!rec) throw new Error(`"${id}" is missing from the ledger`)
  const lab = data ?? (await loadVerifyData(paths))
  for (const symbol of LAB.symbols) {
    if (!finalist.params?.[symbol]) throw new Error(`no pre-registered ${symbol} params for "${id}"`)
    if (!lab[symbol]) throw new Error(`no ${symbol} verify data`)
  }

  const priorLooks = (await readJsonl(paths.verifyLog)).filter((r) => r.event === 'look').length
  const look = { event: 'look', at: new Date().toISOString(), id, hash: finalist.hash, night, params: finalist.params, holdoutVerdict: entry.holdout?.verdict ?? null }
  await mkdir(path.dirname(paths.verifyLog), { recursive: true })
  await appendFile(paths.verifyLog, JSON.stringify(look) + '\n')

  // Every spec ever verified has spent the same verify block.
  const familySize = (priorLooks + 1) * LAB.symbols.length
  const z = normInv(1 - LAB.familyAlpha / (2 * familySize))
  const dsr = Object.fromEntries(withDsr(rec, ledger).map((x) => [x.symbol, x]))
  const rows = []
  for (const symbol of LAB.symbols) {
    const ds = lab[symbol]
    const params = finalist.params[symbol]
    const strategy = frozenStrategy(spec, params)
    const run = runBacktest({ dataset: ds, strategy, params: {}, costs: { ...DEFAULT_COSTS }, risk: spec.risk })
    const m = run.metrics
    const { sr, se } = m.inference
    const ann = Math.sqrt(m.periodsPerYear)
    const costCurve = runCostCurve({ dataset: ds, strategy, params: {}, costs: { ...DEFAULT_COSTS }, risk: spec.risk })
    const row = {
      symbol,
      params,
      research: { dsr: dsr[symbol].dsr, trials: dsr[symbol].trials, wfOosSharpe: dsr[symbol].wf.avgOosSharpe },
      holdout: {
        bars: ds.close.length,
        start: new Date(ds.time[0] * 1000).toISOString(),
        end: new Date(ds.time[ds.close.length - 1] * 1000).toISOString(),
        sharpe: m.sharpe,
        familyCi: Number.isFinite(se) ? [(sr - z * se) * ann, (sr + z * se) * ann] : [Number.NaN, Number.NaN],
        totalReturn: m.totalReturn,
        buyHoldReturn: run.buyHold[ds.close.length - 1] / DEFAULT_COSTS.initialCapital - 1,
        maxDd: m.maxDd,
        nTrades: m.nTrades,
        hitRate: m.hitRate,
      },
      breakEvenBps: breakEven(costCurve),
    }
    row.verdict = verdict(row)
    rows.push(row)
  }
  const result = {
    event: 'result', at: new Date().toISOString(), id, hash: finalist.hash, night,
    look: priorLooks + 1, familySize, z, costs: DEFAULT_COSTS, holdoutVerdict: look.holdoutVerdict,
    verdict: rows.every((r) => r.verdict === 'CANDIDATE') ? 'CANDIDATE'
      : rows.some((r) => r.verdict === 'CANDIDATE') ? 'LEAD' : worstVerdict(rows),
    rows,
  }
  await appendFile(paths.verifyLog, JSON.stringify(result, jsonSafe) + '\n')
  return result
}

export function verifyMarkdown(r) {
  const lines = [
    `# Verify — ${r.id} (finalized on ${r.night})`,
    '',
    `Look #${r.look} at the sealed verify block; family ${r.familySize} rows (Bonferroni z = ${fmt(r.z)}). Lab holdout verdict was ${r.holdoutVerdict ?? '—'}.`,
    '',
    '| Verdict | Symbol | Params (frozen) | Verify window | Sharpe [family CI] | Return | B&H | Max DD | Trades | Hit | Break-even |',
    '|---|---|---|---|---|---:|---:|---:|---:|---:|---:|',
  ]
  for (const x of r.rows) {
    const h = x.holdout
    lines.push(`| ${x.verdict} | ${x.symbol} | ${paramStr(x.params)} | ${h.start.slice(0, 10)} → ${h.end.slice(0, 10)} (${h.bars} bars) | ${fmt(h.sharpe)} [${fmt(h.familyCi[0])}, ${fmt(h.familyCi[1])}] | ${pct(h.totalReturn)} | ${pct(h.buyHoldReturn)} | ${pct(h.maxDd)} | ${h.nTrades} | ${pct(h.hitRate)} | ${fmt(x.breakEvenBps, 1)} bps |`)
  }
  lines.push('', `**${r.verdict}** — this was the spec's only look at the verify block; it is now spent for this spec.`)
  return lines.join('\n')
}

const RANK = ['NO EDGE', 'INSUFFICIENT', 'WEAK', 'CANDIDATE']
const worstVerdict = (rows) => rows.map((r) => r.verdict).sort((a, b) => RANK.indexOf(a) - RANK.indexOf(b))[0]

// --- output -----------------------------------------------------------------

const fmt = (v, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : v === Infinity ? '∞' : '—')
const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—')
const jsonRevive = (_, v) => (v === 'Infinity' ? Infinity : v === '-Infinity' ? -Infinity : v)
const jsonSafe = (_, v) => (v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : Number.isNaN(v) ? null : v)
const paramStr = (p) => Object.entries(p ?? {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—'

export function runLine(s) {
  if (s.error) return `✗ ${s.id}: ${s.error}`
  const parts = s.results.map((x) => `${x.symbol} WF ${fmt(x.wf.avgOosSharpe)} (${x.wf.positiveFolds ?? 0}/${x.wf.folds ?? LAB.wfSplits}+) IS ${fmt(x.best.sharpe)} DSR ${fmt(x.dsr)} n=${x.best.nTrades} BE ${fmt(x.breakEvenBps, 1)}bp [${paramStr(x.bestParams)}]`)
  return `${s.eligible ? '✓' : '·'} ${s.id} (${s.family}) score ${fmt(s.score)}\n    ${parts.join('\n    ')}${s.eligible ? '' : `\n    gates: ${s.reasons.join('; ')}`}`
}

export function boardMarkdown(board, limit = 25) {
  const lines = [
    '| # | Spec | Family | Score | QQQ WF (+folds) | SPY WF (+folds) | DSR Q/S | Trades Q/S | BE bps Q/S | Eligible |',
    '|---:|---|---|---:|---|---|---|---|---|---|',
  ]
  board.slice(0, limit).forEach((r, k) => {
    const q = r.results.find((x) => x.symbol === 'QQQ')
    const s = r.results.find((x) => x.symbol === 'SPY')
    const wf = (x) => `${fmt(x?.wf.avgOosSharpe)} (${x?.wf.positiveFolds ?? 0}/${LAB.wfSplits})`
    lines.push(`| ${k + 1} | ${r.id} | ${r.family} | ${fmt(r.score)} | ${wf(q)} | ${wf(s)} | ${fmt(q?.dsr)}/${fmt(s?.dsr)} | ${q?.best.nTrades}/${s?.best.nTrades} | ${fmt(q?.breakEvenBps, 1)}/${fmt(s?.breakEvenBps, 1)} | ${r.eligible ? 'yes' : 'no'} |`)
  })
  return lines.join('\n')
}

export function reportMarkdown(report, board, status) {
  const lines = [
    `# Strategy lab — night of ${report.night}`,
    '',
    `${status.specs} specs tested tonight (${status.configs} configs); ${status.totalSpecs} specs in the ledger across all nights.`,
    `Holdout family: ${report.familySize} rows across every night's finalists (Bonferroni z = ${fmt(report.z)}). Costs ${report.costs.slippageBps} bps + $${report.costs.commissionPerTrade}/trade.`,
    '',
    '## Finalists — one look at the lab holdout',
    '',
  ]
  if (!report.scored.length) {
    lines.push('No spec cleared the discovery gates tonight, so the holdout was not touched. That is a result: nothing tried survived its own walk-forward.')
  } else {
    lines.push('| Verdict | Spec | Symbol | Params | WF OOS Sharpe (disc.) | DSR | Holdout Sharpe [family CI] | Holdout ret | B&H | Trades | Break-even |')
    lines.push('|---|---|---|---|---:|---:|---|---:|---:|---:|---:|')
    for (const e of report.scored) {
      if (e.error) {
        lines.push(`| ERROR | ${e.id} | — | ${e.error} | | | | | | | |`)
        continue
      }
      for (const r of e.rows) {
        const h = r.holdout
        lines.push(`| ${r.verdict} (${e.verdict}) | ${e.id} | ${r.symbol} | ${paramStr(r.params)} | ${fmt(r.research.wfOosSharpe)} | ${fmt(r.research.dsr)} | ${fmt(h.sharpe)} [${fmt(h.familyCi[0])}, ${fmt(h.familyCi[1])}] | ${pct(h.totalReturn)} | ${pct(h.buyHoldReturn)} | ${h.nTrades} | ${fmt(r.breakEvenBps, 1)} bps |`)
      }
    }
  }
  lines.push(
    '',
    'CANDIDATE = CANDIDATE on both symbols (holdout CI > 0 after Bonferroni, DSR ≥ 0.95, break-even above cost, ≥ 10 trades). LEAD = one symbol only.',
    'A CANDIDATE is a hypothesis for the sealed verify set (≥ 2026-08-24), not a tradeable edge.',
    '',
    '## Discovery leaderboard (all nights)',
    '',
    boardMarkdown(board),
    '',
  )
  return lines.join('\n')
}

// --- main -------------------------------------------------------------------

async function main(argv) {
  const [cmd, ...rest] = argv
  const paths = labPaths()
  const flag = (name, dflt) => {
    const k = rest.indexOf(`--${name}`)
    return k === -1 ? dflt : rest[k + 1]
  }
  const night = flag('night', nightId())

  if (cmd === 'run') {
    const files = rest.filter((a, k) => !a.startsWith('--') && rest[k - 1] !== '--night')
    if (!files.length) throw new Error('run: pass one or more spec files')
    const out = await runSpecs(files, paths, { night })
    for (const s of out) console.log(runLine(s))
    const st = await nightStatus(paths, night)
    console.log(`\nnight ${st.night}: ${st.specs}/${st.budget} specs${st.shouldFinalize ? ' — budget or time is up: run finalize' : ''}`)
    if (out.every((s) => s.error)) process.exitCode = 1
  } else if (cmd === 'leaderboard') {
    const board = await leaderboard(paths)
    console.log(boardMarkdown(rest.includes('--all') ? board : board.filter((r) => r.eligible || board.indexOf(r) < 15), rest.includes('--all') ? Infinity : 25))
  } else if (cmd === 'status') {
    console.log(JSON.stringify(await nightStatus(paths, night), null, 2))
  } else if (cmd === 'finalize') {
    const { md } = await finalize(paths, { night, top: Number(flag('top', 5)) })
    console.log(md)
  } else if (cmd === 'verify') {
    const id = rest.find((a, k) => !a.startsWith('--') && rest[k - 1] !== '--night')
    if (!id) {
      const specs = await finalizedSpecs(paths)
      if (!specs.length) console.log('No spec has been finalized yet.')
      for (const f of specs) {
        console.log(`${f.verified ? `verified ${f.verified.at.slice(0, 10)}` : 'unverified         '}  ${f.id}  (night ${f.night}, lab holdout ${f.holdout?.verdict ?? (f.holdout?.error ? 'ERROR' : '—')})`)
      }
    } else {
      console.log(verifyMarkdown(await verifySpec(paths, id)))
    }
  } else if (cmd === 'list') {
    const files = existsSync(paths.strategies) ? await readdir(paths.strategies) : []
    const ledger = await readJsonl(paths.ledger)
    const tested = new Set(ledger.map((r) => r.file))
    for (const f of files.sort()) console.log(`${tested.has(path.join('strategies', f)) ? 'tested  ' : 'UNTESTED'} ${f}`)
  } else {
    console.log('usage: strategy-lab.mjs run <spec…> | leaderboard [--all] | status | finalize [--top 5] | verify [<spec-id>] | list   (--night YYYY-MM-DD for run/status/finalize)')
    process.exitCode = cmd ? 1 : 0
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main(process.argv.slice(2))
  } catch (e) {
    console.error(`✗ ${e.message}`)
    process.exitCode = 1
  }
}
