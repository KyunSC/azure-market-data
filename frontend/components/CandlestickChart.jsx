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

function computeVolumeProfile(intradayData, ticksPerRow = 4) {
  if (!intradayData || intradayData.length === 0) return null

  const bucketSize = ticksPerRow * TICK_SIZE

  let minPrice = Infinity, maxPrice = -Infinity
  for (const d of intradayData) {
    if (d.low < minPrice) minPrice = d.low
    if (d.high > maxPrice) maxPrice = d.high
  }

  const range = maxPrice - minPrice
  if (range <= 0) return null

  // Align to tick grid
  const alignedMin = Math.floor(minPrice / bucketSize) * bucketSize
  const alignedMax = Math.ceil(maxPrice / bucketSize) * bucketSize
  const numBuckets = Math.round((alignedMax - alignedMin) / bucketSize)

  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    priceBottom: alignedMin + i * bucketSize,
    priceTop: alignedMin + (i + 1) * bucketSize,
    volume: 0,
  }))

  for (const d of intradayData) {
    const tp = (d.high + d.low + d.close) / 3
    const idx = Math.min(Math.floor((tp - alignedMin) / bucketSize), numBuckets - 1)
    if (idx >= 0) buckets[idx].volume += d.volume
  }

  const maxVol = Math.max(...buckets.map(b => b.volume))
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
  '#4fc3f7', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8',
  '#ff922b', '#20c997', '#748ffc', '#f06595', '#ffffff',
  '#888888', '#aaaaaa', '#555555',
]

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
  return false
}

