import { NextResponse } from 'next/server'

import { pendingTreasuryTransfersDb } from '@repo/database'

// GET /api/db/treasury/transfers/pending?signer_address=0x...
// Header pending-sig pill polls this every 5s. DB-backed so it survives
// router restarts, doesn't depend on the Python service being reachable.
export async function GET(request) {
  try {
    const url = new URL(request.url)
    const signerAddress = url.searchParams.get('signer_address') || null
    const transfers = await pendingTreasuryTransfersDb({ signerAddress, limit: 20 })
    return NextResponse.json({ transfers })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'failed to list pending transfers', transfers: [] },
      { status: 500 },
    )
  }
}
