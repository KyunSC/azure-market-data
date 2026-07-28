/**
 * Bar-by-bar simulation.
 *
 * Ordering inside one bar, and the reason for it:
 *   1. fill any order queued on the previous bar, at THIS bar's open
 *   2. check stop / target against this bar's high & low
 *   3. check time and end-of-session exits
 *   4. mark equity to this bar's close
 *   5. ask the strategy for a target position using data up to this close;
 *      a change queues an order for the next bar's open
 *
 * Signals are therefore always acted on one bar late. That single rule is what
 * separates a backtest from a look-ahead fantasy, so it is enforced here rather
 * than left to each strategy.
 */

import { computeMetrics, buyHoldCurve } from './metrics'
import { sessionEndFlags } from './series'

export const DEFAULT_COSTS = {
  initialCapital: 100000,
  slippageBps: 1.5,
  commissionPerTrade: 0.5,
  sizePct: 1,
}

export const DEFAULT_RISK = {
  stopPct: 0,      // 0 = disabled
  targetPct: 0,    // 0 = disabled
  maxBars: 0,      // 0 = disabled
  flatAtSessionEnd: false,
  allowShort: true,
}

const EXIT_REASON = {
  SIGNAL: 'signal',
  STOP: 'stop',
  TARGET: 'target',
  TIME: 'time',
  SESSION: 'session',
  END: 'end-of-data',
}

/**
 * `window` restricts trading to a contiguous bar range without slicing the
 * dataset. Indicators still see the full history, so a walk-forward fold gets
 * the same SMA-200 the full run would — slicing first would silently hand each
 * fold a differently warmed-up indicator.
 */
