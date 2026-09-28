/**
 * Nightly headless backtests.
 *
 * Runs every strategy the registry offers against fresh live bars and the
 * bundled research datasets, using the same engine the /backtest terminal
 * uses. The question it answers is not "which config scored best" — that is a
 * maximum over noise — but "does the config picked in-sample still make money,
 * after costs, on a locked holdout it never saw".
 *
 * Protocol per (dataset, strategy):
 *   1. Lock the last HOLDOUT_PCT of bars (split snapped to a session boundary).
 *   2. Sweep the first two numeric params on the research window only.
 *   3. Deflate the best in-sample Sharpe by every config tried on the dataset,
 *      across all strategies.
 *   4. Trade the winning config once on the holdout.
 *   5. Walk-forward on the research window, and a slippage ladder on the holdout.
 *   6. Verdicts judge all rows in the report together (Bonferroni holdout CIs).
 *
 * Usage: API_BASE=https://… node scripts/nightly-backtest.mjs
 */

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createJiti } from 'jiti'

const jiti = createJiti(import.meta.url)
const lib = (f) => jiti.import(new URL(`../lib/backtest/${f}`, import.meta.url).href)
const { runBacktest, DEFAULT_COSTS, DEFAULT_RISK } = await lib('engine.js')
const { runSweep, runWalkForward, runCostCurve, axisValues } = await lib('analytics.js')
const { holdoutSplit, deflatedSharpe, normInv } = await lib('stats.js')
const { loadLiveDataset, loadResearchIndex, loadResearchDataset, ENGINE_VERSION } = await lib('datasets.js')
const { strategiesForPlane, defaultParams, sweepableParams } = await lib('strategies/index.js')

const PUBLIC_DIR = new URL('../public/', import.meta.url)
const OUT_DIR = new URL('../backtest-results/', import.meta.url)

export const LIVE_DATASETS = [
  { symbol: 'QQQ', interval: '5m', period: '1mo' },
  { symbol: 'SPY', interval: '5m', period: '1mo' },
  { symbol: 'NQ=F', interval: '5m', period: '1mo' },
  { symbol: 'ES=F', interval: '5m', period: '1mo' },
  { symbol: 'QQQ', interval: '1h', period: '6mo' },
  { symbol: 'SPY', interval: '1h', period: '6mo' },
  { symbol: 'NQ=F', interval: '1h', period: '6mo' },
  { symbol: 'ES=F', interval: '1h', period: '6mo' },
]

export const HOLDOUT_PCT = 25
const SWEEP_STEPS = 6
const WF_SPLITS = 4
const MIN_HOLDOUT_TRADES = 10
const DSR_THRESHOLD = 0.95
const FAMILY_ALPHA = 0.05
const STALE_DAYS = 7
// Live fetches stop being attempted after this, so the report is always
// written well inside the workflow's timeout even if Render hangs.
const LIVE_BUDGET_MS = 25 * 60_000

/**
 * Routes the relative URLs `datasets.js` uses: `/api/*` to the backend,
 * `/backtest/*` to the bundled files under `public/`. Everything else is
 * refused so a stray call can't silently hit the network.
 */
export function makeFetch({ apiBase, timeoutMs = 90_000 } = {}) {
  // Captured now: once this shim is installed as globalThis.fetch, a bare
  // `fetch` inside it would call itself.
  const netFetch = globalThis.fetch
  return async (url, opts = {}) => {
    if (url.startsWith('/backtest/')) {
      try {
        const text = await readFile(new URL(url.slice(1), PUBLIC_DIR), 'utf8')
        return { ok: true, status: 200, json: async () => JSON.parse(text) }
      } catch {
        return { ok: false, status: 404, json: async () => ({}) }
      }
    }
    if (url.startsWith('/api/')) {
      if (!apiBase) throw new Error('No API_BASE configured')
      const signal = opts.signal ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
      return netFetch(apiBase.replace(/\/+$/, '') + url, { signal })
    }
    throw new Error(`Unrouted fetch: ${url}`)
  }
}

/**
 * Worth another try: timeouts, dropped connections, 5xx/429 and the circuit
 * breaker's "temporarily unavailable". A 4xx or an empty series will say the
 * same thing next time, so retrying it only burns the time budget.
 */
export function isTransient(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError) return true
  const msg = e?.message ?? ''
  const status = /\((\d{3})\)/.exec(msg)?.[1]
  if (status) return +status >= 500 || +status === 429
  return /temporarily unavailable/i.test(msg)
}

