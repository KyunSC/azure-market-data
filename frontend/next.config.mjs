/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_URL || 'https://azure-market-data-1.onrender.com'

const nextConfig = {
  async rewrites() {
    return [
      // Match subpaths too (e.g. /api/market/live, /api/historical/since).
      { source: '/api/market/:path+', destination: `${apiUrl}/api/market/:path+` },
      { source: '/api/market', destination: `${apiUrl}/api/market` },
      { source: '/api/historical/:path+', destination: `${apiUrl}/api/historical/:path+` },
      { source: '/api/historical', destination: `${apiUrl}/api/historical` },
      { source: '/api/gamma', destination: `${apiUrl}/api/gamma` },
    ]
  },
}

export default nextConfig
