/**
 * Volume profile approximated from OHLCV bars (no tick data). Used by the
 * chart's profile overlay and by the S/R zone scorer.
 */

const TICK_SIZE = 0.25 // ES/NQ futures tick size

// Wilder-smoothed ATR, first bar falls back to H-L.
function wilderAtr(bars, period = 14) {
  const n = bars.length
  const atr = new Array(n)
  if (n === 0) return atr
  const alpha = 1 / period
  let prevTr = bars[0].high - bars[0].low
  atr[0] = prevTr
  for (let i = 1; i < n; i++) {
    const prevClose = bars[i - 1].close
    const tr = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - prevClose),
      Math.abs(bars[i].low - prevClose),
    )
    atr[i] = alpha * tr + (1 - alpha) * atr[i - 1]
  }
  return atr
}

// Convolve with a normalized Gaussian kernel (±3σ), edge-padded so mass at the
// extremes isn't attenuated.
function gaussianSmooth1D(values, sigma) {
  if (sigma <= 0 || values.length === 0) return values.slice()
  const half = Math.max(1, Math.ceil(3 * sigma))
  const kernel = new Array(2 * half + 1)
  let sum = 0
  for (let i = -half; i <= half; i++) {
    const w = Math.exp(-0.5 * (i / sigma) ** 2)
    kernel[i + half] = w
    sum += w
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const n = values.length
  const out = new Array(n).fill(0)
  for (let i = 0; i < n; i++) {
    let acc = 0
    for (let k = -half; k <= half; k++) {
      let j = i + k
      if (j < 0) j = 0
      else if (j >= n) j = n - 1
      acc += values[j] * kernel[k + half]
    }
    out[i] = acc
  }
  return out
}

// OHLC-weighted volume distribution. With only bar data (no ticks), we spread
// each bar's volume across its price range using a dynamic body-vs-wick weight,
// with a uniform fallback for sprint bars that almost certainly never traded
// evenly across the range. Returns the render-bucket contract the overlay
// expects: { buckets: [{priceBottom, priceTop, volume}], maxVol }.
export function computeVolumeProfile(intradayData, ticksPerRow = 4) {
  if (!intradayData || intradayData.length === 0) return null

  const tickSize = TICK_SIZE
  const bucketSize = ticksPerRow * tickSize
  const bodyWeightBase = 0.7
  const extremeThreshold = 3.0
  const atrPeriod = 14
  const smoothingSigmaTicks = 1.5

  const bars = intradayData.filter(d =>
    Number.isFinite(d.open) && Number.isFinite(d.high) &&
    Number.isFinite(d.low) && Number.isFinite(d.close) &&
    Number.isFinite(d.volume) && d.volume > 0
  )
  if (bars.length === 0) return null

  const atr = wilderAtr(bars, atrPeriod)
  const snapIdx = (price) => Math.round(price / tickSize)

  // Per-tick accumulator keyed by absolute tick index.
  const tickProfile = new Map()
  const addTick = (idx, v) => {
    if (v <= 0) return
    tickProfile.set(idx, (tickProfile.get(idx) || 0) + v)
  }
  const addUniformIdx = (loIdx, hiIdx, v) => {
    if (v <= 0 || hiIdx < loIdx) return
    const share = v / (hiIdx - loIdx + 1)
    for (let k = loIdx; k <= hiIdx; k++) addTick(k, share)
  }

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    const oIdx = snapIdx(bar.open)
    const hIdx = snapIdx(bar.high)
    const lIdx = snapIdx(bar.low)
    const cIdx = snapIdx(bar.close)
    const volume = bar.volume
    const rangeTicks = hIdx - lIdx

    // Single-tick / collapsed bar.
    if (rangeTicks <= 0) {
      addTick(hIdx, volume)
      continue
    }

    // Extreme move: range >> typical → assume volume sprinted uniformly.
    if (atr[i] > 0 && rangeTicks * tickSize > extremeThreshold * atr[i]) {
      addUniformIdx(lIdx, hIdx, volume)
      continue
    }

    const bodyLoIdx = Math.min(oIdx, cIdx)
    const bodyHiIdx = Math.max(oIdx, cIdx)
    const bodyTicks = bodyHiIdx - bodyLoIdx

    // wick_ratio ∈ [0,1]: fraction of bar range that's wick (0=marubozu).
    // At typical wick_ratio=0.5, bodyWeight = base. Tight bar → up to 0.8;
    // volatile bar → down to 0.5.
    const wickRatio = (rangeTicks - bodyTicks) / rangeTicks
    const bodyWeight = Math.max(
      0.5,
      Math.min(0.8, bodyWeightBase + (0.5 - wickRatio) * 0.3),
    )
    const bodyVol = volume * bodyWeight
    const wickVol = volume * (1 - bodyWeight)

    // Body: uniform across [bodyLo, bodyHi], or collapsed (doji) to one tick.
    if (bodyTicks === 0) addTick(bodyLoIdx, bodyVol)
    else addUniformIdx(bodyLoIdx, bodyHiIdx, bodyVol)

    // Wicks: split proportionally to wick length, excluding the body range
    // (already covered). Marubozu (no wicks) folds the wick share back into
    // the body so total volume is conserved.
    const upperTicks = hIdx - bodyHiIdx
    const lowerTicks = bodyLoIdx - lIdx
    const totalWickTicks = upperTicks + lowerTicks

    if (totalWickTicks === 0) {
      if (bodyTicks === 0) addTick(bodyLoIdx, wickVol)
      else addUniformIdx(bodyLoIdx, bodyHiIdx, wickVol)
      continue
    }
    if (upperTicks > 0) {
      addUniformIdx(bodyHiIdx + 1, hIdx, wickVol * (upperTicks / totalWickTicks))
    }
    if (lowerTicks > 0) {
      addUniformIdx(lIdx, bodyLoIdx - 1, wickVol * (lowerTicks / totalWickTicks))
    }
  }

  if (tickProfile.size === 0) return null

  // Aggregate per-tick volumes into render-bucket grid.
  let minTickIdx = Infinity, maxTickIdx = -Infinity
  for (const k of tickProfile.keys()) {
    if (k < minTickIdx) minTickIdx = k
    if (k > maxTickIdx) maxTickIdx = k
  }
  const bucketOf = (tickIdx) => Math.floor(tickIdx / ticksPerRow)
  const minBucketIdx = bucketOf(minTickIdx)
  const maxBucketIdx = bucketOf(maxTickIdx)
  const numBuckets = maxBucketIdx - minBucketIdx + 1

  const rawVolumes = new Array(numBuckets).fill(0)
  for (const [tickIdx, v] of tickProfile) {
    rawVolumes[bucketOf(tickIdx) - minBucketIdx] += v
  }

  // Smoothing sigma is specified in ticks; rescale to bucket units.
  const smoothed = gaussianSmooth1D(rawVolumes, smoothingSigmaTicks / ticksPerRow)

  const buckets = new Array(numBuckets)
  let maxVol = 0
  for (let i = 0; i < numBuckets; i++) {
    const priceBottom = (minBucketIdx + i) * bucketSize
    const volume = smoothed[i]
    if (volume > maxVol) maxVol = volume
    buckets[i] = {
      priceBottom,
      priceTop: priceBottom + bucketSize,
      volume,
    }
  }
  return { buckets, maxVol }
}

