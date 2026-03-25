/** @type {import('next').NextConfig} */
const apiUrl = process.env.API_URL || 'http://localhost:8080'

const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/market',
        destination: `${apiUrl}/api/market`,
      },
      {
        source: '/api/historical',
        destination: `${apiUrl}/api/historical`,
      },
      {
        source: '/api/gamma',
        destination: `${apiUrl}/api/gamma`,
      },
    ]
  },
}

export default nextConfig
