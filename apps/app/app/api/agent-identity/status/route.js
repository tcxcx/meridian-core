import { NextResponse } from 'next/server'
import { promises as fs } from 'fs'
import path from 'path'

import { buildZeroGAgentIdentity, readZeroGSignerStatus } from '@repo/zero-g'
import { getPlatformActor } from '@/lib/server/platform-session'
import { readUserPlatformState, synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ONCHAIN_FALLBACK_PATH = path.resolve(process.cwd(), '../..', '.context', 'miroshark', 'agent-identity-onchain.json')

async function readOnchainFallbackIdentity() {
  try {
    return JSON.parse(await fs.readFile(ONCHAIN_FALLBACK_PATH, 'utf8'))
  } catch {
    return {}
  }
}

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const [platformState, wallets, signer, onchainFallback] = await Promise.all([
    readUserPlatformState(actor.userId),
    resolveWalletTopology(),
    readZeroGSignerStatus().catch((error) => ({
      ready: false,
      address: '',
      balanceWei: '0',
      balanceOg: '0',
      reason: error instanceof Error ? error.message : String(error),
    })),
    readOnchainFallbackIdentity(),
  ])

  const persisted = platformState.wallets?.agentIdentity || {}
  const anchored = persisted.txHash ? persisted : onchainFallback
  const derived = buildZeroGAgentIdentity({
    agentWalletAddress: wallets.agent.address,
    ownerEmail: actor.email || anchored.ownerEmail,
    label: anchored.label,
  })

  const identity = {
    provider: '0g',
    status: {
      ...derived.status,
      ...(persisted.status || {}),
      signerReady: signer.ready,
      signerAddress: signer.address,
      signerBalanceOg: signer.balanceOg,
      signerReason: signer.reason,
      onchain: Boolean(anchored.txHash || anchored.status?.onchain),
      mode: anchored.txHash ? 'onchain-anchor' : derived.status.mode,
    },
    registered: Boolean(anchored.registered && anchored.txHash),
    identityId: anchored.identityId || derived.identityId,
    label: anchored.label || derived.label,
    identityAddress: anchored.identityAddress || derived.identityAddress,
    agentWalletAddress: wallets.agent.address || persisted.agentWalletAddress || '',
    ownerEmail: actor.email || anchored.ownerEmail || '',
    note: anchored.note || '',
    explorerUrl: anchored.explorerUrl || derived.explorerUrl,
    txHash: anchored.txHash || '',
    txUrl: anchored.txUrl || '',
    blockNumber: anchored.blockNumber || '',
    payloadHash: anchored.payloadHash || '',
    registeredAt: anchored.registeredAt || null,
    updatedAt: anchored.updatedAt || null,
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