export function computeValueArea(buckets, pct = 0.7) {
  const totalVol = buckets.reduce((s, b) => s + b.volume, 0)
  if (totalVol === 0) return null
  const target = totalVol * pct
  const pocIdx = buckets.reduce((mi, b, i, arr) => b.volume > arr[mi].volume ? i : mi, 0)
  let accumulated = buckets[pocIdx].volume
  let lo = pocIdx, hi = pocIdx
  while (accumulated < target && (lo > 0 || hi < buckets.length - 1)) {
    const loVol = lo > 0 ? buckets[lo - 1].volume : -1
    const hiVol = hi < buckets.length - 1 ? buckets[hi + 1].volume : -1
    if (loVol >= hiVol && lo > 0) { lo--; accumulated += buckets[lo].volume }
    else if (hi < buckets.length - 1) { hi++; accumulated += buckets[hi].volume }
    else break
  }
  return { lo, hi }
}

/** POC and value-area edges as prices, for the S/R zone scorer. */
export function profileNodes(vp, pct = 0.7) {
  if (!vp?.buckets?.length) return null
  const { buckets } = vp
  const pocIdx = buckets.reduce((mi, b, i, arr) => b.volume > arr[mi].volume ? i : mi, 0)
  const va = computeValueArea(buckets, pct)
  const mid = (b) => (b.priceBottom + b.priceTop) / 2
  return {
    poc: mid(buckets[pocIdx]),
    vah: va ? buckets[va.hi].priceTop : NaN,
    val: va ? buckets[va.lo].priceBottom : NaN,
  }
}
