'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import CandlestickChart from '../../../components/CandlestickChart'
import TimeframeSelector from '../../../components/TimeframeSelector'
import SettingsPopup from '../../../components/SettingsPopup'
import { DEFAULT_CHART_COLORS, CHART_COLORS_STORAGE_KEY } from '../../../components/chartDefaults'

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
  const [upColor, setUpColor] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_CHART_COLORS.upColor
    try {
      const saved = JSON.parse(localStorage.getItem(CHART_COLORS_STORAGE_KEY))
      return saved?.upColor || DEFAULT_CHART_COLORS.upColor
    } catch { return DEFAULT_CHART_COLORS.upColor }
  })
  const [downColor, setDownColor] = useState(() => {
    if (typeof window === 'undefined') return DEFAULT_CHART_COLORS.downColor
    try {
      const saved = JSON.parse(localStorage.getItem(CHART_COLORS_STORAGE_KEY))
      return saved?.downColor || DEFAULT_CHART_COLORS.downColor
    } catch { return DEFAULT_CHART_COLORS.downColor }
  })

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

  return (
    <div className="app">
      <div className="ticker-detail">
        <button className="back-button" onClick={() => router.push('/')}>
          ← Back to Dashboard
        </button>

        <div className="ticker-header">
          <h1 className="symbol">{displayName}</h1>
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

        {loading && <p className="status">Loading chart...</p>}
        {error && <p className="status error">Error: {error}</p>}
        {!loading && !error && ohlcData.length > 0 && (
          <CandlestickChart data={ohlcData} symbol={symbol} upColor={upColor} downColor={downColor} />
        )}
        {!loading && !error && ohlcData.length === 0 && (
          <p className="status">No data available for this timeframe</p>
        )}
      </div>
    </div>
  )
}
