/**
 * Terminal state.
 *
 * Ten panels read from one run; prop-drilling that through a resizable grid
 * would be worse than the store. Every mutation that changes what a number
 * means (dataset, strategy, params, costs) invalidates the derived panels —
 * a sweep heatmap left over from the previous dataset is a lie.
 */

import { create } from 'zustand'
import { STRATEGIES, getStrategy, defaultParams, sweepableParams, strategyAvailable } from './strategies'
import { DEFAULT_COSTS, DEFAULT_RISK } from './engine'
import { ENGINE_VERSION, loadLiveDataset, loadResearchDataset, loadResearchIndex } from './datasets'
import { axisValues } from './analytics'
import * as runner from './runner'
import { emptyRule, newCompare } from './ruleAst'

const initialParams = () => {
  const out = {}
  for (const s of STRATEGIES) out[s.id] = defaultParams(s.id)
  return out
}

const DEFAULT_RULE = {
  entryLong: { t: 'and', items: [newCompare('close', 'crossesAbove', 'sma:20')] },
  exitLong: { t: 'and', items: [newCompare('close', 'crossesBelow', 'sma:20')] },
  entryShort: emptyRule(),
  exitShort: emptyRule(),
}

export const useBacktest = create((rawSet, get) => {
  let revision = 0
  let controller
  let mcGeneration = 0
  const inputKeys = ['plane', 'liveSymbol', 'livePeriod', 'liveInterval', 'researchSymbol', 'researchDatasetId', 'example', 'strategyId', 'paramsByStrategy', 'costs', 'risk', 'rule']
  const cleared = () => ({ result: null, running: false, runError: null, costCurve: null, selectedTrade: null,
    sweep: { ...get().sweep, running: false, data: null, error: null },
    wf: { ...get().wf, running: false, data: null, error: null },
    mc: { ...get().mc, running: false, data: null, error: null } })
  const set = (patch) => {
    const update = typeof patch === 'function' ? patch(get()) : patch
    if (inputKeys.some(key => key in update)) {
      revision++
      rawSet({ ...update, ...cleared() })
    } else rawSet(update)
  }
  return ({
  // ── dataset ────────────────────────────────────────────────────────────
  plane: 'research',
  liveSymbol: 'QQQ',
  livePeriod: '1mo',
  liveInterval: '5m',
  researchSymbol: 'QQQ',
  researchDatasetId: null,
  example: false,
  researchIndex: null,
  dataset: null,
  datasetLoading: true,
  datasetError: null,
  configError: null,

  // ── configuration ──────────────────────────────────────────────────────
  strategyId: 'gexWallFade',
  paramsByStrategy: initialParams(),
  costs: { ...DEFAULT_COSTS },
  risk: { ...DEFAULT_RISK, flatAtSessionEnd: true },
  rule: DEFAULT_RULE,

  // ── results ────────────────────────────────────────────────────────────
  result: null,
  running: false,
  runError: null,
  runCount: 0,
  lastRunMs: 0,
  autoRun: true,

  sweep: { running: false, progress: 0, data: null, xKey: null, yKey: null, steps: 12, error: null },
  wf: { running: false, progress: 0, data: null, error: null },
  mc: { running: false, data: null, blockSize: 5, paths: 1000, error: null },
  costCurve: null,

  slots: { A: null, B: null, C: null },
  focusedParam: null,
  selectedTrade: null,
  paletteOpen: false,
  shortcutsOpen: false,
  activeTab: 'blotter',

  // ── dataset actions ────────────────────────────────────────────────────
  async loadDataset() {
    controller?.abort()
    controller = new AbortController()
    const { signal } = controller
    revision++
    const { plane, liveSymbol, livePeriod, liveInterval, researchSymbol, researchDatasetId, example } = get()
    set({ ...cleared(), dataset: null, datasetLoading: true, datasetError: null })
    try {
      let id = researchDatasetId
      if (plane === 'research') {
        const index = await loadResearchIndex(signal, example).catch(error => {
          if (!id || signal.aborted) throw error
          return { datasets: [] }
        })
        if (signal.aborted) return
        set({ researchIndex: index })
        if (!id && !example) id = index.datasets.find(d => d.symbol === researchSymbol)?.id
        if (!id && !example) throw new Error(`No published dataset for ${researchSymbol}`)
      }
      const ds = plane === 'research'
        ? await loadResearchDataset({ symbol: researchSymbol, id, signal, example })
        : await loadLiveDataset({ symbol: liveSymbol, period: livePeriod, interval: liveInterval, signal })
      if (signal.aborted) return
      await runner.ensureDataset(ds)
      if (signal.aborted) return
      set({
        dataset: ds,
        datasetLoading: false,
        result: null,
        sweep: { ...get().sweep, data: null, error: null },
        wf: { ...get().wf, data: null, error: null },
        mc: { ...get().mc, data: null, error: null },
        costCurve: null,
        selectedTrade: null,
      })
      // A strategy that needs GEX features cannot run on the live plane.
      const strat = getStrategy(get().strategyId)
      if (!strategyAvailable(strat, ds)) {
        set({ strategyId: 'smaCross' })
      }
      get().ensureSweepAxes()
      if (get().autoRun) get().run()
    } catch (e) {
      if (signal.aborted) return
      set({ datasetLoading: false, datasetError: e.message || String(e), dataset: null })
    }
  },

  refreshDataset() {
    set({ researchDatasetId: null })
    get().loadDataset()
  },

  setExample(example) {
    set({ example, researchDatasetId: null })
    get().loadDataset()
  },

  async loadResearchIndex() {
    try {
      set({ researchIndex: await loadResearchIndex() })
    } catch {
      set({ researchIndex: { datasets: [], error: true } })
    }
  },

  setPlane(plane) {
    if (plane === get().plane) return
    // Drop a research-only strategy up front rather than after the fetch — the
    // live plane can take 30s to answer while Render cold-boots, and leaving a
    // GEX strategy selected over live bars in the meantime is nonsense.
    const patch = { plane }
    if (plane !== 'research' && getStrategy(get().strategyId).plane === 'research') {
      patch.strategyId = 'smaCross'
    }
    set(patch)
    get().loadDataset()
  },

  setLive(patch) {
    set(patch)
    if (get().plane === 'live') get().loadDataset()
  },

  setResearchSymbol(symbol) {
    set({ researchSymbol: symbol, researchDatasetId: null })
    if (get().plane === 'research') get().loadDataset()
  },

  // ── config actions ─────────────────────────────────────────────────────
  setStrategy(id) {
    if (get().dataset && !strategyAvailable(getStrategy(id), get().dataset)) return
    set({ strategyId: id, result: null, sweep: { ...get().sweep, data: null }, wf: { ...get().wf, data: null }, mc: { ...get().mc, data: null }, costCurve: null })
    get().ensureSweepAxes()
    if (get().autoRun) get().run()
  },

  setParam(key, value) {
    const { strategyId, paramsByStrategy } = get()
    set({
      paramsByStrategy: {
        ...paramsByStrategy,
        [strategyId]: { ...paramsByStrategy[strategyId], [key]: value },
      },
    })
    if (get().autoRun) get().run()
  },

  setParams(params) {
    const { strategyId, paramsByStrategy } = get()
    set({ paramsByStrategy: { ...paramsByStrategy, [strategyId]: { ...paramsByStrategy[strategyId], ...params } } })
    if (get().autoRun) get().run()
  },

  resetParams() {
    const { strategyId, paramsByStrategy } = get()
    set({ paramsByStrategy: { ...paramsByStrategy, [strategyId]: defaultParams(strategyId) } })
    get().run()
  },

  setCosts(patch) {
    set({ costs: { ...get().costs, ...patch } })
    if (get().autoRun) get().run()
  },

  setRisk(patch) {
    set({ risk: { ...get().risk, ...patch } })
    if (get().autoRun) get().run()
  },

  setRule(slot, node) {
    set({ rule: { ...get().rule, [slot]: node } })
    if (get().strategyId === 'custom' && get().autoRun) get().run()
  },

  setFocusedParam(key) {
    set({ focusedParam: key })
  },

  /** `[` / `]` step the focused parameter — keyboard-first param search. */
  nudgeFocusedParam(dir) {
    const { focusedParam, strategyId } = get()
    const schema = getStrategy(strategyId).params.find((p) => p.key === focusedParam)
    if (!schema || schema.type !== 'number') return
    const cur = get().currentParams()[focusedParam]
    const step = schema.step ?? 1
    const next = Math.min(schema.max ?? Infinity, Math.max(schema.min ?? -Infinity, Number((cur + dir * step).toFixed(4))))
    get().setParam(focusedParam, next)
  },

  currentParams() {
    const { strategyId, paramsByStrategy, rule } = get()
    const p = { ...paramsByStrategy[strategyId] }
    if (strategyId === 'custom') p.rule = rule
    return p
  },

  runConfig(extra = {}) {
    const { dataset, strategyId, costs, risk } = get()
    return {
      datasetId: dataset.id,
      datasetVersion: dataset.version,
      engineVersion: ENGINE_VERSION,
      strategyId,
      params: get().currentParams(),
      costs,
      risk,
      ...extra,
    }
  },

  // ── run ────────────────────────────────────────────────────────────────
  async run() {
    const { dataset } = get()
    if (!dataset || get().datasetLoading || get().running) return
    if (!strategyAvailable(getStrategy(get().strategyId), dataset)) return
    const token = revision
    const config = get().runConfig()
    set({ running: true, runError: null })
    try {
      await runner.ensureDataset(dataset)
      if (token !== revision) return
      const result = await runner.run(config)
      if (token !== revision) return
      result.provenance = config
      set((s) => ({
        result,
        running: false,
        runCount: s.runCount + 1,
        lastRunMs: result.elapsedMs,
        mc: { ...s.mc, running: false, data: null },
        costCurve: null,
      }))
    } catch (e) {
      if (token !== revision) return
      set({ running: false, runError: e.message || String(e) })
    }
  },

  // ── sweep ──────────────────────────────────────────────────────────────
  ensureSweepAxes() {
    const params = sweepableParams(get().strategyId)
    const { sweep } = get()
    const has = (k) => params.some((p) => p.key === k)
    if (!params.length) {
      set({ sweep: { ...sweep, xKey: null, yKey: null, data: null } })
      return
    }
    const xKey = has(sweep.xKey) ? sweep.xKey : params[0].key
    const yKey = has(sweep.yKey) && sweep.yKey !== xKey ? sweep.yKey : (params[1]?.key ?? params[0].key)
    set({ sweep: { ...sweep, xKey, yKey, data: null } })
  },

  setSweepAxis(axis, key) {
    revision++
    set(cleared())
    set({ sweep: { ...get().sweep, [axis]: key, data: null } })
  },

  setSweepSteps(steps) {
    revision++
    set(cleared())
    set({ sweep: { ...get().sweep, steps, data: null } })
  },

  async runSweep() {
    const { dataset, sweep, strategyId } = get()
    if (!dataset || get().datasetLoading || sweep.running) return
    const token = revision
    const config = get().runConfig()
    const params = getStrategy(strategyId).params
    const xParam = params.find((p) => p.key === sweep.xKey)
    const yParam = params.find((p) => p.key === sweep.yKey)
    if (!xParam || !yParam) {
      set({ sweep: { ...sweep, error: 'This strategy has no numeric parameters to sweep.' } })
      return
    }
    set({ sweep: { ...sweep, running: true, progress: 0, error: null } })
    try {
      await runner.ensureDataset(dataset)
      if (token !== revision) return
      const data = await runner.sweep(
        { ...config,
          xKey: sweep.xKey,
          yKey: sweep.yKey,
          xValues: axisValues(xParam, sweep.steps),
          yValues: axisValues(yParam, sweep.steps),
        },
        (done, total) => token === revision && set((s) => ({ sweep: { ...s.sweep, progress: done / total } })),
      )
      if (token !== revision) return
      set((s) => ({
        sweep: { ...s.sweep, running: false, progress: 1, data },
        runCount: s.runCount + data.trials,
      }))
    } catch (e) {
      if (token !== revision) return
      set((s) => ({ sweep: { ...s.sweep, running: false, error: e.message || String(e) } }))
    }
  },

  /** Clicking a heatmap cell adopts its parameters — the shortest path from
   *  "that corner looks good" to "show me the trades". */
  applySweepCell(cell) {
    const { sweep } = get()
    get().setParams({ [sweep.xKey]: cell.x, [sweep.yKey]: cell.y })
  },

  // ── walk-forward ───────────────────────────────────────────────────────
  async runWalkForward() {
    const { dataset, sweep, strategyId, wf } = get()
    if (!dataset || get().datasetLoading || wf.running) return
    const token = revision
    const config = get().runConfig()
    set({ wf: { ...wf, running: true, progress: 0, error: null } })
    try {
      await runner.ensureDataset(dataset)
      if (token !== revision) return
      const params = getStrategy(strategyId).params
      const xParam = params.find((p) => p.key === sweep.xKey)
      const yParam = params.find((p) => p.key === sweep.yKey)
      const steps = Math.min(7, sweep.steps)
      const data = await runner.walkForward(
        { ...config,
          xKey: xParam?.key ?? null,
          xValues: xParam ? axisValues(xParam, steps) : [],
          yKey: yParam && yParam.key !== xParam?.key ? yParam.key : null,
          yValues: yParam && yParam.key !== xParam?.key ? axisValues(yParam, steps) : [],
          nSplits: 5,
        },
        (done, total) => token === revision && set((s) => ({ wf: { ...s.wf, progress: done / total } })),
      )
      if (token !== revision) return
      set((s) => ({
        wf: { ...s.wf, running: false, progress: 1, data },
        runCount: s.runCount + data.folds.length * data.trialsPerFold,
      }))
    } catch (e) {
      if (token !== revision) return
      set((s) => ({ wf: { ...s.wf, running: false, error: e.message || String(e) } }))
    }
  },

  // ── monte carlo ────────────────────────────────────────────────────────
  setMcOption(patch) {
    mcGeneration++
    set({ mc: { ...get().mc, ...patch, running: false, data: null } })
  },

  async runMonteCarlo() {
    const token = revision
    const { result, mc, costs } = get()
    if (!result || mc.running) return
    const generation = ++mcGeneration
    if (!result.trades.length) {
      set({ mc: { ...mc, error: 'No trades to resample — run a strategy that trades first.' } })
      return
    }
    set({ mc: { ...mc, running: true, error: null } })
    try {
      const data = await runner.monteCarlo({
        trades: result.trades.map((t) => ({ pnlPct: t.pnlPct })),
        paths: mc.paths,
        blockSize: mc.blockSize,
        initialCapital: costs.initialCapital,
      })
      if (token !== revision || generation !== mcGeneration || get().result !== result) return
      set((s) => ({ mc: { ...s.mc, running: false, data } }))
    } catch (e) {
      if (token !== revision || generation !== mcGeneration || get().result !== result) return
      set((s) => ({ mc: { ...s.mc, running: false, error: e.message || String(e) } }))
    }
  },

  // ── cost sensitivity ───────────────────────────────────────────────────
  async runCostCurve() {
    const { dataset } = get()
    if (!dataset) return
    const token = revision
    const config = get().runConfig()
    try {
      await runner.ensureDataset(dataset)
      if (token !== revision) return
      const data = await runner.costCurve(config)
      if (token !== revision) return
      set({ costCurve: data })
    } catch {
      if (token !== revision) return
      set({ costCurve: null })
    }
  },

  // ── compare slots ──────────────────────────────────────────────────────
  saveSlot(slot) {
    const { result, strategyId, dataset } = get()
    if (!result) return
    set({
      slots: {
        ...get().slots,
        [slot]: {
          label: getStrategy(strategyId).label,
          symbol: dataset.symbol,
          plane: dataset.plane,
          datasetId: dataset.id,
          datasetVersion: dataset.version,
          engineVersion: ENGINE_VERSION,
          costs: { ...get().costs },
          risk: { ...get().risk },
          rule: get().rule,
          period: get().livePeriod,
          interval: get().liveInterval,
          example: get().example,
          params: { ...get().currentParams() },
          strategyId,
          metrics: result.metrics,
          equity: result.equity,
          windowStart: result.windowStart,
          savedAt: Date.now(),
        },
      },
    })
  },

  clearSlot(slot) {
    set({ slots: { ...get().slots, [slot]: null } })
  },

  loadSlot(slot) {
    const s = get().slots[slot]
    if (!s) return
    get().hydrate({ ...s, researchDatasetId: s.plane === 'research' && !s.example ? s.datasetId : null })
    get().loadDataset()
  },

  // ── ui ─────────────────────────────────────────────────────────────────
  setTab(activeTab) {
    set({ activeTab })
  },
  selectTrade(trade) {
    set({ selectedTrade: trade })
  },
  togglePalette(open) {
    set({ paletteOpen: open ?? !get().paletteOpen })
  },
  toggleShortcuts(open) {
    set({ shortcutsOpen: open ?? !get().shortcutsOpen })
  },
  toggleAutoRun() {
    set({ autoRun: !get().autoRun })
  },

  /** Restores a shared configuration before the first dataset load. */
  hydrate(config) {
    if (!config) return
    if (config.engineVersion && config.engineVersion !== ENGINE_VERSION) {
      set({ autoRun: false, configError: 'This link uses an unsupported engine version. Run manually to use the current engine.' })
    }
    const patch = {}
    patch.researchDatasetId = config.researchDatasetId || null
    patch.example = Boolean(config.example)
    if (config.plane) patch.plane = config.plane
    if (config.symbol) {
      if ((config.plane || get().plane) === 'research') patch.researchSymbol = config.symbol
      else patch.liveSymbol = config.symbol
    }
    if (config.period) patch.livePeriod = config.period
    if (config.interval) patch.liveInterval = config.interval
    if (config.strategyId) patch.strategyId = config.strategyId
    if (config.params) {
      patch.paramsByStrategy = {
        ...get().paramsByStrategy,
        [config.strategyId || get().strategyId]: {
          ...get().paramsByStrategy[config.strategyId || get().strategyId],
          ...config.params,
        },
      }
    }
    if (config.costs) patch.costs = { ...get().costs, ...config.costs }
    if (config.risk) patch.risk = { ...get().risk, ...config.risk }
    if (config.rule) patch.rule = config.rule
    set(patch)
  },
})})
