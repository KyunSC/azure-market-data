'use client'

import { useEffect, useRef } from 'react'
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

export default function CandlestickChart({
  data,
  upColor = DEFAULT_CHART_COLORS.upColor,
  downColor = DEFAULT_CHART_COLORS.downColor,
  activeIndicators = [],
  gexLevels = null,
  chartType = 'candlestick',
}) {
  const chartContainerRef = useRef()
  const chartRef = useRef()
  const seriesRef = useRef()
  const indicatorSeriesRef = useRef([])

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
        mode: 1,
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
          priceLineVisible: false,
          lastValueVisible: false,
        })
        series.setData(result.data)
        indicatorSeriesRef.current.push(series)
      } else if (result.type === 'bb') {
        for (const band of [result.upper, result.middle, result.lower]) {
          const series = chart.addSeries(LineSeries, {
            color: band.color,
            lineWidth: band === result.middle ? 1.5 : 1,
            lineStyle: band === result.middle ? 0 : 2,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          series.setData(band.data)
          indicatorSeriesRef.current.push(series)
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

  return <div ref={chartContainerRef} className="chart-container" />
}
