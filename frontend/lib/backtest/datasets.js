/**
 * The two data planes.
 *
 * LIVE     — `/api/historical`, any symbol the ingester covers, 1m→1wk. No GEX
 *            history: the API only ever exposes the current gamma snapshot.
 * RESEARCH — versioned artifacts served by `/api/backtest/datasets`, produced
 *            offline from the ML pipeline. Bundled JSON is an explicit example
 *            option. Both carry historical GEX and optional model predictions.
 *
 * Both planes normalise to the same columnar shape so the engine never has to
 * ask where its bars came from.
 */

const NA = Number.NaN
export const ENGINE_VERSION = '1'

export function validateDataset(j) {
  const n = j.bars
  if (!Number.isInteger(n) || n < 2) throw new Error('Dataset needs at least two completed bars')
  for (const key of ['time', 'open', 'high', 'low', 'close', 'volume']) {
    if (j[key]?.length !== n || !Array.from(j[key]).every(Number.isFinite)) throw new Error(`Invalid ${key} column`)
  }
  for (let i = 0; i < n; i++) {
    if (j.time[i] <= 0 || j.time[i] > Date.now() / 1000 || (i && j.time[i] <= j.time[i - 1])) throw new Error('Invalid or duplicate timestamps')
    if (j.low[i] <= 0 || j.low[i] > Math.min(j.open[i], j.close[i]) || j.high[i] < Math.max(j.open[i], j.close[i]) || j.volume[i] < 0) throw new Error(`Invalid OHLCV at bar ${i}`)
  }
  if (j.start && Date.parse(j.start) !== j.time[0] * 1000) throw new Error('Invalid coverage start')
  if (j.end && Date.parse(j.end) !== j.time[n - 1] * 1000) throw new Error('Invalid coverage end')
  for (const values of Object.values(j.features || {})) {
    if (values.length !== n || !values.every(v => v === null || Number.isFinite(v))) throw new Error('Invalid feature column')
  }
  if (j.ml) for (const key of ['pred', 'target_return', 'fold']) {
    if (j.ml[key]?.length !== n || !j.ml[key].every(v => v === null || Number.isFinite(v))) throw new Error(`Invalid ML ${key}`)
  }
  if (j.ml) for (let i = 0; i < n; i++) {
    if (j.ml.pred[i] !== null && (i < j.ml.oosStart || j.ml.fold[i] === null)) throw new Error('Prediction outside OOS coverage')
  }
}

async function fetchJson(url, signal) {
  const key = `backtestCache:${url}`
  try {
    const res = await fetch(url, { signal, cache: 'no-cache' })
    if (!res.ok) {
      const message = res.status === 404 ? 'Dataset version unavailable' : `Dataset service unavailable (${res.status})`
      const error = new Error(message)
      error.status = res.status
      throw error
    }
    const data = await res.json()
    if (url.startsWith('/api/backtest/')) {
      try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), data })) } catch { /* Storage is optional. */ }
    }
    return data
  } catch (error) {
    if (signal?.aborted || error.status === 404 || error.status === 400) throw error
    try {
      const cached = JSON.parse(localStorage.getItem(key))
      if (cached && Date.now() - cached.at < 86400000) return { ...cached.data, cached: true }
    } catch { /* No usable cache. */ }
    throw error
  }
}

export const LIVE_SYMBOLS = ['QQQ', 'SPY', 'NQ=F', 'ES=F', 'BTC-USD', 'ETH-USD']
export const LIVE_PERIODS = ['5d', '1mo', '3mo', '6mo', '1y', '2y']
export const LIVE_INTERVALS = ['5m', '15m', '30m', '1h', '4h', '1d']

const toF64 = (arr) => {
  const out = new Float64Array(arr.length)
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]
    out[i] = v === null || v === undefined ? NA : v
  }
  return out
}

/** `/api/historical` rows → columnar dataset. */
export function normalizeBars(rows, meta) {
  const n = rows.length
  const time = new Float64Array(n)
  const open = new Float64Array(n)
  const high = new Float64Array(n)
  const low = new Float64Array(n)
  const close = new Float64Array(n)
  const volume = new Float64Array(n)

  for (let i = 0; i < n; i++) {
    const r = rows[i]
    time[i] = /^\d{4}-\d{2}-\d{2}$/.test(r.time) ? Date.parse(`${r.time}T00:00:00Z`) / 1000 : Number(r.time)
    open[i] = Number(r.open)
    high[i] = Number(r.high)
    low[i] = Number(r.low)
    close[i] = Number(r.close)
    volume[i] = Number(r.volume) || 0
  }
  return { time, open, high, low, close, volume, features: null, ml: null, ...meta }
}

