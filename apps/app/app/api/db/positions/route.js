import { NextResponse } from 'next/server'

import { listPositions } from '@repo/database'

// GET /api/db/positions?tenant_id=fund-a&limit=200
// Lean operator-terminal boots from this — no Python proxy, no SSE wait.
// SSE keeps live in-flight updates; DB is the persistence guarantee.
export async function GET(request) {
  try {
    const url = new URL(request.url)
    const tenantId = url.searchParams.get('tenant_id') || null
    const limit = Number(url.searchParams.get('limit') || 200)
    const positions = await listPositions({ tenantId, limit })
    return NextResponse.json({ positions })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'failed to list positions', positions: [] },
      { status: 500 },
    )
  }
}