async function withRetry(fn, { tries = 3, waitMs = 20_000, deadline = Infinity } = {}) {
  let last
  for (let k = 0; k < tries; k++) {
    if (Date.now() >= deadline) {
      throw new Error(`${last ? `${last.message}; ` : ''}live-data time budget exhausted`)
    }
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!isTransient(e)) throw e
      if (k < tries - 1) await new Promise((r) => setTimeout(r, waitMs))
    }
  }
  throw last
}

/**
 * CANDIDATE only when every check passes. A strategy that merely made money on
 * the holdout is WEAK: one positive draw is not evidence of an edge.
 */
export function verdict(row) {
  if (!(row.holdout.nTrades >= MIN_HOLDOUT_TRADES)) return 'INSUFFICIENT'
  if (!(row.holdout.totalReturn > 0)) return 'NO EDGE'
  const ok = row.holdout.familyCi[0] > 0
    && row.research.dsr >= DSR_THRESHOLD
    && row.breakEvenBps > DEFAULT_COSTS.slippageBps
  return ok ? 'CANDIDATE' : 'WEAK'
}

/**
 * Slippage at which the holdout return crosses zero, interpolated between the
 * last profitable rung and the first losing one. Reporting the losing rung
 * itself overstated it by up to a full rung (1.6 bps read as 2.0).
 */
export function breakEven(curve) {
  const k = curve.findIndex((c) => !(c.totalReturn > 0))
  if (k === -1) return Infinity
  if (k === 0) return curve[0].slippageBps
  const a = curve[k - 1]
  const b = curve[k]
  if (!Number.isFinite(b.totalReturn)) return a.slippageBps
  return a.slippageBps + ((b.slippageBps - a.slippageBps) * a.totalReturn) / (a.totalReturn - b.totalReturn)
}

/**
 * Holdout CIs widened for every row judged together (Bonferroni), then
 * verdicts. ~50 (dataset, strategy) rows a night, each at a plain 95% CI,
 * would hand noise a CANDIDATE every few weeks. Bonferroni is conservative
 * here since the rows are correlated (QQQ/NQ, SPY/ES, shared strategies).
 */
export function assignVerdicts(rows) {
  const ok = rows.filter((r) => !r.error)
  const z = normInv(1 - FAMILY_ALPHA / (2 * Math.max(1, ok.length)))
  for (const r of ok) {
    const { sr, se, periodsPerYear } = r.holdout
    const ann = Math.sqrt(periodsPerYear)
    r.holdout.familyCi = Number.isFinite(se) ? [(sr - z * se) * ann, (sr + z * se) * ann] : [Number.NaN, Number.NaN]
    r.verdict = verdict(r)
  }
  return ok.length
}

