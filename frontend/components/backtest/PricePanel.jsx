'use client'

import { useEffect, useMemo, useRef } from 'react'
import { createChart, CandlestickSeries, LineSeries, createSeriesMarkers } from 'lightweight-charts'
import { useBacktest } from '../../lib/backtest/store'
import Panel, { EmptyState } from './Panel'

const UP = '#4caf50'
const DOWN = '#ff6b6b'

/**
 * Price with entry/exit markers, reusing the same charting engine as the
 * ticker page so a trade drawn here sits on exactly the candles the engine
 * filled against.
 */
export default function PricePanel() {
  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const markersRef = useRef(null)
  const overlayRef = useRef(null)

  const dataset = useBacktest((s) => s.dataset)
  const result = useBacktest((s) => s.result)
  const selectedTrade = useBacktest((s) => s.selectedTrade)
  const datasetLoading = useBacktest((s) => s.datasetLoading)

  const candles = useMemo(() => {
    if (!dataset) return []
    const out = new Array(dataset.n)
    for (let i = 0; i < dataset.n; i++) {
      out[i] = {
        time: dataset.time[i],
        open: dataset.open[i],
        high: dataset.high[i],
        low: dataset.low[i],
        close: dataset.close[i],
      }
    }
    return out
  }, [dataset])

  // Chart lifecycle
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      layout: {
        background: { color: 'transparent' },
        textColor: '#8A9098',
        fontFamily: 'var(--font-jetbrains-mono), monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(34,38,45,0.6)' },
        horzLines: { color: 'rgba(34,38,45,0.6)' },
      },
      rightPriceScale: { borderColor: '#22262D', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: '#22262D', timeVisible: true, secondsVisible: false, rightOffset: 4 },
      crosshair: {
        mode: 0,
        vertLine: { color: '#4A90A4', width: 1, style: 3, labelBackgroundColor: '#1c2027' },
        horzLine: { color: '#4A90A4', width: 1, style: 3, labelBackgroundColor: '#1c2027' },
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
      autoSize: true,
    })
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceLineVisible: false,
      lastValueVisible: false,
    })
    chartRef.current = chart
    seriesRef.current = series

    return () => {
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      markersRef.current = null
      overlayRef.current = null
    }
  }, [])

  // Bars
  useEffect(() => {
    if (!seriesRef.current || !candles.length) return
    seriesRef.current.setData(candles)
    chartRef.current?.timeScale().fitContent()
  }, [candles])

  // Trade markers — v5 moved markers to the series-markers plugin.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    if (!result) {
      markersRef.current?.setMarkers([])
      return
    }

    // Past ~40 trades the labels overlap into a smear and hide the candles they
    // are supposed to explain, so only the shapes survive at high trade counts.
    const labelled = result.trades.length <= 40
    const markers = []
    for (const t of result.trades) {
      const long = t.side === 'long'
      markers.push({
        time: t.entryTime,
        position: long ? 'belowBar' : 'aboveBar',
        color: long ? UP : DOWN,
        shape: long ? 'arrowUp' : 'arrowDown',
        text: labelled ? (long ? 'L' : 'S') : undefined,
      })
      markers.push({
        time: t.exitTime,
        position: long ? 'aboveBar' : 'belowBar',
        color: t.pnl >= 0 ? '#E8B339' : '#8A9098',
        shape: 'circle',
        text: labelled ? `${t.pnl >= 0 ? '+' : ''}${(t.pnlPct * 100).toFixed(2)}%` : undefined,
      })
    }
    markers.sort((a, b) => a.time - b.time)

    if (!markersRef.current) markersRef.current = createSeriesMarkers(series, markers)
    else markersRef.current.setMarkers(markers)
  }, [result])

  // Model prediction overlay (research plane only) — shows where the forest had
  // an opinion and where it was still training.
  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    if (overlayRef.current) {
      chart.removeSeries(overlayRef.current)
      overlayRef.current = null
    }
    if (!dataset?.ml?.pred) return
    const line = chart.addSeries(LineSeries, {
      color: 'rgba(124,107,214,0.75)',
      lineWidth: 1,
      priceScaleId: 'ml',
      lastValueVisible: false,
      priceLineVisible: false,
    })
    chart.priceScale('ml').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false })
    const pts = []
    for (let i = 0; i < dataset.n; i++) {
      const v = dataset.ml.pred[i]
      if (Number.isFinite(v)) pts.push({ time: dataset.time[i], value: v })
    }
    line.setData(pts)
    overlayRef.current = line
  }, [dataset])

  // Clicking a blotter row pans here.
  useEffect(() => {
    if (!selectedTrade || !chartRef.current) return
    const pad = Math.max(20, (selectedTrade.exitIdx - selectedTrade.entryIdx) * 4)
    chartRef.current.timeScale().setVisibleLogicalRange({
      from: selectedTrade.entryIdx - pad,
      to: selectedTrade.exitIdx + pad,
    })
  }, [selectedTrade])

  return (
    <Panel
      label={dataset ? `price · ${dataset.symbol} ${dataset.interval}` : 'price'}
      right={
        result ? (
          <span className="text-dim">
            {result.trades.length} trades
            {dataset?.ml && <span className="ml-2 text-violet">· rf pred</span>}
          </span>
        ) : null
      }
      className="h-full"
      scroll={false}
      delay={0.04}
    >
      {/* The container is always mounted: swapping it out for a loading state
          would leave the chart's one-shot init effect with a null ref. */}
      <div className="relative h-full w-full">
        <div ref={containerRef} className="h-full w-full" />
        {datasetLoading && !dataset && (
          <div className="absolute inset-0 bg-panel">
            <EmptyState>Loading bars…</EmptyState>
          </div>
        )}
      </div>
    </Panel>
  )
}
