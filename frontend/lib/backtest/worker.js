/**
 * Simulation worker.
 *
 * A 500-cell sweep is 500 full passes over the bar array; on the main thread
 * that freezes the UI for seconds. Comlink exposes the same call signatures the
 * main-thread fallback uses, so `runner.js` can swap between them.
 *
 * The dataset is uploaded once per id and cached here — re-sending ~3k bars ×
 * 22 feature columns for every cell would cost more than the simulation.
 */

import * as Comlink from 'comlink'
import { runBacktest, summarize } from './engine'
import { getStrategy } from './strategies'
import { runSweep, runWalkForward, runMonteCarlo, runCostCurve } from './analytics'

const datasets = new Map()

function resolve(datasetId) {
  const ds = datasets.get(datasetId)
  if (!ds) throw new Error(`Dataset ${datasetId} not loaded in worker`)
  return ds
}

const api = {
  hasDataset(id) {
    return datasets.has(id)
  },

  putDataset(ds) {
    datasets.set(ds.id, ds)
    // One dataset per plane is plenty; anything older is a switcher leftover.
    if (datasets.size > 4) datasets.delete(datasets.keys().next().value)
    return true
  },

  run({ datasetId, strategyId, params, costs, risk, window }) {
    const result = runBacktest({
      dataset: resolve(datasetId),
      strategy: getStrategy(strategyId),
      params,
      costs,
      risk,
      window,
    })
    // Drop the memoised series cache from the reply path by returning only
    // plain arrays and the trade list.
    return {
      equity: result.equity,
      returns: result.returns,
      positions: result.positions,
      buyHold: result.buyHold,
      trades: result.trades,
      metrics: result.metrics,
      windowStart: result.windowStart,
      windowEnd: result.windowEnd,
      elapsedMs: result.elapsedMs,
      config: result.config,
    }
  },

  sweep(config, onProgress) {
    return runSweep(
      { ...config, dataset: resolve(config.datasetId) },
      onProgress ? (done, total) => onProgress(done, total) : undefined,
    )
  },

  walkForward(config, onProgress) {
    return runWalkForward(
      { ...config, dataset: resolve(config.datasetId) },
      onProgress ? (done, total) => onProgress(done, total) : undefined,
    )
  },

  monteCarlo(config) {
    return runMonteCarlo(config)
  },

  costCurve(config) {
    return runCostCurve({ ...config, dataset: resolve(config.datasetId) })
  },

  summarizeRun(config) {
    return summarize(api.run(config))
  },
}

Comlink.expose(api)