export default function CandlestickChart({
  data,
  symbol,
  upColor = DEFAULT_CHART_COLORS.upColor,
  downColor = DEFAULT_CHART_COLORS.downColor,
  activeIndicators = [],
  gexLevels = null,
  chartType = 'candlestick',
  drawingTool = null,
  drawings = [],
  onDrawingComplete = () => {},
  onDrawingUpdate = () => {},
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
          if (parsed.bar?.startsWith('#') && parsed.poc?.startsWith('#')) return parsed
          localStorage.removeItem('vpColors')
        }
      } catch { localStorage.removeItem('vpColors') }
    }
    return { bar: '#888888', poc: '#ff0000' }
  })
  const vpColorsRef = useRef(vpColors)
  vpColorsRef.current = vpColors
  const [vpColorPopup, setVpColorPopup] = useState(null) // { x, y }
  const vpPopupRef = useRef(null)
  const vpDrawRef = useRef(null)
  const drawingStateRef = useRef({ startPoint: null })
  const [previewPoint, setPreviewPoint] = useState(null)
  const [editingDrawing, setEditingDrawing] = useState(null) // { index, x, y }
  const hoveredIdxRef = useRef(null)
  const dragRef = useRef(null) // { index, handle, startTime, startPrice, original, current }
  const renderFnRef = useRef(null)

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

      const maxBarWidth = container.clientWidth * 0.15
      const { buckets, maxVol } = vpData
      const pocBucket = buckets.reduce((max, b) => b.volume > max.volume ? b : max, buckets[0])
      const va = vaEnabled ? computeValueArea(buckets, vaPct) : null

      for (let i = 0; i < buckets.length; i++) {
        const bucket = buckets[i]
        if (bucket.volume === 0) continue
        const yTop = series.priceToCoordinate(bucket.priceTop)
        const yBottom = series.priceToCoordinate(bucket.priceBottom)
        if (yTop === null || yBottom === null) continue

        const barHeight = Math.abs(yBottom - yTop)
        const barWidth = (bucket.volume / maxVol) * maxBarWidth
        const x = container.clientWidth - barWidth - 100 // offset from price scale

        const isPOC = bucket === pocBucket
        const inVA = va && i >= va.lo && i <= va.hi
        const hex = isPOC ? vpColorsRef.current.poc : vpColorsRef.current.bar
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
  }, [vpData, data, activeIndicators, gexLevels, chartType, vaEnabled, vaPct])

  useEffect(() => {
    if (!chartContainerRef.current) return

    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { color: '#1a1a2e' },
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
      width: chartContainerRef.current.clientWidth,
      height: 400,
    })

    const parsedData = data
      .filter(d => d.open != null && d.high != null && d.low != null && d.close != null)
      .map(d => ({
        time: /^\d+$/.test(d.time) ? Number(d.time) : d.time,
        open: Number(d.open),
        high: Number(d.high),
        low: Number(d.low),
        close: Number(d.close),
        volume: Number(d.volume),
      }))
      .filter(d => !isNaN(d.open) && !isNaN(d.high) && !isNaN(d.low) && !isNaN(d.close))

    const lineData = parsedData.map(d => ({ time: d.time, value: d.close }))
    const bgColor = '#1a1a2e'

    let mainSeries
    switch (chartType) {
      // --- Bar types ---
      case 'ohlc':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: true, thinBars: false,
        })
        mainSeries.setData(parsedData)
        break
      case 'hlc':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: false, thinBars: false,
        })
        mainSeries.setData(parsedData)
        break
      case 'highlow':
        mainSeries = chart.addSeries(BarSeries, {
          upColor, downColor, openVisible: false, thinBars: true,
        })
        mainSeries.setData(parsedData)
        break

      // --- Candlestick types ---
      case 'candlestick':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        mainSeries.setData(parsedData)
        break
      case 'candlestick-trend': {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        const trendData = parsedData.map((d, i) => {
          const prev = i > 0 ? parsedData[i - 1].close : d.open
          const isUp = d.close >= prev
          return {
            ...d,
            color: isUp ? upColor : downColor,
            borderColor: isUp ? upColor : downColor,
            wickColor: isUp ? upColor : downColor,
          }
        })
        mainSeries.setData(trendData)
        break
      }
      case '3d-candlestick': {
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: '#ffffff40', borderDownColor: '#ffffff40',
          wickUpColor: upColor, wickDownColor: downColor,
        })
        mainSeries.setData(parsedData)
        break
      }
      case 'hollow':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor: bgColor, downColor: bgColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        mainSeries.setData(parsedData)
        break
      case 'candlestick-flat':
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: '#888', wickDownColor: '#888',
        })
        mainSeries.setData(parsedData)
        break

      // --- Line types ---
      case 'line':
        mainSeries = chart.addSeries(LineSeries, { color: upColor, lineWidth: 2 })
        mainSeries.setData(lineData)
        break
      case 'line-shaded':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '60', bottomColor: upColor + '05',
          lineColor: upColor, lineWidth: 2,
        })
        mainSeries.setData(lineData)
        break
      case 'line-gradient':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '80', bottomColor: 'transparent',
          lineColor: upColor, lineWidth: 2,
        })
        mainSeries.setData(lineData)
        break
      case 'square-line':
        mainSeries = chart.addSeries(LineSeries, {
          color: upColor, lineWidth: 2, lineType: 1,
        })
        mainSeries.setData(lineData)
        break
      case 'square-line-shaded':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '60', bottomColor: upColor + '05',
          lineColor: upColor, lineWidth: 2, lineType: 1,
        })
        mainSeries.setData(lineData)
        break
      case 'square-line-gradient':
        mainSeries = chart.addSeries(AreaSeries, {
          topColor: upColor + '80', bottomColor: 'transparent',
          lineColor: upColor, lineWidth: 2, lineType: 1,
        })
        mainSeries.setData(lineData)
        break

      default:
        mainSeries = chart.addSeries(CandlestickSeries, {
          upColor, downColor,
          borderUpColor: upColor, borderDownColor: downColor,
          wickUpColor: upColor, wickDownColor: downColor,
        })
        mainSeries.setData(parsedData)
    }
    chart.timeScale().fitContent()
    chartRef.current = chart
    seriesRef.current = mainSeries
    indicatorSeriesRef.current = []

    // Add indicator series
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

    // Add GEX level price lines
    if (gexLevels && gexLevels.levels && activeIndicators.includes('gex')) {
      for (const level of gexLevels.levels) {
        const color = GEX_COLORS[level.label] || '#ffffff'
        const isKey = level.label === 'call_wall' || level.label === 'put_wall'
        const labelName = GEX_LABELS[level.label] || level.label
        const gexVal = level.gex != null ? ` ${(level.gex / 1e6).toFixed(1)}M` : ''
        mainSeries.createPriceLine({
          price: level.strikeFutures,
          color,
          lineWidth: isKey ? 2 : 1,
          lineStyle: level.label === 'zero_gamma' ? 2 : 0,
          axisLabelVisible: true,
          title: `${labelName}${gexVal}`,
        })
      }
    }

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
        chart.applyOptions({ width: chartContainerRef.current.clientWidth })
      }
    }

    window.addEventListener('resize', handleResize)

    return () => {
      window.removeEventListener('resize', handleResize)
      chart.remove()
    }
  }, [data, activeIndicators, gexLevels, chartType])

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
        upColor: '#1a1a2e', downColor: '#1a1a2e',
        borderUpColor: upColor, borderDownColor: downColor,
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
        borderUpColor: upColor, borderDownColor: downColor,
        wickUpColor: '#888', wickDownColor: '#888',
      })
    } else if (['candlestick', 'candlestick-trend'].includes(chartType)) {
      s.applyOptions({
        upColor, downColor,
        borderUpColor: upColor, borderDownColor: downColor,
        wickUpColor: upColor, wickDownColor: downColor,
      })
    }
  }, [upColor, downColor, chartType])

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
        const drawColor = d.color || '#4fc3f7'
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
            ctx.strokeStyle = activeDraw.color || '#4fc3f7'
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
      const maxBarWidth = container.clientWidth * 0.15
      const { buckets, maxVol } = vpData
      for (const bucket of buckets) {
        if (bucket.volume === 0) continue
        const yTop = series.priceToCoordinate(bucket.priceTop)
        const yBottom = series.priceToCoordinate(bucket.priceBottom)
        if (yTop === null || yBottom === null) continue
        const barWidth = (bucket.volume / maxVol) * maxBarWidth
        const x = container.clientWidth - barWidth - 100
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
            <span>Bar Color</span>
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
                style={{ accentColor: '#4fc3f7' }}
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
        </div>
      )}
    </div>
  )
}
