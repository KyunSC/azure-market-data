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
  const [period, setPeriod] = useState('1mo')
  const [interval, setInterval] = useState('1d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [activeIndicators, setActiveIndicators] = useState([])
  const [upColor, setUpColor] = useState(DEFAULT_CHART_COLORS.upColor)
  const [downColor, setDownColor] = useState(DEFAULT_CHART_COLORS.downColor)
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
    } catch { /* ignore */ }
  }, [])

  // Fetch GEX data for NQ chart
  useEffect(() => {
    if (symbol !== 'NQ=F') return

    const fetchGex = async () => {
      try {
        const res = await fetch('/api/gamma?symbol=QQQ')
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

  useEffect(() => {
    const fetchOHLCData = async () => {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch(
          `/api/historical?symbol=${symbol}&period=${period}&interval=${interval}`
        )

        if (!response.ok) {
          let errorMessage = `HTTP ${response.status}`
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
  }, [symbol, period, interval])

  useEffect(() => {
    localStorage.setItem(CHART_COLORS_STORAGE_KEY, JSON.stringify({ upColor, downColor }))
  }, [upColor, downColor])

  const handleResetColors = () => {
    setUpColor(DEFAULT_CHART_COLORS.upColor)
    setDownColor(DEFAULT_CHART_COLORS.downColor)
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
            onUpColorChange={setUpColor}
            onDownColorChange={setDownColor}
            onClose={() => setSettingsOpen(false)}
            onReset={handleResetColors}
          />
        )}

        <TimeframeSelector
          period={period}
          interval={interval}
          onPeriodChange={setPeriod}
          onIntervalChange={setInterval}
        />

        {gexLevels && !gexLevels.marketOpen && (
          <p className="status" style={{ color: '#ffeb3b', fontSize: '0.85rem' }}>GEX data from last close</p>
        )}

        {loading && <p className="status">Loading chart...</p>}
        {error && <p className="status error">Error: {error}</p>}
        {!loading && !error && ohlcData.length > 0 && (
          <CandlestickChart data={ohlcData} symbol={symbol} upColor={upColor} downColor={downColor} activeIndicators={activeIndicators} gexLevels={gexLevels} chartType={chartType} drawingTool={drawingTool} drawings={drawings} onDrawingComplete={(d) => { setDrawings(prev => [...prev, d]); setDrawingTool(null) }} />
        )}
        {!loading && !error && ohlcData.length === 0 && (
          <p className="status">No data available for this timeframe</p>
        )}
      </div>
    </div>
  )
}
