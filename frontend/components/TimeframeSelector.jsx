export default function TimeframeSelector({ period, interval, onPeriodChange, onIntervalChange }) {
  const periods = ['1d', '5d', '10d', '14d', '1mo', '3mo', '6mo', '1y', '2y', 'max']
  const intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1wk']

  // Valid periods for each interval (based on available seeded data)
  const validPeriods = {
    '1m':  ['1d', '5d'],
    '5m':  ['1d', '5d', '10d', '14d', '1mo', '3mo'],
    '15m': ['1d', '5d', '10d', '14d', '1mo', '3mo'],
    '30m': ['1d', '5d', '10d', '14d', '1mo', '3mo'],
    '1h':  ['1d', '5d', '10d', '14d', '1mo', '3mo', '6mo', '1y', '2y'],
    '4h':  ['1d', '5d', '10d', '14d', '1mo', '3mo', '6mo', '1y', '2y'],
    '1d':  ['1d', '5d', '10d', '14d', '1mo', '3mo', '6mo', '1y', '2y', 'max'],
    '1wk': ['1mo', '3mo', '6mo', '1y', '2y', 'max'],
  }

  // Valid intervals for each period (inverse of above)
  const validIntervals = {}
  for (const p of periods) {
    validIntervals[p] = intervals.filter(i => validPeriods[i]?.includes(p))
  }

  const isPeriodDisabled = (p) => !validPeriods[interval]?.includes(p)
  const isIntervalDisabled = (i) => !validIntervals[period]?.includes(i)

  return (
    <div className="timeframe-selector">
      <div className="selector-group">
        <label>Period:</label>
        {periods.map(p => (
          <button
            key={p}
            className={`${period === p ? 'active' : ''} ${isPeriodDisabled(p) ? 'disabled' : ''}`}
            disabled={isPeriodDisabled(p)}
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
            className={`${interval === i ? 'active' : ''} ${isIntervalDisabled(i) ? 'disabled' : ''}`}
            disabled={isIntervalDisabled(i)}
            onClick={() => onIntervalChange(i)}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  )
}
