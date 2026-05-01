import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { readTreasuryWalletState } from '@/lib/server/treasury-state'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function slugify(value) {
  return String(value || 'miroshark-main')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'miroshark-main'
}

export async function POST(request) {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const workspaceTitle = String(body?.title || 'MiroShark Main Fund').trim() || 'MiroShark Main Fund'
  const workspaceSlug = slugify(body?.slug || workspaceTitle)

  const [walletTopology, treasuryWallet] = await Promise.all([
    resolveWalletTopology(),
    readTreasuryWalletState(),
  ])

  const state = await synchronizeUserPlatformState(actor.userId, {
    profile: {
      email: actor.email,
      displayName: actor.displayName,
    },
    workspace: {
      slug: workspaceSlug,
      title: workspaceTitle,
      liveblocksRoom: `${workspaceSlug}:operator`,
    },
    setup: {
      currentStep: 'treasury',
      workspaceBootstrapped: true,
      treasuryProvisioned: Boolean(treasuryWallet?.walletAddress),
      tradingWalletReady: Boolean(walletTopology.agent.address),
      collaborationReady: true,
    },
    wallets: {
      treasuryAddress: walletTopology.treasury.address,
      tradingAddress: walletTopology.agent.address,
      treasuryFundingMode: walletTopology.treasury.fundingMode,
    },
})

  return NextResponse.json(state)
}
