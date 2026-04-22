'use client'

import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, BarSeries, AreaSeries } from 'lightweight-charts'
import { DEFAULT_CHART_COLORS } from './chartDefaults'
import { AVAILABLE_INDICATORS, computeIndicator } from './indicators'

const GEX_COLORS = {
  call_wall: '#00e676',
  put_wall: '#ff1744',
  zero_gamma: '#ffff00',
  significant_pos: '#66bb6a',
  significant_neg: '#ef5350',
}

const GEX_LABELS = {
  call_wall: 'Call Wall',
  put_wall: 'Put Wall',
  zero_gamma: 'Gamma Flip',
  significant_pos: 'GEX+',
  significant_neg: 'GEX-',
}

const TICK_SIZE = 0.25 // ES/NQ futures tick size

function shiftToTimezone(utcEpoch, tz) {
  if (tz === 'UTC') return utcEpoch
  const d = new Date(utcEpoch * 1000)
  const utcStr = d.toLocaleString('en-US', { timeZone: 'UTC' })
  const tzStr = d.toLocaleString('en-US', { timeZone: tz })
  return utcEpoch + (new Date(tzStr) - new Date(utcStr)) / 1000
}

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
function computeVolumeProfile(intradayData, ticksPerRow = 4) {
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

function computeValueArea(buckets, pct = 0.7) {
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

const DRAWING_PRESET_COLORS = [
  '#4A90A4', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8',
  '#ff922b', '#20c997', '#748ffc', '#f06595', '#ffffff',
  '#888888', '#aaaaaa', '#555555',
]

function parseChartData(rawData, timezone) {
  const rawParsed = rawData
    .filter(d => d.open != null && d.high != null && d.low != null && d.close != null)
    .map(d => {
      const raw = /^\d+$/.test(d.time) ? Number(d.time) : d.time
      return {
        time: typeof raw === 'number' ? shiftToTimezone(raw, timezone) : raw,
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
      }
    })
    .filter(d => !isNaN(d.open) && !isNaN(d.high) && !isNaN(d.low) && !isNaN(d.close))

  rawParsed.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0))
  const result = []
  for (const row of rawParsed) {
    if (result.length && result[result.length - 1].time === row.time) {
      result[result.length - 1] = row
    } else {
      result.push(row)
    }
  }
  return result
}

const HANDLE_RADIUS = 5
const HANDLE_HIT_RADIUS = 10

function getDrawingHandles(d, toPixel, series, containerWidth) {
  const handles = []
  if (d.type === 'horizontal') {
    const y = series.priceToCoordinate(d.start.price)
    if (y !== null) handles.push({ id: 'start', x: 40, y })
  } else if (d.type === 'trendline' || d.type === 'ray') {
    const p1 = toPixel(d.start.time, d.start.price)
    const p2 = toPixel(d.end.time, d.end.price)
    if (p1.x !== null && p1.y !== null) handles.push({ id: 'start', x: p1.x, y: p1.y })
    if (p2.x !== null && p2.y !== null) handles.push({ id: 'end', x: p2.x, y: p2.y })
  } else if (d.type === 'rectangle') {
    const p1 = toPixel(d.start.time, d.start.price)
    const p2 = toPixel(d.end.time, d.end.price)
    if (p1.x !== null && p1.y !== null && p2.x !== null && p2.y !== null) {
      handles.push({ id: 'start', x: p1.x, y: p1.y })
      handles.push({ id: 'end', x: p2.x, y: p2.y })
      handles.push({ id: 'corner1', x: p1.x, y: p2.y })
      handles.push({ id: 'corner2', x: p2.x, y: p1.y })
    }
  } else if (d.type === 'rect-ray') {
    const p1 = toPixel(d.start.time, d.start.price)
    const y1 = series.priceToCoordinate(d.start.price)
    const y2 = series.priceToCoordinate(d.end.price)
    if (p1.x !== null && y1 !== null && y2 !== null) {
      handles.push({ id: 'start', x: p1.x, y: y1 })
      handles.push({ id: 'end', x: p1.x, y: y2 })
    }
  } else if (d.type === 'volume-profile') {
    const p1 = toPixel(d.start.time, d.start.price)
    const p2 = toPixel(d.end.time, d.end.price)
    if (p1.x !== null && p1.y !== null && p2.x !== null && p2.y !== null) {
      handles.push({ id: 'start', x: p1.x, y: p1.y })
      handles.push({ id: 'end', x: p2.x, y: p2.y })
    }
  }
  return handles
}

function hitTestHandle(handles, mx, my) {
  for (const h of handles) {
    if ((mx - h.x) ** 2 + (my - h.y) ** 2 <= HANDLE_HIT_RADIUS ** 2) return h
  }
  return null
}

function hitTestBody(d, mx, my, toPixel, series, containerWidth) {
  const T = 6
  if (d.type === 'horizontal') {
    const y = series.priceToCoordinate(d.start.price)
    return y !== null && Math.abs(my - y) < T
  }
  if (d.type === 'trendline' || d.type === 'ray') {
    const p1 = toPixel(d.start.time, d.start.price)
    const p2 = toPixel(d.end.time, d.end.price)
    if (p1.x === null || p1.y === null || p2.x === null || p2.y === null) return false
    const dx = p2.x - p1.x, dy = p2.y - p1.y
    const len2 = dx * dx + dy * dy
    let t = len2 === 0 ? 0 : ((mx - p1.x) * dx + (my - p1.y) * dy) / len2
    if (d.type === 'ray') t = Math.max(0, t)
    else t = Math.max(0, Math.min(1, t))
    const px = p1.x + t * dx, py = p1.y + t * dy
    return Math.sqrt((mx - px) ** 2 + (my - py) ** 2) < T
  }
  if (d.type === 'rectangle') {
    const p1 = toPixel(d.start.time, d.start.price)
    const p2 = toPixel(d.end.time, d.end.price)
    if (p1.x === null || p1.y === null || p2.x === null || p2.y === null) return false
    return mx >= Math.min(p1.x, p2.x) - T && mx <= Math.max(p1.x, p2.x) + T &&
           my >= Math.min(p1.y, p2.y) - T && my <= Math.max(p1.y, p2.y) + T
  }
  if (d.type === 'rect-ray') {
    const p1 = toPixel(d.start.time, d.start.price)
    const y1 = series.priceToCoordinate(d.start.price)
    const y2 = series.priceToCoordinate(d.end.price)
    if (p1.x === null || y1 === null || y2 === null) return false
    return mx >= p1.x - T && my >= Math.min(y1, y2) - T && my <= Math.max(y1, y2) + T
  }
  if (d.type === 'volume-profile') {
    const x1 = toPixel(d.start.time, d.start.price).x
    const x2 = toPixel(d.end.time, d.end.price).x
    if (x1 === null || x2 === null) return false
    // Hit test on the time-range area (full chart height)
    return mx >= Math.min(x1, x2) - T && mx <= Math.max(x1, x2) + T
  }
  return false
}

