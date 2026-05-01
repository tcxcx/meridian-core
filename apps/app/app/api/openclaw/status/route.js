import { NextResponse } from 'next/server'

import { buildOpenClawManifest, readOpenClawState, summarizeOpenClawState } from '@repo/openclaw'
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

  const [openclaw, platformState, wallets] = await Promise.all([
    readOpenClawState(actor.userId),
    synchronizeUserPlatformState(actor.userId),
    resolveWalletTopology(),
  ])

  const policy = {
    treasuryProvisionPct: 0.1,
    perPositionMinPct: 0.01,
    perPositionMaxPct: 0.05,
  }

  return NextResponse.json({
    connector: summarizeOpenClawState(openclaw),
    manifest: buildOpenClawManifest({
      openclaw,
      workspace: platformState.workspace,
      actor,
      wallets,
      policy,
    }),
  })
}
