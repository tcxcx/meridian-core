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
    // /signal/* and /execution/* are handled by app/signal/[...path]/route.js
    // and app/execution/[...path]/route.js — the route handlers proxy through
    // tunnel-proxy.js which injects the bearer token. Keeping a rewrite here
    // would shadow the route on Vercel because afterFiles rewrites resolve
    // before dynamic catch-all routes (DNS_HOSTNAME_RESOLVED_PRIVATE on prod).
    return [
      {
        source: '/backend/:path*',
        destination: `${serviceHost}:5001/:path*`,
      },
    ]
  },
}

export default nextConfig
