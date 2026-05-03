import { NextResponse } from 'next/server'

import { latestSwarmRun, listSwarmRuns } from '@repo/database'

// GET /api/db/markets/{market_id}/swarm
// GET /api/db/markets/{market_id}/swarm?history=1
// Lets the AGENT panel show "last decision" without re-running the swarm,
// and surfaces a per-market swarm history for audit replay.
export async function GET(request, { params }) {
  const id = (await params)?.id
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  try {
    const url = new URL(request.url)
    const history = url.searchParams.get('history')
    if (history) {
      const runs = await listSwarmRuns({ marketId: id, limit: 50 })
      return NextResponse.json({ runs })
    }
    const run = await latestSwarmRun({ marketId: id })
    return NextResponse.json({ run })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'failed to fetch swarm run' },
      { status: 500 },
    )
  }
}