export function runBacktest({ dataset, strategy, params, costs, risk, window }) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now()
  const ds = dataset
  const n = ds.close.length
  const c = { ...DEFAULT_COSTS, ...costs }
  const r = { ...DEFAULT_RISK, ...risk }
  const wStart = Math.max(0, window?.start ?? 0)
  const wEnd = Math.min(n - 1, window?.end ?? n - 1)

  const slip = c.slippageBps / 10000
  const state = strategy.prepare ? strategy.prepare(ds, params) : null
  const warmup = Math.max(wStart, strategy.warmup ? strategy.warmup(params, ds) : 0)
  const sessionEnd = r.flatAtSessionEnd ? sessionEndFlags(ds.time) : null

  const equity = new Float64Array(n).fill(c.initialCapital)
  const returns = new Float64Array(n)
  const posSeries = new Int8Array(n)
  const trades = []

  let cash = c.initialCapital
  let eq = c.initialCapital
  let pos = 0          // -1 short, 0 flat, +1 long
  let qty = 0
  let entryPrice = 0
  let entryIdx = -1
  let stopPrice = 0
  let targetPrice = 0
  let mfe = 0
  let mae = 0
  let entryFee = 0
  let pending = null   // target position queued for next bar's open
  let barsInMarket = 0
  let prevTarget = 0

  const buyFill = (px) => px * (1 + slip)
  const sellFill = (px) => px * (1 - slip)

  const closePosition = (i, rawPrice, reason) => {
    const fill = pos > 0 ? sellFill(rawPrice) : buyFill(rawPrice)
    const gross = pos > 0 ? (fill - entryPrice) * qty : (entryPrice - fill) * qty
    cash += pos > 0 ? fill * qty : -fill * qty
    cash -= c.commissionPerTrade
    // Both legs are commissioned, and slippage is already inside the fills, so
    // `pnl` and `pnlPct` are what actually landed in the account. The Monte
    // Carlo resamples `pnlPct`, which would flatter the fan if it were gross.
    const fees = entryFee + c.commissionPerTrade
    const net = gross - fees
    const notional = entryPrice * qty
    trades.push({
      side: pos > 0 ? 'long' : 'short',
      entryIdx,
      entryTime: ds.time[entryIdx],
      entryPrice,
      exitIdx: i,
      exitTime: ds.time[i],
      exitPrice: fill,
      qty,
      pnl: net,
      pnlPct: notional > 0 ? net / notional : 0,
      grossPct: pos > 0 ? fill / entryPrice - 1 : entryPrice / fill - 1,
      fees,
      bars: i - entryIdx,
      reason,
      mfe,
      mae,
    })
    pos = 0
    qty = 0
    entryIdx = -1
    mfe = 0
    mae = 0
  }

  const openPosition = (i, dir, rawPrice) => {
    const fill = dir > 0 ? buyFill(rawPrice) : sellFill(rawPrice)
    if (!(fill > 0)) return
    const notional = Math.max(0, eq * c.sizePct)
    qty = notional / fill
    if (!(qty > 0)) {
      qty = 0
      return
    }
    cash -= dir > 0 ? fill * qty : -fill * qty
    cash -= c.commissionPerTrade
    entryFee = c.commissionPerTrade
    pos = dir
    entryPrice = fill
    entryIdx = i
    mfe = 0
    mae = 0
    stopPrice = r.stopPct > 0 ? (dir > 0 ? fill * (1 - r.stopPct / 100) : fill * (1 + r.stopPct / 100)) : 0
    targetPrice = r.targetPct > 0 ? (dir > 0 ? fill * (1 + r.targetPct / 100) : fill * (1 - r.targetPct / 100)) : 0
  }

  for (let i = wStart; i <= wEnd; i++) {
    // 1 — queued order fills at this bar's open
    if (pending !== null) {
      const want = pending
      pending = null
      if (want !== pos) {
        if (pos !== 0) closePosition(i, ds.open[i], EXIT_REASON.SIGNAL)
        eq = cash
        if (want !== 0) openPosition(i, want, ds.open[i])
      }
    }

    // 2 — intrabar risk exits. Stop is checked before target: when a single bar
    // spans both, assuming the worse fill is the only defensible choice.
    if (pos !== 0) {
      const excursion = pos > 0
        ? { fav: ds.high[i] / entryPrice - 1, adv: ds.low[i] / entryPrice - 1 }
        : { fav: entryPrice / ds.low[i] - 1, adv: entryPrice / ds.high[i] - 1 }
      mfe = Math.max(mfe, excursion.fav)
      mae = Math.min(mae, excursion.adv)

      const stopHit = stopPrice > 0 && (pos > 0 ? ds.low[i] <= stopPrice : ds.high[i] >= stopPrice)
      const targetHit = targetPrice > 0 && (pos > 0 ? ds.high[i] >= targetPrice : ds.low[i] <= targetPrice)
      if (stopHit) {
        closePosition(i, stopPrice, EXIT_REASON.STOP)
        eq = cash
      } else if (targetHit) {
        closePosition(i, targetPrice, EXIT_REASON.TARGET)
        eq = cash
      }
    }

    // 3 — time and session exits, filled at this bar's close
    if (pos !== 0 && r.maxBars > 0 && i - entryIdx >= r.maxBars) {
      closePosition(i, ds.close[i], EXIT_REASON.TIME)
      eq = cash
    }
    if (pos !== 0 && sessionEnd && sessionEnd[i]) {
      closePosition(i, ds.close[i], EXIT_REASON.SESSION)
      eq = cash
      prevTarget = 0
    }
    if (pos !== 0 && i === wEnd) {
      closePosition(i, ds.close[i], EXIT_REASON.END)
      eq = cash
    }

    // 4 — mark to market
    eq = cash + pos * qty * ds.close[i]
    equity[i] = eq
    returns[i] = i > wStart && equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0
    posSeries[i] = pos
    if (pos !== 0) barsInMarket++

    // 5 — strategy speaks, order lands next bar
    if (i >= warmup && i < wEnd) {
      let target = strategy.signal(i, state, ds, params, prevTarget)
      if (!Number.isFinite(target)) target = prevTarget
      target = Math.max(-1, Math.min(1, Math.round(target)))
      if (target < 0 && !r.allowShort) target = 0
      if (sessionEnd && sessionEnd[i]) target = 0
      prevTarget = target
      if (target !== pos) pending = target
    }
  }

  const metrics = computeMetrics({
    equity: equity.subarray(wStart, wEnd + 1),
    returns: returns.subarray(wStart, wEnd + 1),
    trades,
    barsInMarket,
    interval: ds.interval,
    initialCapital: c.initialCapital,
  })

  const t1 = (typeof performance !== 'undefined' ? performance : Date).now()

  return {
    equity,
    returns,
    positions: posSeries,
    trades,
    metrics,
    buyHold: buyHoldCurve(ds, c.initialCapital, wStart),
    windowStart: wStart,
    windowEnd: wEnd,
    elapsedMs: t1 - t0,
    config: {
      strategyId: strategy.id,
      params: { ...params },
      costs: c,
      risk: r,
      datasetId: ds.id,
      symbol: ds.symbol,
      interval: ds.interval,
      bars: n,
    },
  }
}

/**
 * Trimmed result for panels that only need summary numbers — sweep cells,
 * walk-forward folds, and the compare slots. Dropping the per-bar arrays keeps
 * a 500-cell sweep from pinning ~100 MB of Float64Arrays in the store.
 */
export function summarize(result) {
  const m = result.metrics
  return {
    sharpe: m.sharpe,
    sortino: m.sortino,
    totalReturn: m.totalReturn,
    maxDd: m.maxDd,
    hitRate: m.hitRate,
    profitFactor: m.profitFactor,
    nTrades: m.nTrades,
    exposure: m.exposure,
    finalEquity: m.finalEquity,
  }
}

export { EXIT_REASON }
