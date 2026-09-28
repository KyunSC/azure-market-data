/**
 * Prop-firm economics for one engine run.
 *
 * Two samples of "what happens when I buy this account":
 *   historical — one purchase per session start. Honest, but consecutive
 *                starts share almost all their days, and late starts run out
 *                of data (censored).
 *   bootstrap  — whole days resampled in blocks, which keeps the week-scale
 *                clustering of good and bad days that decides a trailing
 *                drawdown, and runs each purchase to a horizon long enough that
 *                censoring is rare.
 *
 * The number that answers "is this strategy worth running at a prop firm" is
 * EV per purchase: the expected 90%-split payouts minus the fee. It can be
 * positive where the cash account loses money — the fee caps the downside
 * while payouts keep the upside — and the aligned cash P&L sits beside it so
 * that difference is visible.
 */

import { mulberry32, percentile } from '../metrics'
import { buildDayTable, simulateAccount } from './account'

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : Number.NaN)

export function summarizeAttempts(attempts, plan) {
  const cost = plan.price + (plan.activationFee || 0)
  const resolved = attempts.filter((a) => a.outcome !== 'eval-open')
  const passed = resolved.filter((a) => a.outcome !== 'failed')
  const outcomes = {}
  for (const a of attempts) outcomes[a.outcome] = (outcomes[a.outcome] || 0) + 1
  const daysToPass = passed.map((a) => a.evalDays).sort((a, b) => a - b)
  const passRate = resolved.length ? passed.length / resolved.length : Number.NaN
  const meanTake = mean(resolved.map((a) => a.take))
  const nets = resolved.map((a) => a.take - cost).sort((a, b) => a - b)
  const withCash = resolved.filter((a) => Number.isFinite(a.cashPnl))
  return {
    attempts: attempts.length,
    resolved: resolved.length,
    censored: attempts.length - resolved.length,
    fundedOpen: outcomes['funded-open'] || 0,
    outcomes,
    passRate,
    medianDaysToPass: daysToPass.length ? percentile(daysToPass, 0.5) : Number.NaN,
    pPayout: resolved.length ? resolved.filter((a) => a.payouts.length > 0).length / resolved.length : Number.NaN,
    meanPayouts: mean(resolved.map((a) => a.payouts.length)),
    meanTake,
    cost,
    ev: meanTake - cost,
    evP05: nets.length ? percentile(nets, 0.05) : Number.NaN,
    evP50: nets.length ? percentile(nets, 0.5) : Number.NaN,
    evP95: nets.length ? percentile(nets, 0.95) : Number.NaN,
    costPerFunded: passRate > 0 ? cost / passRate : Number.POSITIVE_INFINITY,
    meanDaysUsed: mean(resolved.map((a) => a.daysUsed)),
    meanCashPnl: withCash.length ? mean(withCash.map((a) => a.cashPnl)) : Number.NaN,
    dllHitRate: mean(resolved.map((a) => a.dllHits / Math.max(1, a.daysUsed))),
    nets,
  }
}

/**
 * `result` is an engine result run with `costs.instrument` (so it carries the
 * bar extremes); `time` is the dataset's bar times.
 */
export function runProp({ result, time, plan, initialCapital, bootstrap = true, paths = 1000, blockSize = 5, horizon = 250, seed = 42, keepAttempts = true }) {
  if (!result.barLo) throw new Error('Prop replay needs a futures run (costs.instrument)')
  const days = buildDayTable({
    equity: result.equity,
    barLo: result.barLo,
    barHi: result.barHi,
    barOpen: result.barOpen,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    time,
    initialCapital,
  })

  // Cumulative cash-account P&L by day, for the aligned comparison.
  const cum = new Float64Array(days.n + 1)
  for (let d = 0; d < days.n; d++) cum[d + 1] = cum[d] + days.close[days.end[d]]

  const historical = []
  for (let s = 0; s < days.n; s++) {
    const a = simulateAccount({ days, plan, next: (k) => (s + k < days.n ? s + k : -1) })
    a.startDay = s
    a.startTime = days.time[s]
    a.cashPnl = cum[Math.min(days.n, s + Math.max(1, a.daysUsed))] - cum[s]
    historical.push(a)
  }

  let boot = null
  if (bootstrap && days.n >= 2) {
    const rng = mulberry32(seed)
    const bl = Math.max(1, Math.min(blockSize, days.n))
    const attempts = []
    for (let p = 0; p < paths; p++) {
      const seq = []
      const next = (k) => {
        while (seq.length <= k) {
          if (seq.length >= horizon) return -1
          const b = Math.floor(rng() * Math.max(1, days.n - bl + 1))
          for (let j = 0; j < bl && seq.length < horizon; j++) seq.push((b + j) % days.n)
        }
        return seq[k]
      }
      attempts.push(simulateAccount({ days, plan, next }))
    }
    boot = summarizeAttempts(attempts, plan)
    boot.paths = paths
    boot.blockSize = bl
    boot.horizon = horizon
  }

  const dayPnl = Array.from({ length: days.n }, (_, d) => days.close[days.end[d]])
  return {
    plan,
    days: days.n,
    activeDays: days.active.reduce((a, b) => a + b, 0),
    meanDayPnl: mean(dayPnl),
    cashPnl: cum[days.n],
    historical: {
      ...summarizeAttempts(historical, plan),
      list: keepAttempts ? historical.map(({ startDay, startTime, outcome, reason, evalDays, fundedDays, payouts, take, cashPnl, dllHits }) =>
        ({ startDay, startTime, outcome, reason, evalDays, fundedDays, payouts, take, cashPnl, dllHits })) : undefined,
    },
    bootstrap: boot,
  }
}
