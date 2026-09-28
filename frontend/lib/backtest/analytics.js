/**
 * Sweep, walk-forward and Monte Carlo. Pure functions over a normalised
 * dataset — the worker calls them, and the main thread calls the same code when
 * a worker cannot be constructed.
 */

import { runBacktest, summarize } from './engine'
import { getStrategy } from './strategies'
import { blockBootstrapPaths, fanChart, percentile } from './metrics'
import { barsPerDay } from './datasets'
import { attachProp } from './prop'

// Every runner takes a registry `strategyId`, or a `strategy` object directly
// (the strategy lab's specs live outside the registry).

/** Inclusive linear axis of `steps` values, integer-snapped when the param is. */
export function axisValues(param, steps) {
  const lo = param.min ?? 0
  const hi = param.max ?? 1
  const integral = (param.step ?? 1) >= 1
  const out = []
  const seen = new Set()
  for (let i = 0; i < steps; i++) {
    const raw = steps === 1 ? lo : lo + ((hi - lo) * i) / (steps - 1)
    const v = integral ? Math.round(raw) : Number(raw.toFixed(4))
    if (!seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * Two-dimensional parameter sweep.
 *
 * Reports the median cell alongside the best one. A best-of-500 Sharpe is a
 * maximum over 500 draws, not an estimate of the strategy's edge — the median
 * is the number that survives the multiple-testing correction in spirit.
 */
export function runSweep({ dataset, strategyId, strategy: strategyObj, params, costs, risk, xKey, yKey, xValues, yValues, window, prop }, onProgress) {
  const strategy = strategyObj ?? getStrategy(strategyId)
  const cells = []
  const total = xValues.length * yValues.length
  let done = 0

  for (let yi = 0; yi < yValues.length; yi++) {
    for (let xi = 0; xi < xValues.length; xi++) {
      const p = { ...params, [xKey]: xValues[xi], [yKey]: yValues[yi] }
      const res = runBacktest({ dataset, strategy, params: p, costs, risk, window })
      const s = summarize(res)
      // Prop cells replay historical starts only; the bootstrap would make a
      // 144-cell sweep ~1000× slower for a colour scale.
      if (prop) {
        const h = attachProp(res, dataset, { prop, costs }, { bootstrap: false, keepAttempts: false }).prop.historical
        s.propEv = h.ev
        s.passRate = h.passRate
      }
      cells.push({ xi, yi, x: xValues[xi], y: yValues[yi], ...s })
      done++
      if (onProgress && (done % 8 === 0 || done === total)) onProgress(done, total)
    }
  }

  const sharpes = cells.map((c) => c.sharpe).filter(Number.isFinite).sort((a, b) => a - b)
  const best = cells.reduce((a, b) => (b.sharpe > (a?.sharpe ?? -Infinity) ? b : a), null)
  const evs = cells.map((c) => c.propEv).filter(Number.isFinite).sort((a, b) => a - b)
  const propSummary = evs.length ? {
    best: cells.reduce((a, b) => (b.propEv > (a?.propEv ?? -Infinity) ? b : a), null),
    median: percentile(evs, 0.5),
    min: evs[0],
    max: evs[evs.length - 1],
  } : null
  return {
    prop: propSummary,
    cells,
    xKey,
    yKey,
    xValues,
    yValues,
    best,
    median: percentile(sharpes, 0.5),
    p25: percentile(sharpes, 0.25),
    p75: percentile(sharpes, 0.75),
    min: sharpes[0] ?? 0,
    max: sharpes[sharpes.length - 1] ?? 0,
    trials: cells.length,
  }
}

/**
 * Expanding-window walk-forward, mirroring `functions/ml/eval.py`: fold k trains
 * on everything before its test slice, never on the slice itself.
 *
 * Each fold optimises the chosen axes in-sample, then trades the winning
 * parameters out-of-sample. `embargoBars` (default one session) are skipped
 * between the training window and each test slice, so a regime or a position
 * still open at the end of training can't flatter the first OOS bars:
 *
 *   [ train ........ ][ embargo ][ test ]
 * The stitched OOS equity is the only curve here that
 * anyone should quote — the IS numbers are shown purely so the gap between them
 * is visible.
 */
export function runWalkForward({ dataset, strategyId, strategy: strategyObj, params, costs, risk, xKey, xValues, yKey, yValues, nSplits = 5, embargoBars, window }, onProgress) {
  const strategy = strategyObj ?? getStrategy(strategyId)
  const embargo = Math.max(0, embargoBars ?? barsPerDay(dataset.interval))
  const grid = []
  const xs = xValues?.length ? xValues : [null]
  const ys = yValues?.length ? yValues : [null]
  for (const x of xs) {
    for (const y of ys) {
      const p = { ...params }
      if (xKey && x !== null) p[xKey] = x
      if (yKey && y !== null) p[yKey] = y
      grid.push(p)
    }
  }

  // Folds tile only the requested window — the locked holdout stays unseen —
  // and start after the longest warmup any grid cell needs. Tiling from bar 0
  // instead let a short window hand fold 1 a training range that ended before
  // the warmup did, so "optimising" silently picked the first grid cell.
  const lo = Math.max(0, window?.start ?? 0)
  const hi = Math.min(dataset.close.length - 1, window?.end ?? dataset.close.length - 1)
  const warmup = strategy.warmup ? Math.max(...grid.map((p) => strategy.warmup(p, dataset))) : 0
  const trainStart = Math.max(lo, warmup)
  const testSize = Math.floor((hi - trainStart + 1 - embargo) / (nSplits + 1))
  if (testSize < 2) {
    throw new Error(`Window too short for ${nSplits} walk-forward folds after a ${warmup}-bar warmup and ${embargo}-bar embargo`)
  }
  const firstTest = hi + 1 - nSplits * testSize
  const folds = []

  const stitched = new Float64Array(dataset.close.length).fill(Number.NaN)
  let carry = costs.initialCapital

  for (let k = 0; k < nSplits; k++) {
    const testStart = firstTest + k * testSize
    const testEnd = testStart + testSize - 1
    const trainEnd = testStart - 1 - embargo

    let bestIs = null
    for (const p of grid) {
      const res = runBacktest({ dataset, strategy, params: p, costs, risk, window: { start: trainStart, end: trainEnd } })
      const sh = res.metrics.sharpe
      if (!bestIs || sh > bestIs.sharpe) bestIs = { sharpe: sh, params: p, metrics: res.metrics }
    }

    const oos = runBacktest({
      dataset, strategy, params: bestIs.params, costs, risk,
      window: { start: testStart, end: testEnd },
    })

    // Chain fold equity so the stitched curve compounds across folds.
    const base = costs.initialCapital
    for (let i = testStart; i <= testEnd; i++) stitched[i] = (carry * oos.equity[i]) / base
    carry = stitched[testEnd]

    folds.push({
      fold: k + 1,
      trainStart,
      trainEnd,
      testStart,
      testEnd,
      nTrain: trainEnd - trainStart + 1,
      nTest: testEnd - testStart + 1,
      params: bestIs.params,
      isSharpe: bestIs.sharpe,
      isReturn: bestIs.metrics.totalReturn,
      oosSharpe: oos.metrics.sharpe,
      oosReturn: oos.metrics.totalReturn,
      oosMaxDd: oos.metrics.maxDd,
      oosTrades: oos.metrics.nTrades,
      oosHitRate: oos.metrics.hitRate,
    })
    if (onProgress) onProgress(k + 1, nSplits)
  }

  const oosSharpes = folds.map((f) => f.oosSharpe)
  const isSharpes = folds.map((f) => f.isSharpe)
  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)

  return {
    folds,
    stitched,
    firstTest,
    testSize,
    embargoBars: embargo,
    trialsPerFold: grid.length,
    avgIsSharpe: avg(isSharpes),
    avgOosSharpe: avg(oosSharpes),
    degradation: avg(isSharpes) - avg(oosSharpes),
    positiveFolds: folds.filter((f) => f.oosSharpe > 0).length,
    finalEquity: carry,
    totalReturn: carry / costs.initialCapital - 1,
  }
}

/**
 * Block-bootstrap the sequence of trade returns. Trades, not bars — resampling
 * bars would shred the position logic that produced them.
 */
export function runMonteCarlo({ trades, paths = 1000, blockSize = 5, seed = 42, initialCapital = 100000 }) {
  const rets = trades.map((t) => t.pnlPct).filter(Number.isFinite)
  if (rets.length < 3) return null

  const { curves, finals, maxDds } = blockBootstrapPaths(rets, { paths, blockSize, seed })
  const fan = fanChart(curves)
  const sortedFinals = Array.from(finals).sort((a, b) => a - b)
  const sortedDds = Array.from(maxDds).sort((a, b) => a - b)

  const observedFinal = rets.reduce((acc, r) => acc * (1 + r), 1)

  return {
    fan,
    paths: curves.length,
    blockSize,
    nTrades: rets.length,
    initialCapital,
    observedFinal,
    finals: sortedFinals,
    maxDds: sortedDds,
    finalP05: percentile(sortedFinals, 0.05),
    finalP50: percentile(sortedFinals, 0.5),
    finalP95: percentile(sortedFinals, 0.95),
    ddP50: percentile(sortedDds, 0.5),
    ddP95: percentile(sortedDds, 0.95),
    probLoss: sortedFinals.filter((f) => f < 1).length / sortedFinals.length,
  }
}

/**
 * Cost sensitivity: the same strategy re-run across a slippage ladder. If an
 * edge only exists at zero slippage it does not exist.
 */
export function runCostCurve({ dataset, strategyId, strategy: strategyObj, params, costs, risk, window, ladder = [0, 0.5, 1, 2, 3, 5, 8, 12] }) {
  const strategy = strategyObj ?? getStrategy(strategyId)
  // Futures runs price slippage in ticks, so the same ladder is read as ticks.
  return ladder.map((bps) => {
    const laddered = costs.instrument
      ? { ...costs, instrument: { ...costs.instrument, slippageTicks: bps } }
      : { ...costs, slippageBps: bps }
    const res = runBacktest({ dataset, strategy, params, costs: laddered, risk, window })
    return { slippageBps: bps, sharpe: res.metrics.sharpe, totalReturn: res.metrics.totalReturn, nTrades: res.metrics.nTrades }
  })
}
