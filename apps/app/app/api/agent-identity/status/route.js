import { NextResponse } from 'next/server'

import { buildZeroGAgentIdentity } from '@repo/zero-g'
import { getPlatformActor } from '@/lib/server/platform-session'
import { readUserPlatformState, synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [platformState, wallets] = await Promise.all([
    readUserPlatformState(actor.userId),
    resolveWalletTopology(),
  ])

  const persisted = platformState.wallets?.agentIdentity || {}
  const derived = buildZeroGAgentIdentity({
    agentWalletAddress: wallets.agent.address,
    ownerEmail: actor.email,
    label: persisted.label,
  })

  const identity = {
    provider: '0g',
    registered: Boolean(persisted.registered),
    identityId: persisted.identityId || derived.identityId,
    label: persisted.label || derived.label,
    identityAddress: persisted.identityAddress || derived.identityAddress,
    agentWalletAddress: wallets.agent.address || persisted.agentWalletAddress || '',
    ownerEmail: actor.email || persisted.ownerEmail || '',
    note: persisted.note || '',
    explorerUrl: persisted.explorerUrl || derived.explorerUrl,
    registeredAt: persisted.registeredAt || null,
    updatedAt: persisted.updatedAt || null,
  }

  if (!persisted.identityId || persisted.agentWalletAddress !== identity.agentWalletAddress) {
    await synchronizeUserPlatformState(actor.userId, {
      wallets: {
        agentIdentity: identity,
      },
    })
  }

  return NextResponse.json({ identity })
}
