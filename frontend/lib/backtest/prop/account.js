/**
 * Prop-account replay.
 *
 * With a fixed contract count a strategy's orders never depend on the account
 * balance, so the engine runs once and every firm rule becomes a read of its
 * per-bar equity extremes (`barLo` / `barHi` / `barOpen`):
 *   - max-loss breach   an intrabar low at or below the trailing threshold ends
 *                       the account
 *   - daily loss limit  flattens for the rest of the day, so the day's P&L
 *                       freezes at the limit (or at the open, if gapped through)
 *   - flat-by time      already applied by the engine (`risk.flatByEt`)
 *
 * Days are replayed relative to their opening balance, so the same day table
 * serves a start on any historical session and any bootstrapped sequence.
 */

import { tradingDay } from '../series'
import { nth } from './firms'

const EPS = 1e-9

/**
 * Engine result → day table. Every per-bar value is relative to the equity the
 * day opened with; prop mode forces flat-at-close, so that is realised cash.
 */
export function buildDayTable({ equity, barLo, barHi, barOpen, windowStart = 0, windowEnd, time, initialCapital }) {
  const end = windowEnd ?? equity.length - 1
  const n = end - windowStart + 1
  const lo = new Float64Array(n)
  const hi = new Float64Array(n)
  const open = new Float64Array(n)
  const close = new Float64Array(n)
  const starts = []
  const ends = []
  const active = []
  const dayTime = []
  let base = initialCapital
  let dayActive = 0

  for (let i = windowStart; i <= end; i++) {
    const j = i - windowStart
    if (i === windowStart || tradingDay(time[i]) !== tradingDay(time[i - 1])) {
      if (i !== windowStart) {
        ends.push(j - 1)
        active.push(dayActive)
        base = equity[i - 1]
      }
      starts.push(j)
      dayTime.push(time[i])
      dayActive = 0
    }
    lo[j] = barLo[i] - base
    hi[j] = barHi[i] - base
    open[j] = barOpen[i] - base
    close[j] = equity[i] - base
    if (Math.abs(hi[j] - lo[j]) > EPS || Math.abs(close[j]) > EPS || Math.abs(open[j]) > EPS) dayActive = 1
  }
  ends.push(n - 1)
  active.push(dayActive)

  return {
    n: starts.length,
    start: Int32Array.from(starts),
    end: Int32Array.from(ends),
    active: Uint8Array.from(active),
    time: Float64Array.from(dayTime),
    lo,
    hi,
    open,
    close,
  }
}

