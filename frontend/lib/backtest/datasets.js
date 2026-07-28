/**
 * The two data planes.
 *
 * LIVE     — `/api/historical`, any symbol the ingester covers, 1m→1wk. No GEX
 *            history: the API only ever exposes the current gamma snapshot.
 * RESEARCH — static JSON exported from `functions/ml/data/*.parquet` by
 *            `functions/ml/export_backtest_data.py`. Bar-aligned historical GEX
 *            plus walk-forward model predictions. It is a build-time data asset,
 *            not an endpoint, which is exactly why the GEX strategies can be
 *            backtested at all.
 *
 * Both planes normalise to the same columnar shape so the engine never has to
 * ask where its bars came from.
 */

const NA = Number.NaN

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
    time[i] = Number(r.time)
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
  const rows = Array.isArray(json) ? json : json.data || []
  if (!rows.length) {
    throw new Error(`No ${interval} bars stored for ${symbol} over ${period}`)
  }

  const ds = normalizeBars(rows, {
    id: `live:${symbol}:${interval}:${period}`,
    plane: 'live',
    symbol,
    interval,
    period,
  })
  ds.n = rows.length
  ds.start = ds.time[0] * 1000
  ds.end = ds.time[ds.n - 1] * 1000
  ds.note = 'Live plane — DB-backed OHLCV. No historical GEX.'
  return ds
}

export async function loadResearchIndex(signal) {
  const res = await fetch('/backtest/index.json', { signal })
  if (!res.ok) throw new Error('Research dataset index not found — run functions/ml/export_backtest_data.py')
  return res.json()
}

export async function loadResearchDataset({ symbol, file, signal }) {
  const name = file || `${symbol.toLowerCase()}_5m.json`
  const res = await fetch(`/backtest/${name}`, { signal })
  if (!res.ok) throw new Error(`Research dataset ${name} not found — run functions/ml/export_backtest_data.py`)
  const j = await res.json()

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
    id: `research:${j.symbol}`,
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
    note: `Research plane — ${j.bars} bars of bar-aligned historical GEX exported from ${j.source}.`,
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
