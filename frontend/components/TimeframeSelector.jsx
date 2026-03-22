export default function TimeframeSelector({ period, interval, onPeriodChange, onIntervalChange }) {
  const periods = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', 'max']
  const intervals = ['1m', '5m', '15m', '1h', '4h', '1d', '1wk']

  return (
    <div className="timeframe-selector">
      <div className="selector-group">
        <label>Period:</label>
        {periods.map(p => (
          <button
            key={p}
            className={period === p ? 'active' : ''}
            onClick={() => onPeriodChange(p)}
          >
            {p}
          </button>
        ))}
      </div>
      <div className="selector-group">
        <label>Interval:</label>
        {intervals.map(i => (
          <button
            key={i}
            className={interval === i ? 'active' : ''}
            onClick={() => onIntervalChange(i)}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  )
}