/** One stage — an evaluation or a funded account — from day `k0` of the attempt. */
function runStage(days, next, k0, plan, stage) {
  const start = plan.startBalance
  const lockAt = start + plan.lockOffset
  const intraday = stage === 'funded' && plan.fundedDrawdown === 'intraday'
  const dll = plan.dailyLossLimit > 0 ? plan.dailyLossLimit : 0
  let bal = start
  let peak = start
  let locked = false
  let threshold = Math.min(peak - plan.maxLoss, lockAt)
  let activeDays = 0
  let bestDay = 0
  let dllHits = 0
  let cycleStart = start
  let cycleActive = 0
  let cycleProfitDays = 0
  let cycleBest = 0
  const payouts = []
  const done = (status, reason, k) => ({ status, reason, days: k - k0, payouts, dllHits, balance: bal })

  for (let k = k0; ; k++) {
    const d = next(k)
    if (d < 0) return done('open', 'end-of-data', k)
    const s = days.start[d]
    const e = days.end[d]
    const dayBase = bal
    const dllLevel = dll ? dayBase - dll : -Infinity
    let pnl = null

    for (let i = s; i <= e; i++) {
      // Intraday trailing: credit the bar's high before its low. The order
      // inside a bar is unknown, and this is the order that breaches soonest.
      if (intraday && !locked) {
        peak = Math.max(peak, dayBase + days.hi[i])
        threshold = Math.min(peak - plan.maxLoss, lockAt)
      }
      const worst = dayBase + days.lo[i]
      if (dll && worst <= dllLevel && dllLevel > threshold) {
        const frozen = Math.min(dllLevel, dayBase + days.open[i])
        dllHits++
        if (frozen <= threshold) {
          bal = frozen
          return done('breached', 'max-loss', k + 1)
        }
        pnl = frozen - dayBase
        break
      }
      if (worst <= threshold) {
        bal = Math.min(threshold, dayBase + days.open[i])
        return done('breached', 'max-loss', k + 1)
      }
    }
    if (pnl === null) pnl = days.close[e]
    bal = dayBase + pnl
    const act = days.active[d] === 1
    if (act) activeDays++
    if (!locked) {
      peak = Math.max(peak, bal)
      threshold = Math.min(peak - plan.maxLoss, lockAt)
    }

    if (stage === 'eval') {
      bestDay = Math.max(bestDay, pnl)
      const profit = bal - start
      if (
        activeDays >= plan.evalMinDays &&
        profit >= plan.profitTarget &&
        (!plan.evalConsistency || bestDay <= plan.evalConsistency * profit + EPS)
      ) {
        return done('passed', 'target', k + 1)
      }
      continue
    }

    if (act) cycleActive++
    if (act && pnl > 0 && pnl >= plan.minDayProfit) cycleProfitDays++
    cycleBest = Math.max(cycleBest, pnl)
    const cycleProfit = bal - cycleStart
    const idx = payouts.length
    const goal = nth(plan.profitGoal, idx) || 0
    const eligible =
      cycleActive >= plan.fundedMinDays &&
      cycleProfitDays >= plan.minProfitDays &&
      cycleProfit > 0 &&
      cycleProfit >= goal &&
      (!plan.fundedConsistency || cycleBest <= plan.fundedConsistency * cycleProfit + EPS) &&
      (!plan.buffer || bal > plan.buffer)
    if (!eligible) continue

    let amount = plan.payoutFraction != null
      ? plan.payoutFraction * (bal - start)
      : bal - Math.max(plan.buffer || 0, start)
    const cap = nth(plan.payoutCap, idx)
    if (cap > 0) amount = Math.min(amount, cap)
    amount = Math.floor(amount)
    if (amount < plan.minPayout) continue

    payouts.push(amount)
    bal -= amount
    locked = true
    threshold = lockAt
    cycleStart = bal
    cycleActive = 0
    cycleProfitDays = 0
    cycleBest = 0
    if (payouts.length >= plan.maxPayouts) return done('graduated', 'max-payouts', k + 1)
  }
}

/**
 * One purchase: evaluation (if the plan has one) then the funded account.
 * `next(k)` gives the day-table index of the attempt's k-th day, or -1 when
 * the data runs out.
 *
 * Outcomes: `failed` (eval breached), `eval-open` (data ended mid-eval —
 * censored), `funded-breached`, `graduated` (hit the payout count that moves
 * the trader to a live account, which is not simulated), `funded-open`
 * (data ended while funded; payouts so far are a lower bound).
 */
export function simulateAccount({ days, next, plan }) {
  const out = { outcome: null, reason: null, evalDays: 0, fundedDays: 0, payouts: [], take: 0, daysUsed: 0, dllHits: 0 }
  let k = 0
  if (plan.hasEval) {
    const ev = runStage(days, next, 0, plan, 'eval')
    out.evalDays = ev.days
    out.dllHits += ev.dllHits
    k = ev.days
    if (ev.status !== 'passed') {
      out.outcome = ev.status === 'breached' ? 'failed' : 'eval-open'
      out.reason = ev.reason
      out.daysUsed = k
      return out
    }
  }
  const fu = runStage(days, next, k, plan, 'funded')
  out.fundedDays = fu.days
  out.dllHits += fu.dllHits
  out.payouts = fu.payouts
  out.outcome = fu.status === 'breached' ? 'funded-breached' : fu.status === 'graduated' ? 'graduated' : 'funded-open'
  out.reason = fu.reason
  out.take = plan.split * fu.payouts.reduce((a, b) => a + b, 0)
  out.daysUsed = k + fu.days
  return out
}
