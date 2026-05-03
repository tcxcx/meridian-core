import { NextResponse } from 'next/server'

import { resolveIdentity } from '@repo/ens'

// In-memory 5-min TTL cache. Fine for a single Next.js process; survives a
// page reload but flushed on redeploy. ENS records change rarely so this is
// safe; reduces the per-request mainnet RPC pressure to near-zero.
const _cache = new Map()
const TTL_MS = 5 * 60 * 1000

function cacheKey({ name, address, network }) {
  return `${network || 'mainnet'}::${(name || '').toLowerCase()}::${(address || '').toLowerCase()}`
}

// GET /api/ens/resolve?address=0x... or ?name=foo.eth (or both)
// Returns { name, address, textRecords, network, resolvedAt }.
export async function GET(request) {
  try {
    const url = new URL(request.url)
    const name = url.searchParams.get('name') || null
    const address = url.searchParams.get('address') || null
    const network = url.searchParams.get('network') || null
    if (!name && !address) {
      return NextResponse.json(
        { error: 'name or address query param required' },
        { status: 400 },
      )
    }

    const key = cacheKey({ name, address, network })
    const hit = _cache.get(key)
    if (hit && Date.now() - hit.ts < TTL_MS) {
      return NextResponse.json({ ...hit.value, cached: true })
    }

    const value = await resolveIdentity({ name, address, network })
    _cache.set(key, { ts: Date.now(), value })
    return NextResponse.json({ ...value, cached: false })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'ens resolve failed' },
      { status: 500 },
    )
  }
}
