const serviceHost = process.env.MIROSHARK_SERVICE_HOST || 'http://127.0.0.1'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  async rewrites() {
    return [
      {
        source: '/backend/:path*',
        destination: `${serviceHost}:5001/:path*`,
      },
      {
        source: '/signal/:path*',
        destination: `${serviceHost}:5002/:path*`,
      },
      {
        source: '/execution/:path*',
        destination: `${serviceHost}:5004/:path*`,
      },
    ]
  },
}

export default nextConfig
