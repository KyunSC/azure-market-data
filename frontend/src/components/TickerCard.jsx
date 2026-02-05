function TickerCard({ ticker }) {
  const hasError = ticker.error || ticker.price_error

  return (
    <div className={`ticker-card ${hasError ? 'error' : ''}`}>
      <h2 className="symbol">{ticker.symbol}</h2>

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
