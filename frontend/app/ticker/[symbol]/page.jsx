'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import CandlestickChart from '../../../components/CandlestickChart'
import TimeframeSelector from '../../../components/TimeframeSelector'
import SettingsPopup from '../../../components/SettingsPopup'
import IndicatorSelector from '../../../components/IndicatorSelector'
import DrawingSelector from '../../../components/DrawingSelector'
import ChartTypeSelector from '../../../components/ChartTypeSelector'
import { DEFAULT_CHART_COLORS, CHART_COLORS_STORAGE_KEY } from '../../../components/chartDefaults'
import { INDICATORS_STORAGE_KEY } from '../../../components/indicators'

export default function TickerDetail({ params }) {
  const { symbol: rawSymbol } = use(params)
  const symbol = decodeURIComponent(rawSymbol)
  const router = useRouter()

  const DISPLAY_NAMES = {
    'ES=F': '/ES',
    'NQ=F': '/NQ',
  }
  const displayName = DISPLAY_NAMES[symbol] || symbol
  const [ohlcData, setOhlcData] = useState([])
  const [period, setPeriod] = useState('5d')
  const [interval, setInterval] = useState('5m')
  const [tickBars, setTickBars] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeIndicators, setActiveIndicators] = useState([])
  const [upColor, setUpColor] = useState(DEFAULT_CHART_COLORS.upColor)
  const [downColor, setDownColor] = useState(DEFAULT_CHART_COLORS.downColor)
  const [bgColor, setBgColor] = useState(DEFAULT_CHART_COLORS.bgColor)
  const [borderUpColor, setBorderUpColor] = useState(DEFAULT_CHART_COLORS.borderUpColor)
  const [borderDownColor, setBorderDownColor] = useState(DEFAULT_CHART_COLORS.borderDownColor)
  const [gexLevels, setGexLevels] = useState(null)
  const [chartType, setChartType] = useState('candlestick')
  const [drawingTool, setDrawingTool] = useState(null)
  const [drawings, setDrawings] = useState([])

  // Hydrate from localStorage after mount to avoid SSR/client mismatch
  useEffect(() => {
    try {
      const savedIndicators = JSON.parse(localStorage.getItem(INDICATORS_STORAGE_KEY))
      if (savedIndicators) setActiveIndicators(savedIndicators)
    } catch { /* ignore */ }
    try {
      const savedColors = JSON.parse(localStorage.getItem(CHART_COLORS_STORAGE_KEY))
      if (savedColors?.upColor) setUpColor(savedColors.upColor)
      if (savedColors?.downColor) setDownColor(savedColors.downColor)
      if (savedColors?.bgColor) setBgColor(savedColors.bgColor)
      if (savedColors?.borderUpColor !== undefined) setBorderUpColor(savedColors.borderUpColor)
      if (savedColors?.borderDownColor !== undefined) setBorderDownColor(savedColors.borderDownColor)
    } catch { /* ignore */ }
  }, [])

  // Fetch GEX data for futures charts (NQ=F uses QQQ, ES=F uses SPY)
  const GEX_ETF_MAP = { 'NQ=F': 'QQQ', 'ES=F': 'SPY' }
  useEffect(() => {
    const etfSymbol = GEX_ETF_MAP[symbol]
    if (!etfSymbol) return

    const fetchGex = async () => {
      try {
        const res = await fetch(`/api/gamma?symbol=${etfSymbol}`)
        if (res.ok) {
          const data = await res.json()
          console.log('GEX Levels:', data)
          setGexLevels(data)
        }
      } catch (err) {
        console.error('GEX fetch error:', err)
      }
    }

    fetchGex()
    const gexInterval = window.setInterval(fetchGex, 15 * 60 * 1000)
    return () => window.clearInterval(gexInterval)
  }, [symbol])

  // Aggregate N consecutive bars into one tick bar
  function aggregateToTickBars(data, n) {
    const result = []
    for (let i = 0; i < data.length; i += n) {
      const group = data.slice(i, i + n)
      if (!group.length) continue
      result.push({
        time: group[0].time,
        open: group[0].open,
        high: group.reduce((m, d) => Math.max(m, Number(d.high)), -Infinity),
        low: group.reduce((m, d) => Math.min(m, Number(d.low)), Infinity),
        close: group[group.length - 1].close,
        volume: group.reduce((s, d) => s + Number(d.volume), 0),
      })
    }
    return result
  }

  // When tick bars mode is toggled on, switch to 1m interval
  const handleTickBarsChange = (n) => {
    setTickBars(n)
    if (n !== null) {
      setInterval('1m')
      if (!['1d', '5d'].includes(period)) setPeriod('5d')
    }
  }

  useEffect(() => {
    const fetchOHLCData = async () => {
      setLoading(true)
      setError(null)

      // Tick bars always uses 1m base data
      const fetchInterval = tickBars ? '1m' : interval

      try {
        const response = await fetch(
          `/api/historical?symbol=${symbol}&period=${period}&interval=${fetchInterval}`
        )

        if (!response.ok) {
          const suffix = response.status >= 500 ? ' (API)' : ''
          let errorMessage = `HTTP ${response.status}${suffix}`
          try {
            const errorData = await response.json()
            errorMessage = errorData.error || errorMessage
          } catch {
            // Response wasn't JSON
          }
          throw new Error(errorMessage)
        }

        const result = await response.json()
        setOhlcData(result.data)
      } catch (err) {
        setError(err.message)
        setOhlcData([])
      } finally {
        setLoading(false)
      }
    }

    fetchOHLCData()
  }, [symbol, period, interval, tickBars])

  useEffect(() => {
    localStorage.setItem(CHART_COLORS_STORAGE_KEY, JSON.stringify({ upColor, downColor, bgColor, borderUpColor, borderDownColor }))
  }, [upColor, downColor, bgColor, borderUpColor, borderDownColor])

  const handleResetColors = () => {
    setUpColor(DEFAULT_CHART_COLORS.upColor)
    setDownColor(DEFAULT_CHART_COLORS.downColor)
    setBgColor(DEFAULT_CHART_COLORS.bgColor)
    setBorderUpColor(DEFAULT_CHART_COLORS.borderUpColor)
    setBorderDownColor(DEFAULT_CHART_COLORS.borderDownColor)
  }

  const handleToggleIndicator = (id) => {
    setActiveIndicators(prev => {
      const next = prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
      localStorage.setItem(INDICATORS_STORAGE_KEY, JSON.stringify(next))
      return next
    })
  }

  return (
    <div className="app">
      <div className="ticker-detail">
        <button className="back-button" onClick={() => router.push('/')}>
          ← Back to Dashboard
        </button>

        <div className="ticker-header">
          <h1 className="symbol">{displayName}</h1>
          <IndicatorSelector
            activeIndicators={activeIndicators}
            onToggle={handleToggleIndicator}
          />
          <DrawingSelector
            activeTool={drawingTool}
            onSelectTool={setDrawingTool}
            onClearAll={() => setDrawings([])}
            drawingCount={drawings.length}
          />
          <ChartTypeSelector chartType={chartType} onSelect={setChartType} />
          <button className="settings-button" onClick={() => setSettingsOpen(prev => !prev)}>
            ⚙
          </button>
        </div>

        {settingsOpen && (
          <SettingsPopup
            upColor={upColor}
            downColor={downColor}
            bgColor={bgColor}
            borderUpColor={borderUpColor}
            borderDownColor={borderDownColor}
            onUpColorChange={setUpColor}
            onDownColorChange={setDownColor}
            onBgColorChange={setBgColor}
            onBorderUpColorChange={setBorderUpColor}
            onBorderDownColorChange={setBorderDownColor}
            onClose={() => setSettingsOpen(false)}
            onReset={handleResetColors}
          />
        )}

        <TimeframeSelector
          period={period}
          interval={interval}
          onPeriodChange={setPeriod}
          onIntervalChange={setInterval}
          tickBars={tickBars}
          onTickBarsChange={handleTickBarsChange}
        />

        {gexLevels && !gexLevels.marketOpen && (
          <p className="status" style={{ color: '#ffeb3b', fontSize: '0.85rem' }}>GEX data from last close</p>
        )}

        {loading && <p className="status">Loading chart...</p>}
        {error && <p className="status error">Error: {error}</p>}
        {!loading && !error && ohlcData.length > 0 && (
          <CandlestickChart data={tickBars ? aggregateToTickBars(ohlcData, tickBars) : ohlcData} symbol={symbol} upColor={upColor} downColor={downColor} bgColor={bgColor} borderUpColor={borderUpColor} borderDownColor={borderDownColor} activeIndicators={activeIndicators} gexLevels={gexLevels} chartType={chartType} drawingTool={drawingTool} drawings={drawings} onDrawingComplete={(d) => { setDrawings(prev => [...prev, d]); setDrawingTool(null) }} onDrawingUpdate={(idx, updated) => { setDrawings(prev => updated === null ? prev.filter((_, i) => i !== idx) : prev.map((d, i) => i === idx ? updated : d)) }} />
        )}
        {!loading && !error && ohlcData.length === 0 && (
          <p className="status">No data available for this timeframe</p>
        )}
      </div>
    </div>
  )
}
