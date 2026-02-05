import TickerCard from './TickerCard'

function Dashboard({ tickers }) {
  if (!tickers || tickers.length === 0) {
    return <p className="status">No ticker data available</p>
  }

  return (
    <div className="dashboard">
      {tickers.map((ticker) => (
        <TickerCard key={ticker.symbol} ticker={ticker} />
      ))}
    </div>
  )
}

export default Dashboard
