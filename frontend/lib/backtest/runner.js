/**
 * Worker front-end with a main-thread fallback.
 *
 * Everything the panels call goes through here. If the browser refuses to build
 * the worker (older Safari, a strict CSP, SSR), the identical functions run
 * inline instead — slower and it blocks paint, but the terminal still works
 * rather than showing an empty panel.
 */

import * as Comlink from 'comlink'
import { runBacktest, summarize } from './engine'
import { getStrategy } from './strategies'
import { runSweep, runWalkForward, runMonteCarlo, runCostCurve } from './analytics'
import { serializeDataset } from './datasets'

let workerApi = null
let workerHandle = null
let workerFailed = false
const localDatasets = new Map()

function getWorker() {
  if (workerApi || workerFailed) return workerApi
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    workerFailed = true
    return null
  }
  try {
    workerHandle = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    workerApi = Comlink.wrap(workerHandle)
    return workerApi
  } catch {
    workerFailed = true
    return null
  }
}

export function workerAvailable() {
  return Boolean(getWorker())
}

/** Ships the dataset across once per id; later calls only send the id. */
export async function ensureDataset(ds) {
  const api = getWorker()
  if (!api) {
    localDatasets.set(ds.id, ds)
    if (localDatasets.size > 4) localDatasets.delete(localDatasets.keys().next().value)
    return false
  }
  if (!(await api.hasDataset(ds.id))) {
    await api.putDataset(serializeDataset(ds))
  }
  return true
}

function local(datasetId) {
  const ds = localDatasets.get(datasetId)
  if (!ds) throw new Error('Dataset not loaded')
  return ds
}

export async function run(config) {
  const api = getWorker()
  if (!api) {
    return runBacktest({
      dataset: local(config.datasetId),
      strategy: getStrategy(config.strategyId),
      params: config.params,
      costs: config.costs,
      risk: config.risk,
      window: config.window,
    })
  }
  return api.run(config)
}

export async function sweep(config, onProgress) {
  const api = getWorker()
  if (!api) {
    return runSweep({ ...config, dataset: local(config.datasetId) }, onProgress)
  }
  return api.sweep(config, onProgress ? Comlink.proxy(onProgress) : undefined)
}

export async function walkForward(config, onProgress) {
  const api = getWorker()
  if (!api) {
    return runWalkForward({ ...config, dataset: local(config.datasetId) }, onProgress)
  }
  return api.walkForward(config, onProgress ? Comlink.proxy(onProgress) : undefined)
}

export async function monteCarlo(config) {
  const api = getWorker()
  if (!api) return runMonteCarlo(config)
  return api.monteCarlo(config)
}

export async function costCurve(config) {
  const api = getWorker()
  if (!api) return runCostCurve({ ...config, dataset: local(config.datasetId) })
  return api.costCurve(config)
}

export { summarize }

export function disposeRunner() {
  if (workerHandle) {
    workerHandle.terminate()
    workerHandle = null
    workerApi = null
  }
}
