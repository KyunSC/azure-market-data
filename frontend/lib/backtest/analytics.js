/**
 * Sweep, walk-forward and Monte Carlo. Pure functions over a normalised
 * dataset — the worker calls them, and the main thread calls the same code when
 * a worker cannot be constructed.
 */

import { runBacktest, summarize } from './engine'
import { getStrategy } from './strategies'
import { blockBootstrapPaths, fanChart, percentile } from './metrics'

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
export function runSweep({ dataset, strategyId, params, costs, risk, xKey, yKey, xValues, yValues, window }, onProgress) {
  const strategy = getStrategy(strategyId)
  const cells = []
  const total = xValues.length * yValues.length
  let done = 0

  for (let yi = 0; yi < yValues.length; yi++) {
    for (let xi = 0; xi < xValues.length; xi++) {
      const p = { ...params, [xKey]: xValues[xi], [yKey]: yValues[yi] }
      const res = runBacktest({ dataset, strategy, params: p, costs, risk, window })
      const s = summarize(res)
      cells.push({ xi, yi, x: xValues[xi], y: yValues[yi], ...s })
      done++
      if (onProgress && (done % 8 === 0 || done === total)) onProgress(done, total)
    }
  }

  const sharpes = cells.map((c) => c.sharpe).filter(Number.isFinite).sort((a, b) => a - b)
  const best = cells.reduce((a, b) => (b.sharpe > (a?.sharpe ?? -Infinity) ? b : a), null)
  return {
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
 * parameters out-of-sample. The stitched OOS equity is the only curve here that
 * anyone should quote — the IS numbers are shown purely so the gap between them
 * is visible.
 */
export function runWalkForward({ dataset, strategyId, params, costs, risk, xKey, xValues, yKey, yValues, nSplits = 5 }, onProgress) {
  const strategy = getStrategy(strategyId)
  const n = dataset.close.length
  const testSize = Math.floor(n / (nSplits + 1))
  const firstTest = n - nSplits * testSize
  const folds = []
  const grid = []
  const xs = xValues?.length ? xValues : [null]
  const ys = yValues?.length ? yValues : [null]
  for (const x of xs) for (const y of ys) grid.push({ x, y })

  const stitched = new Float64Array(n).fill(Number.NaN)
  let carry = costs.initialCapital

  for (let k = 0; k < nSplits; k++) {
    const testStart = firstTest + k * testSize
    const testEnd = Math.min(n - 1, testStart + testSize - 1)
    const trainStart = Math.max(0, strategy.warmup ? strategy.warmup(params, dataset) : 0)
    const trainEnd = testStart - 1

    let bestIs = null
    for (const g of grid) {
      const p = { ...params }
      if (xKey && g.x !== null) p[xKey] = g.x
      if (yKey && g.y !== null) p[yKey] = g.y
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
export function runCostCurve({ dataset, strategyId, params, costs, risk, ladder = [0, 0.5, 1, 2, 3, 5, 8, 12] }) {
  const strategy = getStrategy(strategyId)
  return ladder.map((bps) => {
    const res = runBacktest({ dataset, strategy, params, costs: { ...costs, slippageBps: bps }, risk })
    return { slippageBps: bps, sharpe: res.metrics.sharpe, totalReturn: res.metrics.totalReturn, nTrades: res.metrics.nTrades }
  })
}
