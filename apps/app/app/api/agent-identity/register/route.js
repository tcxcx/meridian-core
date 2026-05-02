import { NextResponse } from 'next/server'

import { anchorZeroGAgentIdentity, buildZeroGAgentIdentity } from '@repo/zero-g'
import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request) {
  try {
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
    const anchor = await anchorZeroGAgentIdentity({
      identity: base,
      operatorAddress: wallets.treasury.address,
      note: String(body?.note || '').trim(),
    })

    const identity = {
      ...base,
      status: {
        ...base.status,
        ...anchor,
      },
      registered: anchor.status === 'success',
      note: String(body?.note || '').trim(),
      txHash: anchor.txHash,
      txUrl: anchor.txUrl,
      blockNumber: anchor.blockNumber,
      payloadHash: anchor.payloadHash,
      registeredAt: anchor.anchoredAt,
      updatedAt: new Date().toISOString(),
    }

    await synchronizeUserPlatformState(actor.userId, {
      wallets: {
        agentIdentity: identity,
      },
    })

    return NextResponse.json({ identity })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const code = error?.code || 'zero_g_anchor_failed'
    return NextResponse.json(
      {
        error: code,
        message,
        signerAddress: error?.signerAddress || null,
        balanceOg: error?.balanceOg || null,
      },
      { status: code === 'ZG_INSUFFICIENT_GAS' ? 409 : 500 },
    )
  }
}