export default function CandlestickChart({
  data,
  symbol,
  upColor = DEFAULT_CHART_COLORS.upColor,
  downColor = DEFAULT_CHART_COLORS.downColor,
  bgColor = DEFAULT_CHART_COLORS.bgColor,
  borderUpColor = DEFAULT_CHART_COLORS.borderUpColor,
  borderDownColor = DEFAULT_CHART_COLORS.borderDownColor,
  activeIndicators = [],
  gexLevels = null,
  chartType = 'candlestick',
  drawingTool = null,
  drawings = [],
  onDrawingComplete = () => {},
  onDrawingUpdate = () => {},
  timezone = 'America/New_York',
  livePrice = null,
}) {
  const chartContainerRef = useRef()
  const chartRef = useRef()
  const seriesRef = useRef()
  const indicatorSeriesRef = useRef([])
  const vpCanvasRef = useRef()
  const drawCanvasRef = useRef()
  const [vpData, setVpData] = useState(null)
  const [vaEnabled, setVaEnabled] = useState(true)
  const [vaPct, setVaPct] = useState(0.7)
  const [vpTicksPerRow, setVpTicksPerRow] = useState(4)
  const [vpColors, setVpColors] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('vpColors')
        if (saved) {
          const parsed = JSON.parse(saved)
          // Only use if hex format; discard old rgba-format data
          // Migrate old format missing nonVa key
          if (parsed.bar?.startsWith('#') && parsed.poc?.startsWith('#')) {
            if (!parsed.nonVa) {
              parsed.nonVa = parsed.bar
              parsed.bar = '#4A90A4'
              localStorage.setItem('vpColors', JSON.stringify(parsed))
            }
            return parsed
          }
          localStorage.removeItem('vpColors')
        }
      } catch { localStorage.removeItem('vpColors') }
    }
    return { bar: '#4A90A4', nonVa: '#888888', poc: '#ff0000' }
  })
  const vpColorsRef = useRef(vpColors)
  vpColorsRef.current = vpColors
  const [vpSide, setVpSide] = useState(() => {
    if (typeof window !== 'undefined') {
      try { return localStorage.getItem('vpSide') || 'right' } catch { /* noop */ }
    }
    return 'right'
  })
  const vpSideRef = useRef(vpSide)
  vpSideRef.current = vpSide
  const [vpColorPopup, setVpColorPopup] = useState(null) // { x, y }
  const vpPopupRef = useRef(null)
  const vpDrawRef = useRef(null)
  const dataRef = useRef([])
  const savedRangeRef = useRef(null)

  // Load saved chart range from localStorage on first mount
  const rangeLoadedRef = useRef(false)
  if (!rangeLoadedRef.current && typeof window !== 'undefined') {
    rangeLoadedRef.current = true
    try {
      const saved = localStorage.getItem(`chartRange_${symbol}`)
      if (saved) savedRangeRef.current = JSON.parse(saved)
    } catch { /* noop */ }
  }
  const drawingStateRef = useRef({ startPoint: null })
  const [previewPoint, setPreviewPoint] = useState(null)
  const [editingDrawing, setEditingDrawing] = useState(null) // { index, x, y }
  const hoveredIdxRef = useRef(null)
  const dragRef = useRef(null) // { index, handle, startTime, startPrice, original, current }
  const renderFnRef = useRef(null)
  const isFirstDataRef = useRef(true)
  const gexPriceLinesRef = useRef([])

  // Compute volume profile from current chart data
  useEffect(() => {
    if (!activeIndicators.includes('vpro')) {
      setVpData(null)
      return
    }
    const bars = (data || [])
      .map(d => ({
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
      }))
      .filter(d => !isNaN(d.open) && !isNaN(d.volume) && d.volume > 0)
    setVpData(computeVolumeProfile(bars, vpTicksPerRow))
  }, [activeIndicators, data, vpTicksPerRow])

  // Draw volume profile on canvas overlay
  useEffect(() => {
    const canvas = vpCanvasRef.current
    const chart = chartRef.current
    const series = seriesRef.current
    if (!canvas || !chart || !series || !vpData) {
      if (canvas) {
        const ctx = canvas.getContext('2d')
        ctx.clearRect(0, 0, canvas.width, canvas.height)
      }
      return
    }

    const drawProfile = () => {
      const container = chartContainerRef.current
      if (!container) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = container.clientWidth * dpr
      canvas.height = container.clientHeight * dpr
      canvas.style.width = container.clientWidth + 'px'
      canvas.style.height = container.clientHeight + 'px'
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, container.clientWidth, container.clientHeight)

      // Find chart plotting area boundaries from the inner canvas element
      const chartPane = container.querySelector('table td canvas')
      let chartLeft = 0
      let chartRight = container.clientWidth
      let chartTop = 0
      let chartBottom = container.clientHeight
      if (chartPane) {
        const paneRect = chartPane.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()
        chartLeft = Math.max(0, paneRect.left - containerRect.left)
        chartRight = Math.min(container.clientWidth, paneRect.right - containerRect.left)
        chartTop = Math.max(0, paneRect.top - containerRect.top)
        chartBottom = Math.min(container.clientHeight, paneRect.bottom - containerRect.top)
      }

      const maxBarWidth = (chartRight - chartLeft) * 0.15
      const { buckets, maxVol } = vpData
      const pocBucket = buckets.reduce((max, b) => b.volume > max.volume ? b : max, buckets[0])
      const va = vaEnabled ? computeValueArea(buckets, vaPct) : null

      ctx.save()
      ctx.beginPath()
      ctx.rect(chartLeft, chartTop, chartRight - chartLeft, chartBottom - chartTop)
      ctx.clip()

      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i]
        if (bucket.volume === 0) continue
        const yTop = series.priceToCoordinate(bucket.priceTop)
        const yBottom = series.priceToCoordinate(bucket.priceBottom)
        if (yTop === null || yBottom === null) continue

        const barHeight = Math.abs(yBottom - yTop)
        const barWidth = (bucket.volume / maxVol) * maxBarWidth
        const x = vpSideRef.current === 'left' ? chartLeft : chartRight - barWidth

        const isPOC = bucket === pocBucket
        const inVA = va && i >= va.lo && i <= va.hi
        const hex = isPOC ? vpColorsRef.current.poc : (inVA ? vpColorsRef.current.bar : vpColorsRef.current.nonVa)
        const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16)

        if (isPOC) {
          ctx.fillStyle = `rgba(${r},${g},${b},0.5)`
          ctx.strokeStyle = `rgba(${r},${g},${b},0.8)`
          ctx.lineWidth = 1
        } else if (inVA) {
          ctx.fillStyle = `rgba(${r},${g},${b},0.5)`
          ctx.strokeStyle = `rgba(${r},${g},${b},0.7)`
          ctx.lineWidth = 0.5
        } else {
          ctx.fillStyle = `rgba(${r},${g},${b},0.2)`
          ctx.strokeStyle = `rgba(${r},${g},${b},0.4)`
          ctx.lineWidth = 0.5
        }
        ctx.fillRect(x, Math.min(yTop, yBottom), barWidth, Math.max(barHeight, 1))
        ctx.strokeRect(x, Math.min(yTop, yBottom), barWidth, Math.max(barHeight, 1))
      }

      ctx.restore()
    }

    vpDrawRef.current = drawProfile
    drawProfile()

    const sub = chart.timeScale().subscribeVisibleLogicalRangeChange(drawProfile)
    chart.subscribeCrosshairMove(drawProfile)
    const resizeObs = new ResizeObserver(drawProfile)
    resizeObs.observe(chartContainerRef.current)

    return () => {
      sub && chart.timeScale().unsubscribeVisibleLogicalRangeChange(drawProfile)
      chart.unsubscribeCrosshairMove(drawProfile)
      resizeObs.disconnect()
    }
  }, [vpData, data, activeIndicators, gexLevels, chartType, vaEnabled, vaPct, vpSide])

  useEffect(() => {
    if (!chartContainerRef.current) return

    const getInnerWidth = () => {
      const el = chartContainerRef.current
      if (!el) return 0
      const cs = window.getComputedStyle(el)
      return el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    }

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: bgColor },
        textColor: '#eee',
      },
      grid: {
        vertLines: { color: '#2a2a4e' },
        horzLines: { color: '#2a2a4e' },
      },
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: '#2a2a4e',
      },
      timeScale: {
        borderColor: '#2a2a4e',
        timeVisible: true,
      },
      width: getInnerWidth(),
      height: Math.max(450, window.innerHeight - 360),
    })

    let mainSeries
    switch (chartType) {
      // --- Bar types ---
      case 'ohlc':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: true, thinBars: false,
        })
        break
      case 'hlc':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: false, thinBars: false,
        })
        break
      case 'highlow':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: false, thinBars: true,
        })
        break

      // --- Candlestick types ---
      case 'candlestick':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        break
      case 'candlestick-trend':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        break
      case '3d-candlestick':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: '#ffffff40', borderDownColor: '#ffffff40',
          wickUpColor: upColor, wickDownColor: downColor,
        })
        break
      case 'hollow':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: bgColor, downColor: bgColor,
          borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        break
      case 'candlestick-flat':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
          wickUpColor: '#888', wickDownColor: '#888',
        })
        break

      // --- Line types ---
      case 'line':
        mainSeries = chart.addSeries(LineSeries, { color: upColor, lineWidth: 2 })
        break
      case 'line-shaded':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '60', bottomColor: upColor + '05',
          lineColor: upColor, lineWidth: 2,
        })
        break
      case 'line-gradient':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '80', bottomColor: 'transparent',
          lineColor: upColor, lineWidth: 2,
        })
        break
      case 'square-line':
        mainSeries = chart.addSeries(LineSeries, {
          color: upColor, lineWidth: 2, lineType: 1,
        })
        break
      case 'square-line-shaded':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '60', bottomColor: upColor + '05',
          lineColor: upColor, lineWidth: 2, lineType: 1,
        })
        break
      case 'square-line-gradient':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '80', bottomColor: 'transparent',
          lineColor: upColor, lineWidth: 2, lineType: 1,
        })
        break

      default:
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
    }

    chartRef.current = chart
    seriesRef.current = mainSeries
    indicatorSeriesRef.current = []
    gexPriceLinesRef.current = []
    isFirstDataRef.current = true

    // Show crosshair marker on indicator lines only when cursor is within 2px
    const markerState = new Map()
    chart.subscribeCrosshairMove((param) => {
      for (const entry of indicatorSeriesRef.current) {
        const { series: indSeries } = entry
        let shouldShow = false
        const seriesData = param.seriesData?.get(indSeries)
        if (seriesData && seriesData.value !== undefined && param.point?.y !== undefined) {
          const indY = indSeries.priceToCoordinate(seriesData.value)
          if (indY !== null) {
            shouldShow = Math.abs(param.point.y - indY) < 2
          }
        }
        if (markerState.get(indSeries) !== shouldShow) {
          markerState.set(indSeries, shouldShow)
          indSeries.applyOptions({ crosshairMarkerVisible: shouldShow })
        }
      }
    })

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({
          width: getInnerWidth(),
          height: Math.max(450, window.innerHeight - 360),
        })
      }
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      const range = chart.timeScale().getVisibleRange()
      savedRangeRef.current = range
      try {
        if (range) localStorage.setItem(`chartRange_${symbol}`, JSON.stringify(range))
        else localStorage.removeItem(`chartRange_${symbol}`)
      } catch { /* noop */ }
      chart.remove()
    }
  }, [chartType, bgColor, timezone])

  // Update data in-place without recreating the chart
  useEffect(() => {
    const chart = chartRef.current
    const mainSeries = seriesRef.current
    if (!chart || !mainSeries) return

    const parsedData = parseChartData(data, timezone)
    dataRef.current = parsedData

    const isLineType = ['line', 'square-line', 'line-shaded', 'line-gradient', 'square-line-shaded', 'square-line-gradient'].includes(chartType)
    const isTrend = chartType === 'candlestick-trend'

    if (isLineType) {
      mainSeries.setData(parsedData.map(d => ({ time: d.time, value: d.close })))
    } else if (isTrend) {
      const trendData = parsedData.map((d, i) => {
        const prev = i > 0 ? parsedData[i - 1].close : d.open
        const isUp = d.close >= prev
        return {
          ...d,
          color: isUp ? upColor : downColor,
          borderColor: isUp ? (borderUpColor || upColor) : (borderDownColor || downColor),
          wickColor: isUp ? upColor : downColor,
        }
      })
      mainSeries.setData(trendData)
    } else {
      mainSeries.setData(parsedData)
    }

    // Update indicator series data
    // Remove old indicator series and recreate with new data
    for (const entry of indicatorSeriesRef.current) {
      chart.removeSeries(entry.series)
    }
    indicatorSeriesRef.current = []

    for (const indId of activeIndicators) {
      const indicator = AVAILABLE_INDICATORS.find(i => i.id === indId)
      if (!indicator) continue
      const result = computeIndicator(indicator, parsedData)
      if (!result) continue

      if (result.type === 'volume') {
        const series = chart.addSeries(HistogramSeries, {
          priceFormat: { type: 'volume' },
          priceScaleId: 'volume',
          priceLineVisible: false,
          lastValueVisible: false,
        })
        chart.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
        })
        series.setData(result.data)
        indicatorSeriesRef.current.push({ series, data: result.data })
      } else if (result.type === 'line') {
        const series = chart.addSeries(LineSeries, {
          color: result.color,
          lineWidth: 1.5,
          crosshairMarkerVisible: false,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        series.setData(result.data)
        indicatorSeriesRef.current.push({ series, data: result.data })
      } else if (result.type === 'bb') {
        for (const band of [result.upper, result.middle, result.lower]) {
          const series = chart.addSeries(LineSeries, {
            color: band.color,
            lineWidth: band === result.middle ? 1.5 : 1,
            lineStyle: band === result.middle ? 0 : 2,
            crosshairMarkerVisible: false,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          series.setData(band.data)
          indicatorSeriesRef.current.push({ series, data: band.data })
        }
      }
    }

    // Remove old GEX price lines before adding new ones
    for (const pl of gexPriceLinesRef.current) {
      mainSeries.removePriceLine(pl)
    }
    gexPriceLinesRef.current = []

    if (gexLevels && gexLevels.levels && activeIndicators.includes('gex')) {
      for (const level of gexLevels.levels) {
        // strikeFutures is nullable; Number(null)===0 passes isFinite so check explicitly.
        // Fall back to strikeEtf * conversionRatio when strikeFutures is missing.
        const price = level.strikeFutures != null
          ? Number(level.strikeFutures)
          : (level.strikeEtf != null && gexLevels.conversionRatio != null)
            ? Number(level.strikeEtf) * Number(gexLevels.conversionRatio)
            : NaN
        if (!Number.isFinite(price) || price === 0) continue
        const color = GEX_COLORS[level.label] || '#ffffff'
        const isKey = level.label === 'call_wall' || level.label === 'put_wall'
        const labelName = GEX_LABELS[level.label] || level.label
        const gexVal = level.gex != null ? ` ${(level.gex / 1e6).toFixed(1)}M` : ''
        const pl = mainSeries.createPriceLine({
          price,
          color,
          lineWidth: isKey ? 2 : 1,
          lineStyle: level.label === 'zero_gamma' ? 2 : 0,
          axisLabelVisible: true,
          title: `${labelName}${gexVal}`,
        })
        gexPriceLinesRef.current.push(pl)
      }
    }

    // On first data load, restore saved range or fit content
    if (isFirstDataRef.current) {
      isFirstDataRef.current = false
      if (savedRangeRef.current) {
        chart.timeScale().setVisibleRange(savedRangeRef.current)
      } else {
        chart.timeScale().fitContent()
      }
    }
  }, [data, activeIndicators, gexLevels, chartType, timezone, upColor, downColor, borderUpColor, borderDownColor])

  // Merge the live tick into the developing bar via mainSeries.update().
  // Deliberately depends ONLY on livePrice so a tick doesn't re-run setData
  // or rebuild indicators — that would flicker and burn CPU. When the next
  // confirmed bar arrives through /since, the main setData effect rewrites
  // the last bar authoritatively, and the next livePrice tick updates that
  // new bar. Volume stays untouched because a single tick price can't be
  // turned into a reliable volume estimate.
  useEffect(() => {
    const mainSeries = seriesRef.current
    const bars = dataRef.current
    if (!mainSeries || !bars?.length || livePrice == null) return
    const last = bars[bars.length - 1]
    if (last?.time == null) return

    // Reject obvious bad ticks (stale price, zero, wrong-symbol quote).
    // A single 3s live tick shouldn't move more than ~1% from the bar's
    // own close on a normal market. If it does, assume yfinance fast_info
    // hiccuped and skip this update — the next tick will self-correct.
    if (!(last.close > 0) || Math.abs(livePrice - last.close) / last.close > 0.01) return

    const isLineType = ['line', 'square-line', 'line-shaded', 'line-gradient', 'square-line-shaded', 'square-line-gradient'].includes(chartType)
    try {
      if (isLineType) {
        mainSeries.update({ time: last.time, value: livePrice })
      } else {
        const merged = {
          ...last,
          high: Math.max(last.high, livePrice),
          low: Math.min(last.low, livePrice),
          close: livePrice,
        }
        if (chartType === 'candlestick-trend') {
          const prev = bars.length > 1 ? bars[bars.length - 2].close : last.open
          const isUp = livePrice >= prev
          merged.color = isUp ? upColor : downColor
          merged.borderColor = isUp ? (borderUpColor || upColor) : (borderDownColor || downColor)
          merged.wickColor = isUp ? upColor : downColor
        }
        mainSeries.update(merged)
      }
    } catch { /* series not ready / stale ref during chartType swap — skip */ }
  }, [livePrice, chartType, upColor, downColor, borderUpColor, borderDownColor])

  useEffect(() => {
    if (!seriesRef.current) return
    const s = seriesRef.current
    const isLine = ['line', 'square-line'].includes(chartType)
    const isArea = ['line-shaded', 'line-gradient', 'square-line-shaded', 'square-line-gradient'].includes(chartType)
    const isBar = ['ohlc', 'hlc', 'highlow'].includes(chartType)
    const isHollow = chartType === 'hollow'

    if (isLine) {
      s.applyOptions({ color: upColor })
    } else if (isArea) {
      const alpha = chartType.includes('gradient') ? '80' : '60'
      const bottom = chartType.includes('gradient') ? 'transparent' : upColor + '05'
      s.applyOptions({ lineColor: upColor, topColor: upColor + alpha, bottomColor: bottom })
    } else if (isBar) {
      s.applyOptions({ upColor, downColor })
    } else if (isHollow) {
      s.applyOptions({
        upColor: bgColor, downColor: bgColor,
        borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
        wickUpColor: upColor, wickDownColor: downColor,
      })
    } else if (chartType === '3d-candlestick') {
      s.applyOptions({
        upColor, downColor,
        borderUpColor: '#ffffff40', borderDownColor: '#ffffff40',
        wickUpColor: upColor, wickDownColor: downColor,
      })
    } else if (chartType === 'candlestick-flat') {
      s.applyOptions({
        upColor, downColor,
        borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
        wickUpColor: '#888', wickDownColor: '#888',
      })
    } else if (['candlestick', 'candlestick-trend'].includes(chartType)) {
      s.applyOptions({
        upColor, downColor,
        borderUpColor: borderUpColor || upColor, borderDownColor: borderDownColor || downColor,
        wickUpColor: upColor, wickDownColor: downColor,
      })
    }
  }, [upColor, downColor, bgColor, borderUpColor, borderDownColor, chartType])

  // Draw all completed drawings + preview on canvas
  useEffect(() => {
    const canvas = drawCanvasRef.current
    const chart = chartRef.current
    const series = seriesRef.current
    if (!canvas || !chart || !series) return

    const renderDrawings = () => {
      const container = chartContainerRef.current
      if (!container) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = container.clientWidth * dpr
      canvas.height = container.clientHeight * dpr
      canvas.style.width = container.clientWidth + 'px'
      canvas.style.height = container.clientHeight + 'px'
      const ctx = canvas.getContext('2d')
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, container.clientWidth, container.clientHeight)

      const toPixel = (time, price) => {
        const x = chart.timeScale().timeToCoordinate(time)
        const y = series.priceToCoordinate(price)
        return { x, y }
      }

      // Use drag preview for the dragged drawing
      const allDrawings = drawings.map((d, i) =>
        dragRef.current && dragRef.current.index === i ? dragRef.current.current : d
      )
      // Add preview drawing if in progress
      const state = drawingStateRef.current
      if (state.startPoint && previewPoint && drawingTool) {
        allDrawings.push({
          type: drawingTool,
          start: state.startPoint,
          end: previewPoint,
          preview: true,
        })
      }

      for (const d of allDrawings) {
        const drawColor = d.color || '#4A90A4'
        ctx.strokeStyle = d.preview ? 'rgba(79, 195, 247, 0.6)' : drawColor
        ctx.lineWidth = d.preview ? 1 : 1.5
        ctx.setLineDash(d.preview ? [4, 4] : [])

        if (d.type === 'horizontal') {
          const y = series.priceToCoordinate(d.start.price)
          if (y === null) continue
          ctx.beginPath()
          ctx.moveTo(0, y)
          ctx.lineTo(container.clientWidth, y)
          ctx.stroke()
          // Label
          ctx.fillStyle = d.preview ? 'rgba(79, 195, 247, 0.6)' : drawColor
          ctx.font = '11px sans-serif'
          ctx.fillText(d.start.price.toFixed(2), 4, y - 4)
        } else if (d.type === 'trendline' || d.type === 'ray') {
          const p1 = toPixel(d.start.time, d.start.price)
          const p2 = toPixel(d.end.time, d.end.price)
          if (p1.x === null || p1.y === null || p2.x === null || p2.y === null) continue
          ctx.beginPath()
          if (d.type === 'ray') {
            // Extend line to the right edge
            const dx = p2.x - p1.x
            const dy = p2.y - p1.y
            if (dx !== 0) {
              const slope = dy / dx
              const endX = container.clientWidth
              const endY = p1.y + slope * (endX - p1.x)
              ctx.moveTo(p1.x, p1.y)
              ctx.lineTo(endX, endY)
            } else {
              ctx.moveTo(p1.x, 0)
              ctx.lineTo(p1.x, container.clientHeight)
            }
          } else {
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
          }
          ctx.stroke()
        } else if (d.type === 'rectangle') {
          const p1 = toPixel(d.start.time, d.start.price)
          const p2 = toPixel(d.end.time, d.end.price)
          if (p1.x === null || p1.y === null || p2.x === null || p2.y === null) continue
          const x = Math.min(p1.x, p2.x)
          const y = Math.min(p1.y, p2.y)
          const w = Math.abs(p2.x - p1.x)
          const h = Math.abs(p2.y - p1.y)
          ctx.fillStyle = d.preview ? 'rgba(79, 195, 247, 0.08)' : (drawColor + '20')
          ctx.fillRect(x, y, w, h)
          ctx.strokeRect(x, y, w, h)
        } else if (d.type === 'rect-ray') {
          const p1 = toPixel(d.start.time, d.start.price)
          const y1 = series.priceToCoordinate(d.start.price)
          const y2 = series.priceToCoordinate(d.end.price)
          if (p1.x === null || y1 === null || y2 === null) continue
          const x = p1.x
          const y = Math.min(y1, y2)
          const h = Math.abs(y2 - y1)
          const w = container.clientWidth - x
          ctx.fillStyle = d.preview ? 'rgba(79, 195, 247, 0.08)' : (drawColor + '20')
          ctx.fillRect(x, y, w, h)
          ctx.strokeRect(x, y, w, h)
        } else if (d.type === 'volume-profile') {
          const x1 = chart.timeScale().timeToCoordinate(d.start.time)
          const x2 = chart.timeScale().timeToCoordinate(d.end.time)
          if (x1 === null || x2 === null) continue
          const leftX = Math.min(x1, x2)
          const rightX = Math.max(x1, x2)
          const rangeWidth = rightX - leftX

          // Draw time-range boundary lines
          ctx.beginPath()
          ctx.setLineDash([4, 4])
          ctx.strokeStyle = d.preview ? 'rgba(79, 195, 247, 0.4)' : (drawColor + '60')
          ctx.moveTo(leftX, 0); ctx.lineTo(leftX, container.clientHeight)
          ctx.moveTo(rightX, 0); ctx.lineTo(rightX, container.clientHeight)
          ctx.stroke()
          ctx.setLineDash([])

          // Filter chart data to the selected time range
          const tMin = Math.min(d.start.time, d.end.time)
          const tMax = Math.max(d.start.time, d.end.time)
          const rangeBars = dataRef.current.filter(b => b.time >= tMin && b.time <= tMax && b.volume > 0)

          if (rangeBars.length > 0) {
            const vpResult = computeVolumeProfile(rangeBars, 4)
            if (vpResult) {
              const { buckets: vpBuckets, maxVol: vpMaxVol } = vpResult
              const pocBucket = vpBuckets.reduce((max, b) => b.volume > max.volume ? b : max, vpBuckets[0])
              const va = computeValueArea(vpBuckets, 0.7)
              const maxBarWidth = rangeWidth

              for (let bi = 0; bi < vpBuckets.length; bi++) {
                const bucket = vpBuckets[bi]
                if (bucket.volume === 0) continue
                const yTop = series.priceToCoordinate(bucket.priceTop)
                const yBottom = series.priceToCoordinate(bucket.priceBottom)
                if (yTop === null || yBottom === null) continue

                const barH = Math.abs(yBottom - yTop)
                const barW = (bucket.volume / vpMaxVol) * maxBarWidth
                const bx = leftX

                const isPOC = bucket === pocBucket
                const inVA = va && bi >= va.lo && bi <= va.hi

                if (d.preview) {
                  ctx.fillStyle = isPOC ? 'rgba(79, 195, 247, 0.35)' : 'rgba(79, 195, 247, 0.15)'
                  ctx.strokeStyle = 'rgba(79, 195, 247, 0.5)'
                } else if (isPOC) {
                  ctx.fillStyle = '#ff1744' + '80'
                  ctx.strokeStyle = '#ff1744' + 'cc'
                } else if (inVA) {
                  ctx.fillStyle = drawColor + '50'
                  ctx.strokeStyle = drawColor + '70'
                } else {
                  ctx.fillStyle = 'rgba(136,136,136,0.2)'
                  ctx.strokeStyle = 'rgba(136,136,136,0.35)'
                }
                ctx.lineWidth = isPOC ? 1 : 0.5
                ctx.fillRect(bx, Math.min(yTop, yBottom), barW, Math.max(barH, 1))
                ctx.strokeRect(bx, Math.min(yTop, yBottom), barW, Math.max(barH, 1))
              }
            }
          }
        }
      }

      // Draw handles for hovered or dragged drawing
      const activeIdx = dragRef.current?.index ?? hoveredIdxRef.current
      if (activeIdx !== null && activeIdx >= 0 && activeIdx < allDrawings.length) {
        const activeDraw = allDrawings[activeIdx]
        if (activeDraw && !activeDraw.preview) {
          const handles = getDrawingHandles(activeDraw, toPixel, series, container.clientWidth)
          ctx.setLineDash([])
          for (const h of handles) {
            ctx.beginPath()
            ctx.arc(h.x, h.y, HANDLE_RADIUS, 0, Math.PI * 2)
            ctx.fillStyle = '#ffffff'
            ctx.fill()
            ctx.strokeStyle = activeDraw.color || '#4A90A4'
            ctx.lineWidth = 2
            ctx.stroke()
          }
        }
      }
    }

    renderFnRef.current = renderDrawings
    renderDrawings()

    const sub = chart.timeScale().subscribeVisibleLogicalRangeChange(renderDrawings)
    const resizeObs = new ResizeObserver(renderDrawings)
    resizeObs.observe(chartContainerRef.current)

    return () => {
      sub && chart.timeScale().unsubscribeVisibleLogicalRangeChange(renderDrawings)
      resizeObs.disconnect()
    }
  }, [drawings, previewPoint, drawingTool])

  const getPointFromEvent = (e) => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return null

    const rect = chartContainerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    let time = chart.timeScale().coordinateToTime(x)
    const price = series.coordinateToPrice(y)
    if (price === null) return null

    // When clicking past the chart area (e.g. over volume profile),
    // fall back to the last visible bar's time
    if (time === null) {
      const range = chart.timeScale().getVisibleLogicalRange()
      if (range) {
        time = chart.timeScale().coordinateToTime(
          chart.timeScale().logicalToCoordinate(Math.floor(range.to))
        )
      }
    }

    return { time, price, pixelX: x }
  }

  const handleDrawingClick = (e) => {
    if (!drawingTool) return
    const point = getPointFromEvent(e)
    if (!point) return

    if (drawingTool === 'horizontal') {
      onDrawingComplete({ type: 'horizontal', start: point, end: point })
      return
    }

    // For non-horizontal tools, we need a valid time
    if (point.time === null) return

    const state = drawingStateRef.current
    if (!state.startPoint) {
      state.startPoint = point
    } else {
      onDrawingComplete({
        type: drawingTool,
        start: state.startPoint,
        end: point,
      })
      state.startPoint = null
      setPreviewPoint(null)
    }
  }

  const handleDrawingMouseMove = (e) => {
    if (!drawingTool || !drawingStateRef.current.startPoint) return
    const point = getPointFromEvent(e)
    if (!point) return
    if (point.time === null) return

    setPreviewPoint({ time: point.time, price: point.price })
  }

  // Reset drawing state when tool changes
  useEffect(() => {
    drawingStateRef.current.startPoint = null
    setPreviewPoint(null)
  }, [drawingTool])

  // Hover detection, drag, and double-click on drawings
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container || drawingTool) {
      // Clear hover when tool is active
      if (hoveredIdxRef.current !== null) {
        hoveredIdxRef.current = null
        renderFnRef.current?.()
      }
      return
    }
    if (drawings.length === 0) return

    const getChartCoords = (e) => {
      const chart = chartRef.current
      const series = seriesRef.current
      if (!chart || !series) return null
      const rect = container.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      let time = chart.timeScale().coordinateToTime(mx)
      const price = series.coordinateToPrice(my)
      return { mx, my, time, price }
    }

    const toPixel = (time, price) => {
      const chart = chartRef.current
      const series = seriesRef.current
      if (!chart || !series) return { x: null, y: null }
      return {
        x: chart.timeScale().timeToCoordinate(time),
        y: series.priceToCoordinate(price),
      }
    }

    const getSeries = () => seriesRef.current

    const findDrawingAt = (mx, my) => {
      const series = getSeries()
      if (!series) return { index: null, onHandle: null }
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i]
        const handles = getDrawingHandles(d, toPixel, series, container.clientWidth)
        const h = hitTestHandle(handles, mx, my)
        if (h) return { index: i, onHandle: h }
        if (hitTestBody(d, mx, my, toPixel, series, container.clientWidth))
          return { index: i, onHandle: null }
      }
      return { index: null, onHandle: null }
    }

    const onMouseMove = (e) => {
      const coords = getChartCoords(e)
      if (!coords) return

      // --- Active drag ---
      if (dragRef.current) {
        const drag = dragRef.current
        const { time, price } = coords
        if (price === null) return
        const orig = drag.original
        const newD = { ...drag.current, start: { ...drag.current.start }, end: { ...drag.current.end } }

        if (drag.handle === 'body') {
          const dPrice = price - drag.startPrice
          if (orig.type === 'horizontal') {
            newD.start.price = orig.start.price + dPrice
            newD.end.price = orig.end.price + dPrice
          } else {
            // Time delta: compute pixel delta and convert
            const chart = chartRef.current
            if (!chart || time === null || drag.startTime === null) {
              newD.start.price = orig.start.price + dPrice
              newD.end.price = orig.end.price + dPrice
            } else {
              const dTime = time - drag.startTime
              newD.start.time = orig.start.time + dTime
              newD.end.time = orig.end.time + dTime
              newD.start.price = orig.start.price + dPrice
              newD.end.price = orig.end.price + dPrice
            }
          }
        } else if (drag.handle === 'start') {
          if (orig.type === 'horizontal') {
            newD.start.price = price
            newD.end.price = price
          } else {
            newD.start = { time: time || orig.start.time, price }
          }
        } else if (drag.handle === 'end') {
          if (orig.type === 'horizontal') {
            newD.start.price = price
            newD.end.price = price
          } else {
            newD.end = { time: time || orig.end.time, price }
          }
        } else if (drag.handle === 'corner1') {
          // corner1 = (start.time, end.price)
          newD.start = { ...newD.start, time: time || orig.start.time }
          newD.end = { ...newD.end, price }
        } else if (drag.handle === 'corner2') {
          // corner2 = (end.time, start.price)
          newD.end = { ...newD.end, time: time || orig.end.time }
          newD.start = { ...newD.start, price }
        }

        drag.current = newD
        renderFnRef.current?.()
        return
      }

      // --- Hover detection ---
      const { mx, my } = coords
      const { index, onHandle } = findDrawingAt(mx, my)

      if (index !== hoveredIdxRef.current) {
        hoveredIdxRef.current = index
        renderFnRef.current?.()
      }

      if (index !== null) {
        container.style.cursor = onHandle ? 'grab' : 'move'
      } else {
        container.style.cursor = ''
      }
    }

    const onMouseDown = (e) => {
      if (hoveredIdxRef.current === null) return
      const coords = getChartCoords(e)
      if (!coords) return
      const { mx, my, time, price } = coords
      if (price === null) return

      const series = getSeries()
      if (!series) return
      const d = drawings[hoveredIdxRef.current]
      const handles = getDrawingHandles(d, toPixel, series, container.clientWidth)
      const onHandle = hitTestHandle(handles, mx, my)
      const handle = onHandle ? onHandle.id : 'body'

      // For body, confirm we're actually on the drawing
      if (handle === 'body' && !hitTestBody(d, mx, my, toPixel, series, container.clientWidth)) return

      e.preventDefault()
      e.stopPropagation()

      // Disable chart pan/zoom
      const chart = chartRef.current
      if (chart) chart.applyOptions({ handleScroll: false, handleScale: false })

      dragRef.current = {
        index: hoveredIdxRef.current,
        handle,
        startTime: time,
        startPrice: price,
        original: { ...d, start: { ...d.start }, end: { ...d.end } },
        current: { ...d, start: { ...d.start }, end: { ...d.end } },
      }
      container.style.cursor = 'grabbing'
    }

    const onMouseUp = () => {
      if (!dragRef.current) return
      const chart = chartRef.current
      if (chart) chart.applyOptions({ handleScroll: true, handleScale: true })

      onDrawingUpdate(dragRef.current.index, dragRef.current.current)
      dragRef.current = null
      hoveredIdxRef.current = null
      container.style.cursor = ''
      renderFnRef.current?.()
    }

    const onDblClick = (e) => {
      if (drawingTool) return
      const coords = getChartCoords(e)
      if (!coords) return
      const { index } = findDrawingAt(coords.mx, coords.my)
      if (index !== null) {
        setEditingDrawing({ index, x: e.clientX, y: e.clientY })
      }
    }

    container.addEventListener('mousemove', onMouseMove)
    container.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('mouseup', onMouseUp)
    container.addEventListener('dblclick', onDblClick)

    return () => {
      container.removeEventListener('mousemove', onMouseMove)
      container.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('mouseup', onMouseUp)
      container.removeEventListener('dblclick', onDblClick)
      container.style.cursor = ''
    }
  }, [drawings, drawingTool, onDrawingUpdate])

  // Close edit popup on outside click
  const editPopupRef = useRef(null)
  useEffect(() => {
    if (editingDrawing === null) return
    const handleOutside = (e) => {
      if (editPopupRef.current && !editPopupRef.current.contains(e.target)) {
        setEditingDrawing(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [editingDrawing])

  // Double-click on volume profile to open color popup
  useEffect(() => {
    const container = chartContainerRef.current
    if (!container || !vpData || !activeIndicators.includes('vpro')) return

    const onDblClick = (e) => {
      const series = seriesRef.current
      if (!series) return
      const rect = container.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const chartPane = container.querySelector('table td canvas')
      let chartLeft = 0
      let chartRight = container.clientWidth
      if (chartPane) {
        const paneRect = chartPane.getBoundingClientRect()
        chartLeft = Math.max(0, paneRect.left - rect.left)
        chartRight = Math.min(container.clientWidth, paneRect.right - rect.left)
      }
      const maxBarWidth = (chartRight - chartLeft) * 0.15
      const { buckets, maxVol } = vpData
      for (const bucket of buckets) {
        if (bucket.volume === 0) continue
        const yTop = series.priceToCoordinate(bucket.priceTop)
        const yBottom = series.priceToCoordinate(bucket.priceBottom)
        if (yTop === null || yBottom === null) continue
        const barWidth = (bucket.volume / maxVol) * maxBarWidth
        const x = vpSideRef.current === 'left' ? chartLeft : chartRight - barWidth
        const yMin = Math.min(yTop, yBottom)
        const yMax = yMin + Math.abs(yBottom - yTop)
        if (mx >= x && mx <= x + barWidth && my >= yMin && my <= yMax) {
          setVpColorPopup({ x: e.clientX, y: e.clientY })
          return
        }
      }
    }

    container.addEventListener('dblclick', onDblClick)
    return () => container.removeEventListener('dblclick', onDblClick)
  }, [vpData, activeIndicators])

  // Close VP color popup on outside click
  useEffect(() => {
    if (vpColorPopup === null) return
    const handleOutside = (e) => {
      if (vpPopupRef.current && !vpPopupRef.current.contains(e.target)) {
        setVpColorPopup(null)
      }
    }
    document.addEventListener('mousedown', handleOutside)
    return () => document.removeEventListener('mousedown', handleOutside)
  }, [vpColorPopup])

  const updateVpColor = (key, color) => {
    const next = { ...vpColors, [key]: color }
    setVpColors(next)
    localStorage.setItem('vpColors', JSON.stringify(next))
    // Trigger redraw after ref updates on next tick
    setTimeout(() => vpDrawRef.current?.(), 0)
  }

  return (
    <div ref={chartContainerRef} className="chart-container" style={{ position: 'relative' }}>
      {activeIndicators.includes('vpro') && (
        <canvas
          ref={vpCanvasRef}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
            zIndex: 2,
          }}
        />
      )}
      <canvas
        ref={drawCanvasRef}
        onClick={handleDrawingClick}
        onMouseMove={handleDrawingMouseMove}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: drawingTool ? 'auto' : 'none',
          cursor: drawingTool ? 'crosshair' : 'default',
          zIndex: 3,
        }}
      />
      {editingDrawing !== null && (
        <div
          ref={editPopupRef}
          className="drawing-edit-popup"
          style={{
            position: 'fixed',
            left: editingDrawing.x + 8,
            top: editingDrawing.y - 20,
          }}
        >
          <div className="drawing-edit-header">
            <span>Color</span>
            <button
              className="drawing-edit-delete"
              onClick={() => {
                onDrawingUpdate(editingDrawing.index, null)
                setEditingDrawing(null)
              }}
            >
              Delete
            </button>
          </div>
          <div className="drawing-color-grid">
            {DRAWING_PRESET_COLORS.map(c => (
              <button
                key={c}
                className={`drawing-color-swatch${drawings[editingDrawing.index]?.color === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => {
                  onDrawingUpdate(editingDrawing.index, { ...drawings[editingDrawing.index], color: c })
                  setEditingDrawing(null)
                }}
              />
            ))}
          </div>
        </div>
      )}
      {vpColorPopup !== null && (
        <div
          ref={vpPopupRef}
          className="drawing-edit-popup"
          style={{
            position: 'fixed',
            left: vpColorPopup.x + 8,
            top: vpColorPopup.y - 20,
          }}
        >
          <div className="drawing-edit-header">
            <span>Value Area</span>
          </div>
          <div className="drawing-color-grid">
            {DRAWING_PRESET_COLORS.map(c => (
              <button
                key={`bar-${c}`}
                className={`drawing-color-swatch${vpColors.bar === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => updateVpColor('bar', c)}
              />
            ))}
          </div>
          <div className="drawing-edit-header" style={{ marginTop: 8 }}>
            <span>Non-Value Area</span>
          </div>
          <div className="drawing-color-grid">
            {DRAWING_PRESET_COLORS.map(c => (
              <button
                key={`nonVa-${c}`}
                className={`drawing-color-swatch${vpColors.nonVa === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => updateVpColor('nonVa', c)}
              />
            ))}
          </div>
          <div className="drawing-edit-header" style={{ marginTop: 8 }}>
            <span>POC Color</span>
          </div>
          <div className="drawing-color-grid">
            {DRAWING_PRESET_COLORS.map(c => (
              <button
                key={`poc-${c}`}
                className={`drawing-color-swatch${vpColors.poc === c ? ' active' : ''}`}
                style={{ background: c }}
                onClick={() => updateVpColor('poc', c)}
              />
            ))}
          </div>
          <div className="drawing-edit-header" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: '0.85rem', color: '#ccc' }}>
              <input
                type="checkbox"
                checked={vaEnabled}
                onChange={(e) => setVaEnabled(e.target.checked)}
                style={{ accentColor: '#4A90A4' }}
              />
              Value Area
            </label>
            <input
              type="range"
              min="0.5"
              max="0.95"
              step="0.05"
              value={vaPct}
              disabled={!vaEnabled}
              onChange={(e) => setVaPct(Number(e.target.value))}
              style={{ width: 60, opacity: vaEnabled ? 1 : 0.4 }}
            />
            <span style={{ fontSize: '0.8rem', color: '#aaa', minWidth: 30 }}>{Math.round(vaPct * 100)}%</span>
          </div>
          <div className="drawing-edit-header" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.85rem', color: '#ccc' }}>Ticks/Row</span>
            <input
              type="range"
              min="1"
              max="1000"
              step="1"
              value={vpTicksPerRow}
              onChange={(e) => setVpTicksPerRow(Number(e.target.value))}
              style={{ width: 60 }}
            />
            <span style={{ fontSize: '0.8rem', color: '#aaa', minWidth: 20 }}>{vpTicksPerRow}</span>
          </div>
          <div className="drawing-edit-header" style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.85rem', color: '#ccc' }}>Side</span>
            <button
              onClick={() => {
                const next = vpSide === 'right' ? 'left' : 'right'
                setVpSide(next)
                localStorage.setItem('vpSide', next)
              }}
              style={{
                background: '#2a2a4e',
                border: '1px solid #4a4a6e',
                borderRadius: 4,
                color: '#ccc',
                padding: '2px 10px',
                cursor: 'pointer',
                fontSize: '0.8rem',
              }}
            >
              {vpSide === 'right' ? 'Right' : 'Left'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
