'use client'

import { useState, useEffect, useRef } from 'react'
import Dashboard from '../components/Dashboard'

const DEFAULT_TICKERS = ['ES=F', 'NQ=F', 'SPY', 'QQQ', '^VIX']
const REFRESH_INTERVAL = 15000
// Retry delays on 5xx (covers Render free-tier cold boots ~30-60s)
const RETRY_DELAYS = [5000, 10000, 20000]

const MARKET_CACHE_PREFIX = 'marketDataCache:'
// Prices older than this are too stale to flash on screen; better to show the
// skeleton and wait for fresh data.
const MARKET_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000

const readMarketCache = (key) => {
  try {
    const raw = localStorage.getItem(MARKET_CACHE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || !parsed.payload) return null
    if (Date.now() - (parsed.savedAt || 0) > MARKET_CACHE_MAX_AGE_MS) return null
    return parsed
  } catch { return null }
}

const writeMarketCache = (key, payload) => {
  try {
    localStorage.setItem(MARKET_CACHE_PREFIX + key, JSON.stringify({
      payload,
      savedAt: Date.now(),
    }))
  } catch { /* quota exceeded — ignore */ }
}

function SkeletonCard() {
  return (
    <div className="skeleton-card-shell">
      <div className="skeleton" style={{ width: '55%', height: '1.4rem' }} />
      <div className="skeleton" style={{ width: '75%', height: '2rem' }} />
      <div className="skeleton" style={{ width: '65%', height: '1rem' }} />
      <div className="skeleton" style={{ width: '50%', height: '0.9rem' }} />
    </div>
  )
}

export default function Home() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [warmingUp, setWarmingUp] = useState(false)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const isInitialRef = useRef(true)
  const inflightRef = useRef(false)

  const fetchData = async ({ skipIfHidden = true } = {}) => {
    if (skipIfHidden && typeof document !== 'undefined' && document.hidden) return
    if (inflightRef.current) return
    inflightRef.current = true

    const isInitial = isInitialRef.current

    try {
      const tickerParam = DEFAULT_TICKERS.join(',')
      let response
      let lastErr

      if (isInitial) {
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
          try {
            response = await fetch(`/api/market?tickers=${tickerParam}`)
            if (response.ok || response.status < 500) break
          } catch (e) {
            lastErr = e
            response = undefined
          }
          if (attempt < RETRY_DELAYS.length) {
            setWarmingUp(true)
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
          }
        }
        if (!response) throw lastErr || new Error('Network error')
      } else {
        response = await fetch(`/api/market?tickers=${tickerParam}`)
      }

      if (!response.ok) {
        const suffix = response.status >= 500 ? ' (API)' : ''
        throw new Error(`HTTP ${response.status}${suffix}`)
      }

      const result = await response.json()
      setData(result)
      setLastUpdated(new Date())
      setError(null)
      setWarmingUp(false)
      writeMarketCache(tickerParam, result)
    } catch (err) {
      if (isInitial) setError(err.message)
      // subsequent poll failures are silent — keep showing last known data
    } finally {
      if (isInitial) {
        setLoading(false)
        setWarmingUp(false)
        isInitialRef.current = false
      }
      inflightRef.current = false
    }
  }

  useEffect(() => {
    // Seed from localStorage so cards render instantly on a fresh visit while
    // the background fetch refreshes them. Treats the next fetch as a quiet
    // background refresh rather than an initial load.
    const tickerParam = DEFAULT_TICKERS.join(',')
    const cached = readMarketCache(tickerParam)
    if (cached) {
      setData(cached.payload)
      setLastUpdated(new Date(cached.savedAt))
      setLoading(false)
      isInitialRef.current = false
    }

    fetchData({ skipIfHidden: false })
    const interval = setInterval(fetchData, REFRESH_INTERVAL)
    const onVisible = () => { if (!document.hidden) fetchData({ skipIfHidden: false }) }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  const showSkeleton = loading || warmingUp

  return (
    <div className="app">
      <header className="header">
        <h1>Market Data Dashboard</h1>
        {warmingUp && <p className="warming-up">Warming up server...</p>}
        {lastUpdated && !warmingUp && (
          <p className="last-updated">
            Last updated: {lastUpdated.toLocaleTimeString()}
          </p>
        )}
      </header>

      {showSkeleton && (
        <div className="dashboard">
          {DEFAULT_TICKERS.map(t => <SkeletonCard key={t} />)}
        </div>
      )}
      {!showSkeleton && error && !data && (
        <p className="status error">
          {error.includes('(API)')
            ? 'Server is warming up — retrying automatically...'
            : `Error: ${error}`}
        </p>
      )}
      {!showSkeleton && data && <Dashboard tickers={data.tickers} />}
    </div>
  )
}
