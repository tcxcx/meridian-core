import 'server-only'

/**
 * Server-side proxy for the bearer-gated MiroShark services exposed via the
 * Cloudflare tunnel.
 *
 * Why this exists: the operator-terminal calls /signal/api/signal/run and
 * /execution/api/execution/operator/status from the browser. The tunnel
 * services require Authorization: Bearer ${MIROSHARK_AGENT_TOKEN}, which the
 * browser cannot safely add. This proxy injects the bearer server-side.
 *
 * Local dev: MIROSHARK_SIGNAL_URL / MIROSHARK_EXECUTION_URL default to
 * http://127.0.0.1:5002 / :5004 so the existing dev stack still works.
 *
 * Production (Vercel): set MIROSHARK_SIGNAL_URL / MIROSHARK_EXECUTION_URL to
 * the tunnel hosts (https://signal.miro-shark.com etc).
 */

const SERVICE_HOSTS = {
  signal: () => process.env.MIROSHARK_SIGNAL_URL || 'http://127.0.0.1:5002',
  execution: () => process.env.MIROSHARK_EXECUTION_URL || 'http://127.0.0.1:5004',
}

function buildUpstreamUrl({ service, pathSegments, search }) {
  const base = SERVICE_HOSTS[service]?.()
  if (!base) throw new Error(`unknown service "${service}"`)
  const path = (pathSegments || []).join('/')
  const trimmedBase = base.replace(/\/+$/, '')
  return `${trimmedBase}/${path}${search || ''}`
}

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-authenticate', 'proxy-authorization',
  // We override these:
  'host', 'authorization', 'content-length',
  // Node's fetch auto-decompresses upstream bodies — keeping content-encoding
  // would tell the client to decompress already-decompressed bytes (Vercel
  // returned an empty body in this case).
  'content-encoding',
])

function copyRequestHeaders(request) {
  const headers = new Headers()
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  }
  const token = (process.env.MIROSHARK_AGENT_TOKEN || '').trim()
  if (token) headers.set('authorization', `Bearer ${token}`)
  return headers
}

function copyResponseHeaders(upstream) {
  const out = new Headers()
  for (const [key, value] of upstream.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) out.set(key, value)
  }
  return out
}

/**
 * Handle one proxied request. Streams the upstream body verbatim so SSE
 * (text/event-stream) endpoints like /api/signal/runs/stream just work.
 */
export async function proxyRequest({ request, service, pathSegments }) {
  const url = new URL(request.url)
  const upstreamUrl = buildUpstreamUrl({
    service,
    pathSegments,
    search: url.search,
  })

  const init = {
    method: request.method,
    headers: copyRequestHeaders(request),
    redirect: 'manual',
    cache: 'no-store',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer()
  }

  let upstream
  try {
    upstream = await fetch(upstreamUrl, init)
  } catch (error) {
    return new Response(
      JSON.stringify({
        error: 'tunnel_unreachable',
        message: error?.message || String(error),
        upstream: upstreamUrl,
      }),
      { status: 502, headers: { 'content-type': 'application/json' } },
    )
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: copyResponseHeaders(upstream),
  })
}
