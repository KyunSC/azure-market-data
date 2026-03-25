'use client'

import { useEffect, useRef, useState } from 'react'
import { createChart, CandlestickSeries, LineSeries, HistogramSeries } from 'lightweight-charts'
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

function computeVolumeProfile(intradayData, numBuckets = 40) {
  if (!intradayData || intradayData.length === 0) return null

  let minPrice = Infinity, maxPrice = -Infinity
  for (const d of intradayData) {
    if (d.low < minPrice) minPrice = d.low
    if (d.high > maxPrice) maxPrice = d.high
  }

  const range = maxPrice - minPrice
  if (range <= 0) return null
  const bucketSize = range / numBuckets

  const buckets = Array.from({ length: numBuckets }, (_, i) => ({
    priceBottom: minPrice + i * bucketSize,
    priceTop: minPrice + (i + 1) * bucketSize,
    volume: 0,
  }))

  for (const d of intradayData) {
    const tp = (d.high + d.low + d.close) / 3
    const idx = Math.min(Math.floor((tp - minPrice) / bucketSize), numBuckets - 1)
    if (idx >= 0) buckets[idx].volume += d.volume
  }

  const maxVol = Math.max(...buckets.map(b => b.volume))
  return { buckets, maxVol }
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
}) {
  const chartContainerRef = useRef()
  const chartRef = useRef()
  const seriesRef = useRef()
  const indicatorSeriesRef = useRef([])
  const vpCanvasRef = useRef()
  const drawCanvasRef = useRef()
  const [vpData, setVpData] = useState(null)
  const drawingStateRef = useRef({ startPoint: null })
  const [previewPoint, setPreviewPoint] = useState(null)

  // Fetch 1m intraday data for volume profile
  useEffect(() => {
    if (!activeIndicators.includes('vpro') || !symbol) {
      setVpData(null)
      return
    }
    const fetchVP = async () => {
      try {
        const res = await fetch(`/api/historical?symbol=${symbol}&period=1d&interval=1m`)
        if (!res.ok) return
        const result = await res.json()
        const bars = (result.data || [])
          .map(d => ({
            time: Number(d.time),
            open: Number(d.open),
            high: Number(d.high),
            low: Number(d.low),
            close: Number(d.close),
            volume: Number(d.volume),
          }))
          .filter(d => !isNaN(d.open) && !isNaN(d.volume))
          .filter(d => {
            // Filter to 9:30-16:00 ET (UTC-4 or UTC-5)
            const date = new Date(d.time * 1000)
            const et = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }))
            const h = et.getHours(), m = et.getMinutes()
            const mins = h * 60 + m
            return mins >= 570 && mins <= 960 // 9:30=570, 16:00=960
          })
        setVpData(computeVolumeProfile(bars))
      } catch {
        setVpData(null)
      }
    }
    fetchVP()
  }, [activeIndicators, symbol])

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

      for (const bucket of buckets) {
        if (bucket.volume === 0) continue
        const yTop = series.priceToCoordinate(bucket.priceTop)
        const yBottom = series.priceToCoordinate(bucket.priceBottom)
        if (yTop === null || yBottom === null) continue

        const barHeight = Math.abs(yBottom - yTop)
        const barWidth = (bucket.volume / maxVol) * maxBarWidth
        const x = container.clientWidth - barWidth - 55 // offset from price scale

        const isPOC = bucket === pocBucket
        ctx.fillStyle = isPOC ? 'rgba(255, 235, 59, 0.5)' : 'rgba(100, 149, 237, 0.35)'
        ctx.fillRect(x, Math.min(yTop, yBottom), barWidth, Math.max(barHeight, 1))
        ctx.strokeStyle = isPOC ? 'rgba(255, 235, 59, 0.8)' : 'rgba(100, 149, 237, 0.6)'
        ctx.lineWidth = isPOC ? 1 : 0.5
        ctx.strokeRect(x, Math.min(yTop, yBottom), barWidth, Math.max(barHeight, 1))
      }
    }

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
  }, [vpData, data])

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

    let mainSeries
    if (chartType === 'line') {
      mainSeries = chart.addSeries(LineSeries, {
        color: upColor,
        lineWidth: 2,
      })
      mainSeries.setData(parsedData.map(d => ({ time: d.time, value: d.close })))
    } else if (chartType === 'hollow') {
      const bgColor = '#1a1a2e'
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor: bgColor,
        downColor: bgColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      })
      mainSeries.setData(parsedData)
    } else {
      mainSeries = chart.addSeries(CandlestickSeries, {
        upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
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
        indicatorSeriesRef.current.push(series)
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
        mainSeries.createPriceLine({
          price: level.strikeNq,
          color,
          lineWidth: isKey ? 2 : 1,
          lineStyle: level.label === 'zero_gamma' ? 2 : 0,
          axisLabelVisible: true,
          title: GEX_LABELS[level.label] || level.label,
        })
      }
    }

    // Show crosshair marker on indicator lines only when cursor is within 15px
    chart.subscribeCrosshairMove((param) => {
      for (const entry of indicatorSeriesRef.current) {
        const { series: indSeries } = entry
        const seriesData = param.seriesData?.get(indSeries)
        if (!seriesData || seriesData.value === undefined) {
          indSeries.applyOptions({ crosshairMarkerVisible: false })
          continue
        }
        const indY = indSeries.priceToCoordinate(seriesData.value)
        const mainData = param.seriesData?.get(mainSeries)
        let cursorY = null
        if (mainData) {
          const price = mainData.close !== undefined ? mainData.close : mainData.value
          if (price !== undefined) cursorY = mainSeries.priceToCoordinate(price)
        }
        if (indY !== null && param.point?.y !== undefined) {
          const dist = Math.abs(param.point.y - indY)
          indSeries.applyOptions({ crosshairMarkerVisible: dist < 2 })
        } else {
          indSeries.applyOptions({ crosshairMarkerVisible: false })
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
    if (chartType === 'line') {
      seriesRef.current.applyOptions({ color: upColor })
    } else if (chartType === 'hollow') {
      seriesRef.current.applyOptions({
        upColor: '#1a1a2e',
        downColor: '#1a1a2e',
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
      })
    } else {
      seriesRef.current.applyOptions({
        upColor,
        downColor,
        borderUpColor: upColor,
        borderDownColor: downColor,
        wickUpColor: upColor,
        wickDownColor: downColor,
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

      const allDrawings = [...drawings]
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
        ctx.strokeStyle = d.preview ? 'rgba(79, 195, 247, 0.6)' : '#4fc3f7'
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
          ctx.fillStyle = d.preview ? 'rgba(79, 195, 247, 0.6)' : '#4fc3f7'
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
          ctx.fillStyle = d.preview ? 'rgba(79, 195, 247, 0.08)' : 'rgba(79, 195, 247, 0.12)'
          ctx.fillRect(x, y, w, h)
          ctx.strokeRect(x, y, w, h)
        }
      }
    }

    renderDrawings()

    const sub = chart.timeScale().subscribeVisibleLogicalRangeChange(renderDrawings)
    const resizeObs = new ResizeObserver(renderDrawings)
    resizeObs.observe(chartContainerRef.current)

    return () => {
      sub && chart.timeScale().unsubscribeVisibleLogicalRangeChange(renderDrawings)
      resizeObs.disconnect()
    }
  }, [drawings, previewPoint, drawingTool])

  const handleDrawingClick = (e) => {
    if (!drawingTool) return
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return

    const rect = chartContainerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const time = chart.timeScale().coordinateToTime(x)
    const price = series.coordinateToPrice(y)
    if (time === null || price === null) return

    const point = { time, price }

    if (drawingTool === 'horizontal') {
      onDrawingComplete({ type: 'horizontal', start: point, end: point })
      return
    }

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
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series) return

    const rect = chartContainerRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top

    const time = chart.timeScale().coordinateToTime(x)
    const price = series.coordinateToPrice(y)
    if (time === null || price === null) return

    setPreviewPoint({ time, price })
  }

  // Reset drawing state when tool changes
  useEffect(() => {
    drawingStateRef.current.startPoint = null
    setPreviewPoint(null)
  }, [drawingTool])

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
    </div>
  )
}