export function evaluate(dataset, strategy) {
  const n = dataset.close.length
  const { cut, researchEnd, holdoutBars } = holdoutSplit(dataset.time, HOLDOUT_PCT)
  if (!holdoutBars) throw new Error('Dataset too short for a holdout')
  const research = { start: 0, end: researchEnd }
  const holdout = { start: cut, end: n - 1 }
  const costs = { ...DEFAULT_COSTS }
  const risk = { ...DEFAULT_RISK }
  const params = defaultParams(strategy.id)

  const [xp, yp] = sweepableParams(strategy.id)
  if (!xp) throw new Error('No numeric params to sweep')
  const xKey = xp.key
  const xValues = axisValues(xp, SWEEP_STEPS)
  // A one-axis strategy sweeps against a dummy key the strategy never reads.
  const yKey = yp ? yp.key : '_unused'
  const yValues = yp ? axisValues(yp, SWEEP_STEPS) : [0]

  const sweep = runSweep({ dataset, strategyId: strategy.id, params, costs, risk, xKey, yKey, xValues, yValues, window: research })
  const bestParams = { ...params, [xKey]: sweep.best.x }
  if (yp) bestParams[yKey] = sweep.best.y

  const isRun = runBacktest({ dataset, strategy, params: bestParams, costs, risk, window: research })
  const { sr, n: nIs, skew, kurt } = isRun.metrics.inference

  const oos = runBacktest({ dataset, strategy, params: bestParams, costs, risk, window: holdout })
  const m = oos.metrics
  const buyHold = oos.buyHold[n - 1] / costs.initialCapital - 1

  let walkForward
  try {
    const wf = runWalkForward({
      dataset, strategyId: strategy.id, params, costs, risk,
      xKey, xValues, yKey: yp ? yKey : null, yValues: yp ? yValues : null,
      nSplits: WF_SPLITS, window: research,
    })
    walkForward = {
      avgOosSharpe: wf.avgOosSharpe,
      positiveFolds: wf.positiveFolds,
      folds: wf.folds.length,
      totalReturn: wf.totalReturn,
    }
  } catch (e) {
    // A research window too short for the folds is not a reason to drop the
    // holdout result.
    walkForward = { error: e.message || String(e) }
  }
  const costCurve = runCostCurve({ dataset, strategyId: strategy.id, params: bestParams, costs, risk, window: holdout })

  const row = {
    strategy: strategy.id,
    family: strategy.family,
    bestParams: Object.fromEntries([[xKey, sweep.best.x], ...(yp ? [[yKey, sweep.best.y]] : [])]),
    research: {
      bars: researchEnd + 1,
      sharpe: isRun.metrics.sharpe,
      totalReturn: isRun.metrics.totalReturn,
      medianSweepSharpe: sweep.median,
      inference: { sr, n: nIs, skew, kurt },
      // Replaced by the pooled deflation in evaluateDataset.
      trialSrs: sweep.cells.map((c) => c.sr).filter(Number.isFinite),
    },
    holdout: {
      bars: holdoutBars,
      start: dataset.time[cut] * 1000,
      sharpe: m.sharpe,
      sr: m.inference.sr,
      se: m.inference.se,
      periodsPerYear: m.periodsPerYear,
      sharpeCi: m.inference.ci,
      psr: m.inference.psr,
      totalReturn: m.totalReturn,
      buyHoldReturn: buyHold,
      maxDd: m.maxDd,
      nTrades: m.nTrades,
      hitRate: m.hitRate,
    },
    walkForward,
    costCurve,
    breakEvenBps: breakEven(costCurve),
  }
  return row
}

export function evaluateDataset(dataset) {
  const rows = []
  for (const strategy of strategiesForPlane(dataset.plane, dataset)) {
    if (strategy.id === 'custom') continue
    try {
      rows.push(evaluate(dataset, strategy))
    } catch (e) {
      rows.push({ strategy: strategy.id, family: strategy.family, error: e.message || String(e) })
    }
  }
  // Deflate against every config tried on this data, across strategies:
  // choosing the best strategy is as much a search as choosing its params.
  const ok = rows.filter((r) => !r.error)
  const pooled = ok.flatMap((r) => r.research.trialSrs)
  for (const r of ok) {
    Object.assign(r.research, deflatedSharpe(r.research.inference, pooled))
    delete r.research.trialSrs
  }
  // Provisional; main() re-assigns across every dataset in the report.
  assignVerdicts(rows)
  return rows
}

function describe(ds, spec) {
  const ageDays = (Date.now() - ds.end) / 86_400_000
  return {
    label: `${ds.symbol} ${ds.interval} · ${ds.plane}${spec?.period ? ` ${spec.period}` : ''}`,
    plane: ds.plane,
    symbol: ds.symbol,
    interval: ds.interval,
    bars: ds.close.length,
    start: new Date(ds.start).toISOString(),
    end: new Date(ds.end).toISOString(),
    stale: ds.plane === 'research' && ageDays > STALE_DAYS,
  }
}

// --- report -----------------------------------------------------------------

const pct = (v) => (Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : '—')
const num = (v, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : v === Infinity ? '∞' : '—')
const RANK = { CANDIDATE: 0, WEAK: 1, 'NO EDGE': 2, INSUFFICIENT: 3 }

