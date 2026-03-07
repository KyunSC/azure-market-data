/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/api/historical',
        destination: 'http://localhost:8080/api/historical',
      },
      {
        source: '/api/market',
        destination: 'http://localhost:8080/api/market',
      },
      {
        source: '/api/:path*',
        destination: 'http://localhost:7071/api/:path*',
      },
    ]
  },
}

export default nextConfig
