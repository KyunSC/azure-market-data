/**
 * Inference on a backtest's Sharpe ratio.
 *
 * A point Sharpe says nothing about whether the edge is real. Three layers here:
 *
 *   1. Standard error (Mertens 2002): per-bar SR with skew and fat tails
 *      folded in. Intraday strategy returns are mostly zeros with a few large
 *      bars, so the i.i.d.-normal SE would be far too narrow.
 *   2. Probabilistic Sharpe (PSR): P(true SR > 0) under that SE.
 *   3. Deflated Sharpe (Bailey & López de Prado 2014): PSR measured against the
 *      Sharpe you would expect from the best of N zero-edge trials, where N and
 *      the spread of trial Sharpes come from the session's trial ledger.
 *
 * Bar returns are treated as independent; serial correlation would widen the
 * intervals further, so these are optimistic bounds, not pessimistic ones.
 */

const EULER_GAMMA = 0.5772156649015329

/** Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf). */
export function normCdf(x) {
  if (x === Infinity) return 1
  if (x === -Infinity) return 0
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2)
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2)
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

/** Inverse standard normal CDF (Acklam's rational approximation). */
export function normInv(p) {
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239]
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572]
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > 1 - lo) return -normInv(1 - p)
  const q = p - 0.5
  const r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Moments of a return series: mean, sd, skew and raw (non-excess) kurtosis. */
export function moments(returns) {
  const n = returns.length
  if (n < 2) return { n, mean: 0, sd: 0, skew: 0, kurt: 3 }
  let m = 0
  for (let i = 0; i < n; i++) m += returns[i]
  m /= n
  let m2 = 0
  let m3 = 0
  let m4 = 0
  for (let i = 0; i < n; i++) {
    const d = returns[i] - m
    const d2 = d * d
    m2 += d2
    m3 += d2 * d
    m4 += d2 * d2
  }
  m2 /= n
  m3 /= n
  m4 /= n
  const sd = Math.sqrt(m2)
  return {
    n,
    mean: m,
    sd: Math.sqrt((m2 * n) / (n - 1)),
    skew: sd > 0 ? m3 / sd ** 3 : 0,
    kurt: sd > 0 ? m4 / m2 ** 2 : 3,
  }
}

/** Per-bar Sharpe standard error, Mertens (2002). */
function sharpeSe(sr, n, skew, kurt) {
  if (n < 2) return Number.NaN
  const v = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr
  return Math.sqrt(Math.max(v, 0) / (n - 1))
}

/**
 * Sharpe with its uncertainty. `sr` is per-bar; `sharpe`/`ci` are annualised
 * the same way `metrics.sharpe` is, so they sit side by side in the UI.
 */
export function sharpeInference(returns, ppy, z = 1.959963984540054) {
  const { n, mean, sd, skew, kurt } = moments(returns)
  const sr = sd > 0 ? mean / sd : 0
  const se = sharpeSe(sr, n, skew, kurt)
  const ann = Math.sqrt(ppy)
  return {
    n,
    sr,
    se,
    skew,
    kurt,
    sharpe: sr * ann,
    ci: Number.isFinite(se) ? [(sr - z * se) * ann, (sr + z * se) * ann] : [Number.NaN, Number.NaN],
    psr: Number.isFinite(se) && se > 0 ? normCdf(sr / se) : Number.NaN,
  }
}

/**
 * Expected maximum per-bar Sharpe across `trials` independent zero-edge
 * strategies whose Sharpes have variance `trialVar`.
 */
export function expectedMaxSharpe(trials, trialVar) {
  if (!(trials > 1) || !(trialVar > 0)) return 0
  const e = (1 - EULER_GAMMA) * normInv(1 - 1 / trials) + EULER_GAMMA * normInv(1 - 1 / (trials * Math.E))
  return Math.sqrt(trialVar) * e
}

/**
 * Deflated Sharpe ratio. `inference` comes from `sharpeInference`;
 * `trialSrs` are per-bar Sharpes of every distinct configuration tried on the
 * same data (this one included). Returns P(true SR > best-of-N noise).
 */
export function deflatedSharpe(inference, trialSrs) {
  const trials = trialSrs.length
  let trialVar = 0
  if (trials > 1) {
    const m = trialSrs.reduce((a, b) => a + b, 0) / trials
    trialVar = trialSrs.reduce((a, b) => a + (b - m) ** 2, 0) / (trials - 1)
  }
  const sr0 = expectedMaxSharpe(trials, trialVar)
  const { sr, n, skew, kurt } = inference
  const se = sharpeSe(sr, n, skew, kurt)
  return {
    trials,
    sr0,
    dsr: Number.isFinite(se) && se > 0 ? normCdf((sr - sr0) / se) : Number.NaN,
  }
}

/**
 * Where the locked holdout starts. The split snaps forward to the next session
 * boundary so no trading day is split between research and holdout.
 */
export function holdoutSplit(time, pct) {
  const n = time?.length ?? 0
  if (!(pct > 0) || n < 4) return { cut: n, researchEnd: n - 1, holdoutBars: 0 }
  const target = Math.min(n - 1, Math.max(1, Math.floor(n * (1 - pct / 100))))
  let cut = target
  const day = (t) => Math.floor(t / 86400)
  while (cut < n && day(time[cut]) === day(time[cut - 1])) cut++
  if (cut >= n - 1) cut = target
  return { cut, researchEnd: cut - 1, holdoutBars: n - cut }
}

/** Stable short key for a configuration, used to de-duplicate trials. */
export function configKey(obj) {
  const s = JSON.stringify(obj)
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619)
    h2 = Math.imul(h2 ^ c, 2246822519)
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)
}
