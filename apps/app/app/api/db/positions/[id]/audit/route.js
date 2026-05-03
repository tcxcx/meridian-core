import { NextResponse } from 'next/server'

import { listAuditByPosition } from '@repo/database'

// GET /api/db/positions/{id}/audit
// Returns the full audit timeline for a position from the Neon projection.
// Same shape the operator-terminal already expects: { events: [...] }.
export async function GET(_request, { params }) {
  const id = (await params)?.id
  if (!id) return NextResponse.json({ events: [], error: 'id required' }, { status: 400 })
  try {
    const events = await listAuditByPosition(id, { limit: 500 })
    return NextResponse.json({ events })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'failed to list audit', events: [] },
      { status: 500 },
    )
  }
}
