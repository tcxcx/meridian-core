import { NextResponse } from 'next/server'

import { buildZeroGAgentIdentity } from '@repo/zero-g'
import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const wallets = await resolveWalletTopology()
  if (!wallets.agent.address) {
    return NextResponse.json(
      { error: 'agent_wallet_missing', message: 'Provision the trading wallet before registering a 0G agent identity.' },
      { status: 409 },
    )
  }

  const base = buildZeroGAgentIdentity({
    agentWalletAddress: wallets.agent.address,
    ownerEmail: actor.email,
    label: String(body?.label || '').trim(),
  })

  const identity = {
    ...base,
    registered: true,
    note: String(body?.note || '').trim(),
    registeredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  await synchronizeUserPlatformState(actor.userId, {
    wallets: {
      agentIdentity: identity,
    },
  })

  return NextResponse.json({ identity })
}
