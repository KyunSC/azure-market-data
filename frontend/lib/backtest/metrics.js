/**
 * Performance statistics for a completed run.
 *
 * Everything is computed from the per-bar equity curve except the trade-level
 * stats (hit rate, profit factor, expectancy), which come from closed trades.
 * Annualisation uses the bar count implied by the interval rather than a
 * hard-coded constant, so a 5m run and a 1d run are comparable.
 */

const TRADING_DAYS = 252
const RTH_MINUTES = 390

/** Bars per year for an interval label, matching the ML harness's convention
 *  of counting only regular-hours bars. */
export function periodsPerYear(interval) {
  const m = {
    '1m': 1, '2m': 2, '5m': 5, '15m': 15, '30m': 30, '60m': 60, '1h': 60, '4h': 240,
  }[interval]
  if (m) return TRADING_DAYS * Math.max(1, Math.round(RTH_MINUTES / m))
  if (interval === '1d') return TRADING_DAYS
  if (interval === '1wk') return 52
  if (interval === '1mo') return 12
  return TRADING_DAYS
}

function mean(a) {
  if (!a.length) return 0
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]
  return s / a.length
}

function std(a, ddof = 1) {
  if (a.length <= ddof) return 0
  const m = mean(a)
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2
  return Math.sqrt(s / (a.length - ddof))
}

export function sharpe(returns, ppy) {
  const sd = std(returns)
  return sd > 0 ? (mean(returns) / sd) * Math.sqrt(ppy) : 0
}

export function sortino(returns, ppy) {
  const downside = []
  for (let i = 0; i < returns.length; i++) if (returns[i] < 0) downside.push(returns[i])
  if (!downside.length) return mean(returns) > 0 ? Infinity : 0
  let s = 0
  for (let i = 0; i < downside.length; i++) s += downside[i] ** 2
  const dd = Math.sqrt(s / returns.length)
  return dd > 0 ? (mean(returns) / dd) * Math.sqrt(ppy) : 0
}

/** Max drawdown as a positive fraction, plus the longest underwater stretch. */
export function drawdown(equity) {
  let peak = equity[0] || 1
  let maxDd = 0
  let peakIdx = 0
  let longest = 0
  let troughIdx = 0
  let curve = new Float64Array(equity.length)
  for (let i = 0; i < equity.length; i++) {
    if (equity[i] > peak) {
      peak = equity[i]
      longest = Math.max(longest, i - peakIdx)
      peakIdx = i
    }
    const dd = peak > 0 ? equity[i] / peak - 1 : 0
    curve[i] = dd
    if (dd < -maxDd) {
      maxDd = -dd
      troughIdx = i
    }
  }
  longest = Math.max(longest, equity.length - 1 - peakIdx)
  return { maxDd, curve, duration: longest, troughIdx }
}

export function computeMetrics({ equity, returns, trades, barsInMarket, interval, initialCapital }) {
  const ppy = periodsPerYear(interval)
  const n = equity.length
  const last = equity[n - 1] ?? initialCapital
  const totalReturn = initialCapital > 0 ? last / initialCapital - 1 : 0
  const years = n > 0 ? n / ppy : 0
  const cagr = years > 0 && last > 0 ? (last / initialCapital) ** (1 / years) - 1 : 0
  const { maxDd, curve, duration } = drawdown(equity)

  let wins = 0
  let grossWin = 0
  let grossLoss = 0
  let bestTrade = 0
  let worstTrade = 0
  let sumBars = 0
  for (const t of trades) {
    if (t.pnl > 0) {
      wins++
      grossWin += t.pnl
    } else {
      grossLoss -= t.pnl
    }
    bestTrade = Math.max(bestTrade, t.pnlPct)
    worstTrade = Math.min(worstTrade, t.pnlPct)
    sumBars += t.bars
  }
  const nTrades = trades.length
  const losses = nTrades - wins

  return {
    totalReturn,
    finalEquity: last,
    cagr,
    sharpe: sharpe(returns, ppy),
    sortino: sortino(returns, ppy),
    volAnn: std(returns) * Math.sqrt(ppy),
    maxDd,
    maxDdDuration: duration,
    calmar: maxDd > 0 ? cagr / maxDd : 0,
    hitRate: nTrades ? wins / nTrades : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    expectancy: nTrades ? (grossWin - grossLoss) / nTrades : 0,
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: losses ? grossLoss / losses : 0,
    nTrades,
    avgBarsHeld: nTrades ? sumBars / nTrades : 0,
    exposure: n ? barsInMarket / n : 0,
    turnover: years > 0 ? nTrades / years : 0,
    ddCurve: curve,
    periodsPerYear: ppy,
  }
}

/** Buy-and-hold benchmark on the same capital, anchored at the first traded
 *  bar so a walk-forward fold compares against holding over the same window. */
export function buyHoldCurve(ds, initialCapital, start = 0) {
  const n = ds.close.length
  const out = new Float64Array(n).fill(initialCapital)
  const base = ds.close[start]
  for (let i = start; i < n; i++) out[i] = (initialCapital * ds.close[i]) / base
  return out
}

/**
 * Stationary block bootstrap over trade returns — the same technique the ML
 * harness uses for its IC confidence intervals, applied here to equity paths.
 * Blocks preserve the short-range autocorrelation that an i.i.d. resample
 * destroys (and that flatters a trend strategy's confidence band).
 */
export function blockBootstrapPaths(tradeReturns, { paths = 1000, blockSize = 5, seed = 42 } = {}) {
  const n = tradeReturns.length
  if (n < 2) return { curves: [], finals: [], maxDds: [] }
  const rng = mulberry32(seed)
  const nBlocks = Math.ceil(n / blockSize)
  const curves = []
  const finals = new Float64Array(paths)
  const maxDds = new Float64Array(paths)

  for (let p = 0; p < paths; p++) {
    const path = new Float64Array(n + 1)
    path[0] = 1
    let k = 0
    let peak = 1
    let maxDd = 0
    for (let b = 0; b < nBlocks && k < n; b++) {
      const start = Math.floor(rng() * Math.max(1, n - blockSize + 1))
      for (let j = 0; j < blockSize && k < n; j++, k++) {
        const r = tradeReturns[(start + j) % n]
        path[k + 1] = path[k] * (1 + r)
        if (path[k + 1] > peak) peak = path[k + 1]
        const dd = 1 - path[k + 1] / peak
        if (dd > maxDd) maxDd = dd
      }
    }
    curves.push(path)
    finals[p] = path[n]
    maxDds[p] = maxDd
  }
  return { curves, finals, maxDds }
}

export function percentile(sorted, q) {
  if (!sorted.length) return 0
  const idx = (sorted.length - 1) * q
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

/** Percentile bands across bootstrap paths, shaped for the visx fan chart. */
export function fanChart(curves, quantiles = [0.05, 0.25, 0.5, 0.75, 0.95]) {
  if (!curves.length) return { steps: 0, bands: [] }
  const steps = curves[0].length
  const bands = quantiles.map(() => new Float64Array(steps))
  const col = new Float64Array(curves.length)
  for (let s = 0; s < steps; s++) {
    for (let c = 0; c < curves.length; c++) col[c] = curves[c][s]
    const sorted = Array.from(col).sort((a, b) => a - b)
    quantiles.forEach((q, qi) => {
      bands[qi][s] = percentile(sorted, q)
    })
  }
  return { steps, quantiles, bands }
}

function mulberry32(a) {
  return function rand() {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
