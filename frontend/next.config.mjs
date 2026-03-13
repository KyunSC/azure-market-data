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
      {
        source: '/api/gamma',
        destination: 'http://localhost:8080/api/gamma',
      },
    ]
  },
}

export default nextConfig
