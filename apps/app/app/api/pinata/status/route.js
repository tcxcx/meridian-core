import { NextResponse } from 'next/server'

import { buildPinataManifest, readPinataState, summarizePinataState } from '@repo/pinata-agents'
import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [pinata, platformState, wallets] = await Promise.all([
    readPinataState(actor.userId),
    synchronizeUserPlatformState(actor.userId),
    resolveWalletTopology(),
  ])

  const policy = {
    treasuryProvisionPct: 0.1,
    perPositionMinPct: 0.01,
    perPositionMaxPct: 0.05,
  }

  return NextResponse.json({
    connector: summarizePinataState(pinata),
    manifest: buildPinataManifest({
      pinata,
      workspace: platformState.workspace,
      actor,
      wallets,
      policy,
    }),
  })
}
