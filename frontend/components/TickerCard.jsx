'use client'

import { useRouter } from 'next/navigation'

const DISPLAY_NAMES = {
  'ES=F': '/ES',
  'NQ=F': '/NQ',
  '^VIX': 'VIX',
}

const PRICE_PREFIX = {
  '^VIX': '',
}

export default function TickerCard({ ticker }) {
  const router = useRouter()
  const hasError = ticker.error || ticker.price_error
  const displayName = DISPLAY_NAMES[ticker.symbol] || ticker.symbol
  const pricePrefix = ticker.symbol in PRICE_PREFIX ? PRICE_PREFIX[ticker.symbol] : '$'

  const handleClick = () => {
    router.push(`/ticker/${ticker.symbol}`)
  }

  const change =
    ticker.price !== null && ticker.previousClose
      ? ticker.price - ticker.previousClose
      : null
  const changePercent = change !== null ? (change / ticker.previousClose) * 100 : null
  const changeClass = change === null ? '' : change >= 0 ? 'positive' : 'negative'
  const changeSign = change !== null && change >= 0 ? '+' : ''

  return (
    <div className={`ticker-card ${hasError ? 'error' : ''}`} onClick={handleClick}>
      <h2 className="symbol">{displayName}</h2>

      {ticker.price !== null ? (
        <p className="price">{pricePrefix}{ticker.price.toFixed(2)}</p>
      ) : (
        <p className="price unavailable">--</p>
      )}

      {change !== null && (
        <p className={`change ${changeClass}`}>
          {changeSign}{change.toFixed(2)} ({changeSign}{changePercent.toFixed(2)}%)
        </p>
      )}

      {ticker.volume !== null && ticker.volume > 0 && (
        <p className="volume">Vol: {ticker.volume.toLocaleString()}</p>
      )}

      {hasError && (
        <p className="error-msg">{ticker.error || ticker.price_error}</p>
      )}
    </div>
  )
}
