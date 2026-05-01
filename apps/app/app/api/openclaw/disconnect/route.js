import { NextResponse } from 'next/server'

import { clearOpenClawState, summarizeOpenClawState } from '@repo/openclaw'
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
    clearOpenClawState(actor.userId),
    synchronizeUserPlatformState(actor.userId, {
      setup: {
        currentStep: 'openclaw',
        openclawReady: false,
      },
    }),
  ])

  return NextResponse.json({
    connector: summarizeOpenClawState(connector),
  })
}
