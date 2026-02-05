import { useState, useEffect } from 'react'
import { Routes, Route } from 'react-router-dom'
import Dashboard from './components/Dashboard'
import TickerDetail from './components/TickerDetail'

const DEFAULT_TICKERS = ['ES=F', 'NQ=F']
const REFRESH_INTERVAL = 15000

function App() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)

  const fetchData = async () => {
    try {
      const tickerParam = DEFAULT_TICKERS.join(',')
      const response = await fetch(`/api/market?tickers=${tickerParam}`)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      const result = await response.json()
      setData(result)
      setLastUpdated(new Date())
      setError(null)
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, REFRESH_INTERVAL)
    return () => clearInterval(interval)
  }, [])

  return (
    <Routes>
      <Route path="/" element={
        <div className="app">
          <header className="header">
            <h1>Market Data Dashboard</h1>
            {lastUpdated && (
              <p className="last-updated">
                Last updated: {lastUpdated.toLocaleTimeString()}
              </p>
            )}
          </header>

          {loading && <p className="status">Loading...</p>}
          {error && <p className="status error">Error: {error}</p>}
          {data && <Dashboard tickers={data.tickers} />}
        </div>
      } />
      <Route path="/ticker/:symbol" element={<TickerDetail />} />
    </Routes>
  )
}

export default App
