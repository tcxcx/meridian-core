import path from 'node:path'
import dotenv from 'dotenv'

const appDir = process.cwd()
const workspaceRoot = path.resolve(appDir, '../..')
const skipAppLocalEnv = process.env.MIROSHARK_SKIP_APP_LOCAL_ENV === '1'

dotenv.config({ path: path.join(workspaceRoot, '.env') })
dotenv.config({ path: path.join(workspaceRoot, '.env.local') })
if (!skipAppLocalEnv) {
  dotenv.config({ path: path.join(appDir, '.env.local'), override: true })
}

const serviceHost = process.env.MIROSHARK_SERVICE_HOST || 'http://127.0.0.1'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  transpilePackages: [
    '@miroshark/ui',
    '@repo/auth',
    '@repo/circle',
    '@repo/collaboration',
    '@repo/database',
    '@repo/ens',
    '@repo/fhenix',
    '@repo/gensyn-axl',
    '@repo/keeperhub',
    '@repo/openclaw',
    '@repo/polymarket',
    '@repo/uniswap',
    '@repo/zero-g',
  ],
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
