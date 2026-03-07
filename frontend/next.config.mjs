/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/market',
        destination: 'http://localhost:7071/api/MarketDataFunction',
      },
      {
        source: '/api/historical',
        destination: 'http://localhost:7071/api/HistoricalDataFunction',
      },
    ]
  },
}

export default nextConfig