export function toMarkdown(report) {
  const lines = [
    `## Nightly backtest — ${report.generatedAt.slice(0, 10)}`,
    '',
    `Engine v${report.engineVersion} · holdout = last ${report.holdoutPct}% of bars · costs ${report.costs.slippageBps} bps + $${report.costs.commissionPerTrade}/trade.`,
    `**CANDIDATE** = holdout return > 0, holdout Sharpe CI above 0 (Bonferroni-adjusted across ${report.familySize ?? 'all'} rows), deflated Sharpe ≥ ${DSR_THRESHOLD} (trials pooled across every strategy on the dataset), break-even slippage > ${report.costs.slippageBps} bps.`,
    '',
  ]
  const all = report.datasets.flatMap((d) => (d.rows || []).filter((r) => !r.error).map((r) => ({ ...r, dataset: d })))
  all.sort((a, b) => RANK[a.verdict] - RANK[b.verdict] || b.holdout.sharpe - a.holdout.sharpe)

  lines.push('| Verdict | Dataset | Strategy | Params | IS Sharpe | DSR | Holdout Sharpe [family-wise CI] | Holdout ret | B&H ret | Trades | WF OOS Sharpe | Break-even |')
  lines.push('|---|---|---|---|---:|---:|---|---:|---:|---:|---:|---:|')
  for (const r of all) {
    const params = Object.entries(r.bestParams).map(([k, v]) => `${k}=${v}`).join(', ')
    const ds = `${r.dataset.label}${r.dataset.stale ? ' ⚠️ stale' : ''}`
    const h = r.holdout
    lines.push(`| ${r.verdict} | ${ds} | ${r.strategy} | ${params} | ${num(r.research.sharpe)} | ${num(r.research.dsr)} | ${num(h.sharpe)} [${num(h.familyCi[0])}, ${num(h.familyCi[1])}] | ${pct(h.totalReturn)} | ${pct(h.buyHoldReturn)} | ${h.nTrades} | ${r.walkForward.error ? '—' : `${num(r.walkForward.avgOosSharpe)} (${r.walkForward.positiveFolds}/${r.walkForward.folds}+)`} | ${num(r.breakEvenBps, 1)} bps |`)
  }

  const problems = report.datasets.flatMap((d) => [
    ...(d.error ? [`- ${d.label}: dataset failed — ${d.error}`] : []),
    ...(d.rows || []).filter((r) => r.error).map((r) => `- ${d.label} / ${r.strategy}: ${r.error}`),
  ])
  if (problems.length) lines.push('', '### Skipped', ...problems)

  const stale = report.datasets.filter((d) => d.stale)
  if (stale.length) {
    lines.push('', `⚠️ Research datasets end ${[...new Set(stale.map((d) => d.end.slice(0, 10)))].join(', ')} — GEX/ML rows are not re-tested on new data until \`build_dataset.py\` + \`export_backtest_data.py\` are re-run.`)
  }
  return lines.join('\n') + '\n'
}

// --- main -------------------------------------------------------------------

async function main() {
  globalThis.fetch = makeFetch({ apiBase: process.env.API_BASE ?? 'https://azure-market-data.onrender.com' })
  const report = {
    generatedAt: new Date().toISOString(),
    engineVersion: ENGINE_VERSION,
    holdoutPct: HOLDOUT_PCT,
    costs: DEFAULT_COSTS,
    risk: DEFAULT_RISK,
    datasets: [],
  }

  const deadline = Date.now() + LIVE_BUDGET_MS
  for (const spec of LIVE_DATASETS) {
    const label = `${spec.symbol} ${spec.interval} · live ${spec.period}`
    try {
      const ds = await withRetry(() => loadLiveDataset(spec), { deadline })
      const entry = describe(ds, spec)
      console.error(`… ${entry.label} (${entry.bars} bars)`)
      report.datasets.push({ ...entry, rows: evaluateDataset(ds) })
    } catch (e) {
      console.error(`✗ ${label}: ${e.message}`)
      report.datasets.push({ label, plane: 'live', error: e.message || String(e) })
    }
  }

  try {
    const index = await loadResearchIndex(undefined, true)
    for (const { symbol } of index.datasets) {
      try {
        const ds = await loadResearchDataset({ symbol, example: true })
        const entry = describe(ds)
        console.error(`… ${entry.label} (${entry.bars} bars)`)
        report.datasets.push({ ...entry, rows: evaluateDataset(ds) })
      } catch (e) {
        report.datasets.push({ label: `${symbol} · research`, plane: 'research', error: e.message || String(e) })
      }
    }
  } catch (e) {
    report.datasets.push({ label: 'research index', plane: 'research', error: e.message || String(e) })
  }

  report.familySize = assignVerdicts(report.datasets.flatMap((d) => d.rows || []))

  await mkdir(OUT_DIR, { recursive: true })
  const replacer = (_, v) => (v === Infinity ? 'Infinity' : Number.isNaN(v) ? null : v)
  await writeFile(new URL('nightly.json', OUT_DIR), JSON.stringify(report, replacer, 2))
  const md = toMarkdown(report)
  await writeFile(new URL('nightly.md', OUT_DIR), md)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md)
  process.stdout.write(md)

  // A losing strategy is a result. Only "nothing could be tested" is a failure.
  if (report.datasets.every((d) => d.error)) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
