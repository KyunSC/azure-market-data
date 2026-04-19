'use client'

import { useState, useEffect, use } from 'react'
import { useRouter } from 'next/navigation'
import CandlestickChart from '../../../components/CandlestickChart'
import TimeframeSelector from '../../../components/TimeframeSelector'
import SettingsPopup from '../../../components/SettingsPopup'
import IndicatorSelector from '../../../components/IndicatorSelector'
import DrawingSelector from '../../../components/DrawingSelector'
import ChartTypeSelector from '../../../components/ChartTypeSelector'
import { DEFAULT_CHART_COLORS, CHART_COLORS_STORAGE_KEY, DEFAULT_TIMEZONE, TIMEZONE_STORAGE_KEY } from '../../../components/chartDefaults'
import { INDICATORS_STORAGE_KEY } from '../../../components/indicators'

export default function TickerDetail({ params }) {
  const { symbol: rawSymbol } = use(params)
  const symbol = decodeURIComponent(rawSymbol)
  const router = useRouter()

  const DISPLAY_NAMES = {
    'ES=F': '/ES',
    'NQ=F': '/NQ',
    '^VIX': 'VIX',
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
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE)
  const [livePrice, setLivePrice] = useState(null)

  // Hydrate from localStorage after mount to avoid SSR/client mismatch
  useEffect(() => {
    try {
      const savedIndicators = JSON.parse(localStorage.getItem(INDICATORS_STORAGE_KEY))
      if (savedIndicators) setActiveIndicators(savedIndicators)
    } catch { /* ignore */ }
    try {
      const savedTz = localStorage.getItem(TIMEZONE_STORAGE_KEY)
      if (savedTz) setTimezone(savedTz)
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

    const fetchGex = async ({ skipIfHidden = true } = {}) => {
      if (skipIfHidden && document.hidden) return
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

    fetchGex({ skipIfHidden: false })
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

  // Live tick poller. Hits /api/market/live, which calls yfinance via the
  // Azure Function and never reads Supabase. Cached ~3s on the backend so
  // many viewers share a single upstream call per TTL. The returned price
  // is merged into the developing bar inside CandlestickChart via
  // mainSeries.update() — no setData, no indicator recompute.
  useEffect(() => {
    setLivePrice(null)
    let cancelled = false

    const fetchLive = async () => {
      if (document.hidden) return
      try {
        const res = await fetch(`/api/market/live?symbol=${encodeURIComponent(symbol)}`)
        if (!res.ok) return
        const body = await res.json()
        const price = body?.tickers?.[0]?.price
        if (!cancelled && typeof price === 'number' && Number.isFinite(price)) {
          setLivePrice(price)
        }
      } catch { /* network hiccup — next tick will retry */ }
    }

    fetchLive()
    const timer = window.setInterval(fetchLive, 3000)
    const onVisible = () => { if (!document.hidden) fetchLive() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [symbol])

  useEffect(() => {
    let isInitial = true
    let lastBars = []
    // Echoed back to the server on each /since poll so it can short-circuit
    // when ingestion hasn't written anything new — that turns a fast poll
    // loop into a sequence of empty cache-hit responses with zero Supabase
    // egress, while still showing fresh data the moment ingestion runs.
    let lastFetched = null

    // Intraday bars use epoch-seconds strings; daily/weekly use YYYY-MM-DD.
    // Incremental polling is only worthwhile for intraday — daily series are
    // tiny and the backend's long cache already absorbs repeated full fetches.
    const INCREMENTAL_INTERVALS = new Set(['1m', '5m', '15m', '30m', '1h', '4h'])
    const fetchInterval = tickBars ? '1m' : interval
    const canIncremental = INCREMENTAL_INTERVALS.has(fetchInterval)

    const parseError = async (response) => {
      const suffix = response.status >= 500 ? ' (API)' : ''
      let errorMessage = `HTTP ${response.status}${suffix}`
      try {
        const errorData = await response.json()
        errorMessage = errorData.error || errorMessage
      } catch { /* not JSON */ }
      return errorMessage
    }

    const fetchFull = async () => {
      const response = await fetch(
        `/api/historical?symbol=${symbol}&period=${period}&interval=${fetchInterval}`
      )
      if (!response.ok) throw new Error(await parseError(response))
      const result = await response.json()
      lastBars = result.data
      lastFetched = result.lastFetched ?? lastFetched
      setOhlcData(result.data)
    }

    const fetchIncremental = async () => {
      if (!lastBars.length) return fetchFull()
      const lastTime = Number(lastBars[lastBars.length - 1].time)
      if (!Number.isFinite(lastTime)) return fetchFull()

      const url = new URL('/api/historical/since', window.location.origin)
      url.searchParams.set('symbol', symbol)
      url.searchParams.set('interval', fetchInterval)
      url.searchParams.set('since', String(lastTime))
      if (lastFetched != null) url.searchParams.set('lastFetched', String(lastFetched))

      const response = await fetch(url.toString())
      if (!response.ok) throw new Error(await parseError(response))
      const result = await response.json()
      // Track the server's view of the latest ingestion timestamp regardless
      // of whether new bars came back — empty responses still advance it as
      // ingestion's MAX(fetched_at) cache refreshes.
      if (result.lastFetched != null) lastFetched = result.lastFetched
      const newBars = result.data || []
      if (!newBars.length) return

      // Replace any existing bars at-or-after the first returned bar (the
      // last known bucket may still be developing), then append the rest.
      const firstNew = Number(newBars[0].time)
      const merged = lastBars.filter(b => Number(b.time) < firstNew).concat(newBars)
      lastBars = merged
      setOhlcData(merged)
    }

    const fetchOHLCData = async () => {
      // Skip polls while the tab is hidden — the user can't see them anyway,
      // and each skipped poll avoids a Supabase read.
      if (!isInitial && typeof document !== 'undefined' && document.hidden) return

      if (isInitial) {
        setLoading(true)
        setError(null)
      }
      try {
        if (isInitial || !canIncremental) {
          await fetchFull()
        } else {
          await fetchIncremental()
        }
        if (!isInitial) setError(null)
      } catch (err) {
        if (isInitial) {
          setError(err.message)
          setOhlcData([])
          lastBars = []
        }
      } finally {
        if (isInitial) setLoading(false)
        isInitial = false
      }
    }

    // The /since endpoint echoes back the server's latest ingestion timestamp
    // as `lastFetched`; subsequent polls send it back, and the server returns
    // an empty body without touching Supabase whenever ingestion hasn't moved
    // on. That makes a tight poll loop essentially free, so we can keep the
    // candle visually responsive without burning egress.
    const POLL_MS = {
      '1m': 5_000,
      '5m': 10_000,
      '15m': 15_000,
      '30m': 15_000,
      '1h': 30_000,
      '4h': 30_000,
    }
    const pollInterval = POLL_MS[fetchInterval] || 60_000

    fetchOHLCData()
    const timer = window.setInterval(fetchOHLCData, pollInterval)
    // Refresh immediately on tab re-focus so users see fresh data without waiting a full poll cycle.
    const onVisible = () => { if (!document.hidden) fetchOHLCData() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [symbol, period, interval, tickBars])

  useEffect(() => {
    localStorage.setItem(CHART_COLORS_STORAGE_KEY, JSON.stringify({ upColor, downColor, bgColor, borderUpColor, borderDownColor }))
  }, [upColor, downColor, bgColor, borderUpColor, borderDownColor])

  const handleTimezoneChange = (tz) => {
    setTimezone(tz)
    localStorage.setItem(TIMEZONE_STORAGE_KEY, tz)
  }

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
            timezone={timezone}
            onTimezoneChange={handleTimezoneChange}
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
          <CandlestickChart data={tickBars ? aggregateToTickBars(ohlcData, tickBars) : ohlcData} symbol={symbol} upColor={upColor} downColor={downColor} bgColor={bgColor} borderUpColor={borderUpColor} borderDownColor={borderDownColor} activeIndicators={activeIndicators} gexLevels={gexLevels} chartType={chartType} drawingTool={drawingTool} drawings={drawings} onDrawingComplete={(d) => { setDrawings(prev => [...prev, d]); setDrawingTool(null) }} onDrawingUpdate={(idx, updated) => { setDrawings(prev => updated === null ? prev.filter((_, i) => i !== idx) : prev.map((d, i) => i === idx ? updated : d)) }} timezone={timezone} livePrice={livePrice} />
        )}
        {!loading && !error && ohlcData.length === 0 && (
          <p className="status">No data available for this timeframe</p>
        )}
      </div>
    </div>
  )
}
