import { proxyRequest } from '@/lib/server/tunnel-proxy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function handle(request, { params }) {
  const { path = [] } = await params
  return proxyRequest({ request, service: 'execution', pathSegments: ['api', ...path] })
}

export const GET = handle
export const POST = handle
export const PUT = handle
export const PATCH = handle
export const DELETE = handle
