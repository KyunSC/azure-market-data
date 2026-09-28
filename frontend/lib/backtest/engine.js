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

import { computeMetrics, buyHoldCurve, datasetPeriodsPerYear } from './metrics'
import { sessionEndFlags, flatByFlags } from './series'

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
  flatByEt: 0,     // minutes after midnight ET to be flat by; 0 = disabled
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
 * `costs.instrument` switches sizing from "fraction of equity" to a fixed
 * number of futures contracts: `{ pointValue, tickSize, contracts,
 * commissionPerSide, slippageTicks, priceScale }`. `priceScale` turns ETF bars
 * into futures points (QQQ → NQ) on the research plane; it is 1 on real
 * futures bars. Slippage is then in ticks and commission is per contract per
 * side. Percent stops and targets are scale-free, so they need no change.
 *
 * With an instrument the result also carries `barLo` / `barHi` / `barOpen`:
 * equity at the adverse and favourable extremes of each bar and just after its
 * open. Prop-firm rules (see `prop/account.js`) replay those instead of
 * re-running the simulation — with a fixed contract count the orders never
 * depend on the account balance, so every rule reduces to reading them.
 *
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

  const inst = c.instrument && c.instrument.contracts > 0 && c.instrument.pointValue > 0 ? c.instrument : null
  const slip = c.slippageBps / 10000
  const slipPts = inst ? (inst.slippageTicks || 0) * (inst.tickSize || 0) : 0
  const commission = inst ? (inst.commissionPerSide || 0) * inst.contracts : c.commissionPerTrade
  const scale = inst?.priceScale > 0 ? inst.priceScale : 1
  const scaled = (arr) => (scale === 1 ? arr : Float64Array.from(arr, (v) => v * scale))
  const O = scaled(ds.open)
  const H = scaled(ds.high)
  const L = scaled(ds.low)
  const C = scaled(ds.close)
  const state = strategy.prepare ? strategy.prepare(ds, params) : null
  const warmup = Math.max(wStart, strategy.warmup ? strategy.warmup(params, ds) : 0)
  const sessionBreak = sessionEndFlags(ds.time)
  const sessionEnd = r.flatAtSessionEnd ? sessionBreak : null
  const flatBy = r.flatByEt > 0 ? flatByFlags(ds.time, r.flatByEt) : null

  const equity = new Float64Array(n).fill(c.initialCapital)
  const returns = new Float64Array(n)
  const posSeries = new Int8Array(n)
  const trades = []
  const barLo = inst ? new Float64Array(n).fill(c.initialCapital) : null
  const barHi = inst ? new Float64Array(n).fill(c.initialCapital) : null
  const barOpen = inst ? new Float64Array(n).fill(c.initialCapital) : null

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
  // Direction closed by a stop, target or time exit. Re-entry that way waits
  // until the strategy stops asking for it or the session ends — otherwise a
  // regime strategy whose condition is still true buys straight back in on the
  // next open and the "stop" becomes one-bar churn.
  let lockout = 0

  const buyFill = inst ? (px) => px + slipPts : (px) => px * (1 + slip)
  const sellFill = inst ? (px) => Math.max(0, px - slipPts) : (px) => px * (1 - slip)

  const closePosition = (i, rawPrice, reason) => {
    const fill = pos > 0 ? sellFill(rawPrice) : buyFill(rawPrice)
    const gross = pos > 0 ? (fill - entryPrice) * qty : (entryPrice - fill) * qty
    cash += pos > 0 ? fill * qty : -fill * qty
    cash -= commission
    // Both legs are commissioned, and slippage is already inside the fills, so
    // `pnl` and `pnlPct` are what actually landed in the account. The Monte
    // Carlo resamples `pnlPct`, which would flatter the fan if it were gross.
    const fees = entryFee + commission
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
    qty = inst ? inst.contracts * inst.pointValue : Math.max(0, eq * c.sizePct) / fill
    if (!(qty > 0)) {
      qty = 0
      return
    }
    cash -= dir > 0 ? fill * qty : -fill * qty
    cash -= commission
    entryFee = commission
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
        if (pos !== 0) closePosition(i, O[i], EXIT_REASON.SIGNAL)
        eq = cash
        if (want !== 0) openPosition(i, want, O[i])
      }
    }
    let lo = 0
    let hi = 0
    if (inst) {
      lo = hi = barOpen[i] = cash + pos * qty * O[i]
    }

    // 2 — intrabar risk exits. A bar that opens beyond a level fills at the
    // open: a stop cannot be filled at a price the market gapped through. Inside
    // the bar, stop is checked before target — when one bar spans both, the
    // worse fill is the only defensible assumption.
    if (pos !== 0) {
      const excursion = pos > 0
        ? { fav: H[i] / entryPrice - 1, adv: L[i] / entryPrice - 1 }
        : { fav: entryPrice / L[i] - 1, adv: entryPrice / H[i] - 1 }
      mfe = Math.max(mfe, excursion.fav)
      mae = Math.min(mae, excursion.adv)

      const stopHit = stopPrice > 0 && (pos > 0 ? L[i] <= stopPrice : H[i] >= stopPrice)
      const targetHit = targetPrice > 0 && (pos > 0 ? H[i] >= targetPrice : L[i] <= targetPrice)
      const o = O[i]
      const gapStop = stopHit && (pos > 0 ? o <= stopPrice : o >= stopPrice)
      const gapTarget = targetHit && (pos > 0 ? o >= targetPrice : o <= targetPrice)
      const dir = pos
      // Bar extremes for the prop replay. A stop caps the adverse side at its
      // fill; when stop and target share a bar the stop is assumed first, so
      // the favourable side is never credited.
      const advEq = cash + pos * qty * (pos > 0 ? L[i] : H[i])
      const favEq = cash + pos * qty * (pos > 0 ? H[i] : L[i])
      if (gapStop) {
        closePosition(i, o, EXIT_REASON.STOP)
      } else if (gapTarget) {
        closePosition(i, o, EXIT_REASON.TARGET)
      } else if (stopHit) {
        closePosition(i, stopPrice, EXIT_REASON.STOP)
      } else if (targetHit) {
        closePosition(i, targetPrice, EXIT_REASON.TARGET)
      }
      if (inst) {
        lo = Math.min(lo, stopHit ? cash : advEq)
        if (!stopHit) hi = Math.max(hi, targetHit ? cash : favEq)
      }
      if (pos === 0) {
        eq = cash
        lockout = dir
        prevTarget = 0
      }
    }

    // 3 — time and session exits, filled at this bar's close
    if (pos !== 0 && r.maxBars > 0 && i - entryIdx >= r.maxBars) {
      lockout = pos
      closePosition(i, C[i], EXIT_REASON.TIME)
      eq = cash
      prevTarget = 0
    }
    const flatNow = (sessionEnd && sessionEnd[i]) || (flatBy && flatBy.end[i])
    if (flatNow) {
      if (pos !== 0) {
        closePosition(i, C[i], EXIT_REASON.SESSION)
        eq = cash
      }
      prevTarget = 0
    }
    // A new session is a fresh start: yesterday's stop does not veto today,
    // whether or not positions are flattened overnight. Without this a regime
    // strategy stopped out once would sit flat until its signal flipped, which
    // can be weeks.
    if (sessionBreak[i]) lockout = 0
    if (pos !== 0 && i === wEnd) {
      closePosition(i, C[i], EXIT_REASON.END)
      eq = cash
    }

    // 4 — mark to market
    eq = cash + pos * qty * C[i]
    equity[i] = eq
    if (inst) {
      barLo[i] = Math.min(lo, eq)
      barHi[i] = Math.max(hi, eq)
    }
    returns[i] = i > wStart && equity[i - 1] > 0 ? equity[i] / equity[i - 1] - 1 : 0
    posSeries[i] = pos
    if (pos !== 0) barsInMarket++

    // 5 — strategy speaks, order lands next bar
    if (i >= warmup && i < wEnd) {
      let target = strategy.signal(i, state, ds, params, prevTarget)
      if (!Number.isFinite(target)) target = prevTarget
      target = Math.max(-1, Math.min(1, Math.round(target)))
      if (target < 0 && !r.allowShort) target = 0
      if (flatNow || (flatBy && flatBy.blocked[i])) target = 0
      prevTarget = target
      if (lockout !== 0) {
        if (target === lockout) target = 0
        else lockout = 0
      }
      if (target !== pos) pending = target
    }
  }

  const metrics = computeMetrics({
    equity: equity.subarray(wStart, wEnd + 1),
    returns: returns.subarray(wStart, wEnd + 1),
    trades,
    barsInMarket,
    interval: ds.interval,
    periodsPerYear: datasetPeriodsPerYear(ds),
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
    barLo,
    barHi,
    barOpen,
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
    sr: m.inference.sr,
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