export async function loadLiveDataset({ symbol, period, interval, signal }) {
  const url = `/api/historical?symbol=${encodeURIComponent(symbol)}&period=${period}&interval=${interval}`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Historical fetch failed (${res.status})`)
  const json = await res.json()
  if (json.unavailable) throw new Error('Historical service temporarily unavailable — retry shortly')
  const seconds = { '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '4h': 14400, '1d': 86400 }[interval]
  const rows = (Array.isArray(json) ? json : json.data || []).filter(r => {
    const t = /^\d{4}-\d{2}-\d{2}$/.test(r.time) ? Date.parse(`${r.time}T00:00:00Z`) / 1000 : Number(r.time)
    return t + seconds <= Date.now() / 1000
  })
  if (!rows.length) {
    throw new Error(`No ${interval} bars stored for ${symbol} over ${period}`)
  }

  const ds = normalizeBars(rows, {
    id: `live:${symbol}:${interval}:${period}:${crypto.randomUUID()}`,
    plane: 'live',
    symbol,
    interval,
    period,
  })
  ds.n = rows.length
  validateDataset({ ...ds, bars: ds.n })
  ds.start = ds.time[0] * 1000
  ds.end = ds.time[ds.n - 1] * 1000
  ds.note = 'Live plane — DB-backed OHLCV. No historical GEX.'
  return ds
}

export async function loadResearchIndex(signal, example = false) {
  const catalog = await fetchJson(example ? '/backtest/index.json' : '/api/backtest/datasets', signal)
  if (!Array.isArray(catalog.datasets) || (!example && catalog.schemaVersion !== 1)) throw new Error('Unsupported dataset catalog')
  return catalog
}

export async function loadResearchDataset({ symbol, id, signal, example = false }) {
  if (example && !['QQQ', 'SPY'].includes(symbol)) throw new Error('Example unavailable')
  const j = await fetchJson(example ? `/backtest/${symbol.toLowerCase()}_5m.json` : `/api/backtest/datasets/${encodeURIComponent(id)}`, signal)
  if (!example && (j.schemaVersion !== 1 || j.id !== id || j.symbol !== symbol)) throw new Error('Dataset identity or schema mismatch')
  validateDataset(j)
  if (j.time[j.bars - 1] + 300 > Date.now() / 1000) throw new Error('Research dataset contains an incomplete bar')

  const features = {}
  for (const [k, v] of Object.entries(j.features || {})) features[k] = toF64(v)

  let ml = null
  if (j.ml) {
    ml = {
      pred: toF64(j.ml.pred),
      target: toF64(j.ml.target_return),
      fold: j.ml.fold,
      folds: j.ml.folds,
      overall: j.ml.overall,
      oosStart: j.ml.oosStart,
      model: j.ml.model,
      horizon: j.ml.target,
    }
  }

  return {
    id: example ? `example:${j.symbol}:${j.generatedAt}` : j.id,
    version: j.version,
    schemaVersion: j.schemaVersion,
    example,
    capabilities: j.capabilities || { gex: Boolean(j.featureGroups?.gex?.length), ml: Boolean(j.ml) },
    quality: j.quality,
    cached: Boolean(j.cached),
    plane: 'research',
    symbol: j.symbol,
    interval: j.interval,
    period: `${j.start.slice(0, 10)} → ${j.end.slice(0, 10)}`,
    n: j.bars,
    time: toF64(j.time),
    open: toF64(j.open),
    high: toF64(j.high),
    low: toF64(j.low),
    close: toF64(j.close),
    volume: toF64(j.volume),
    features,
    featureGroups: j.featureGroups,
    ml,
    generatedAt: j.generatedAt,
    horizonMinutes: j.horizonMinutes,
    start: Date.parse(j.start),
    end: Date.parse(j.end),
    note: `${example ? 'Bundled example' : 'Backend dataset'} — ${j.bars} bars. Generated ${j.generatedAt}.`,
  }
}

/** Structured-clone-safe payload for the worker. Typed arrays survive the copy;
 *  the memoised series cache deliberately does not (it is non-enumerable). */
export function serializeDataset(ds) {
  return {
    id: ds.id,
    plane: ds.plane,
    symbol: ds.symbol,
    interval: ds.interval,
    period: ds.period,
    n: ds.n,
    time: ds.time,
    open: ds.open,
    high: ds.high,
    low: ds.low,
    close: ds.close,
    volume: ds.volume,
    features: ds.features,
    ml: ds.ml ? { pred: ds.ml.pred, target: ds.ml.target } : null,
  }
}

export function datasetLabel(ds) {
  if (!ds) return '—'
  return `${ds.symbol} · ${ds.interval} · ${ds.n.toLocaleString()} bars`
}

export function barsPerDay(interval) {
  const m = { '1m': 390, '5m': 78, '15m': 26, '30m': 13, '1h': 7, '4h': 2, '1d': 1 }
  return m[interval] || 1
}
