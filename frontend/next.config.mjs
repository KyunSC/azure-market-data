/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/market',
        destination: 'http://localhost:8080/api/market',
      },
      {
        source: '/api/historical',
        destination: 'http://localhost:8080/api/historical',
      },
    ]
  },
}

export default nextConfig
