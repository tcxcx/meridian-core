import { NextResponse } from 'next/server'

import { clearPinataState, summarizePinataState } from '@repo/pinata-agents'
import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [connector] = await Promise.all([
    clearPinataState(actor.userId),
    synchronizeUserPlatformState(actor.userId, {
      setup: {
        // Drop pinataReady; leave openclawReady alone for users who connected
        // both. Readiness is OR'd downstream.
        pinataReady: false,
      },
    }),
  ])

  return NextResponse.json({
    connector: summarizePinataState(connector),
  })
}
