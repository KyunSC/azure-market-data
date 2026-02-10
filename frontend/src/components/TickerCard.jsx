import { useNavigate } from 'react-router-dom'

const DISPLAY_NAMES = {
  'ES=F': '/ES',
  'NQ=F': '/NQ',
}

function TickerCard({ ticker }) {
  const navigate = useNavigate()
  const hasError = ticker.error || ticker.price_error
  const displayName = DISPLAY_NAMES[ticker.symbol] || ticker.symbol

  const handleClick = () => {
    navigate(`/ticker/${ticker.symbol}`)
  }

  return (
    <div className={`ticker-card ${hasError ? 'error' : ''}`} onClick={handleClick}>
      <h2 className="symbol">{displayName}</h2>

      {ticker.price !== null ? (
        <p className="price">${ticker.price.toFixed(2)}</p>
      ) : (
        <p className="price unavailable">--</p>
      )}

      {ticker.volume !== null && (
        <p className="volume">Vol: {ticker.volume.toLocaleString()}</p>
      )}

      {hasError && (
        <p className="error-msg">{ticker.error || ticker.price_error}</p>
      )}
    </div>
  )
}

export default TickerCard
