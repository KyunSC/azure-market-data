import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import CandlestickChart from './CandlestickChart'
import TimeframeSelector from './TimeframeSelector'

function TickerDetail() {
  const { symbol } = useParams()
  const navigate = useNavigate()
  const [ohlcData, setOhlcData] = useState([])
  const [period, setPeriod] = useState('1mo')
  const [interval, setInterval] = useState('1d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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
            // Response wasn't JSON (e.g., proxy error)
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

  return (
    <div className="app">
      <div className="ticker-detail">
        <button className="back-button" onClick={() => navigate('/')}>
          ← Back to Dashboard
        </button>

        <h1 className="symbol">{symbol}</h1>

        <TimeframeSelector
          period={period}
          interval={interval}
          onPeriodChange={setPeriod}
          onIntervalChange={setInterval}
        />

        {loading && <p className="status">Loading chart...</p>}
        {error && <p className="status error">Error: {error}</p>}
        {!loading && !error && ohlcData.length > 0 && (
          <CandlestickChart data={ohlcData} symbol={symbol} />
        )}
        {!loading && !error && ohlcData.length === 0 && (
          <p className="status">No data available for this timeframe</p>
        )}
      </div>
    </div>
  )
}

export default TickerDetail
