import TickerCard from './TickerCard'

export default function Dashboard({ groups }) {
  if (!groups || groups.length === 0) {
    return <p className="status">No ticker data available</p>
  }

  return (
    <>
      {groups.map((group) => (
        <section key={group.title} className="dashboard-section">
          <h2 className="dashboard-section-title">{group.title}</h2>
          {group.tickers.length === 0 ? (
            <p className="status">No ticker data available</p>
          ) : (
            <div className="dashboard">
              {group.tickers.map((ticker) => (
                <TickerCard key={ticker.symbol} ticker={ticker} />
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  )
}
