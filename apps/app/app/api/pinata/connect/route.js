import { NextResponse } from 'next/server'

import { buildPinataManifest, summarizePinataState, writePinataState } from '@repo/pinata-agents'
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
  const agentId = String(body?.agentId || '').trim()
  const agentChatUrl = String(body?.agentChatUrl || '').trim()
  if (!agentId || !agentChatUrl) {
    return NextResponse.json(
      {
        error: 'invalid_input',
        message: 'agentId and agentChatUrl are required. Find both in your Pinata Cloud agent dashboard.',
      },
      { status: 400 },
    )
  }

  const [connector, platformState, wallets] = await Promise.all([
    writePinataState(actor.userId, {
      agentId,
      agentChatUrl,
      agentTemplate: body?.agentTemplate || 'prediction-market-trader',
      telegramHandle: body?.telegramHandle || '',
      onrampAgentId: body?.onrampAgentId || '',
      onrampChatUrl: body?.onrampChatUrl || '',
      operatorName: body?.operatorName || '',
      apiKey: body?.apiKey || '',
      manageAgentWallet: body?.manageAgentWallet !== false,
      allowTreasuryProvisioning: body?.allowTreasuryProvisioning !== false,
      notes: body?.notes || '',
    }),
    synchronizeUserPlatformState(actor.userId, {
      profile: {
        email: actor.email,
        displayName: actor.displayName,
      },
      setup: {
        currentStep: 'launch',
        // Surface as automation-ready in the same setup block as openclaw —
        // the marketing home + setup wizard read this flag.
        openclawReady: true,
        pinataReady: true,
      },
    }),
    resolveWalletTopology(),
  ])

  return NextResponse.json({
    connector: summarizePinataState(connector),
    manifest: buildPinataManifest({
      pinata: connector,
      workspace: platformState.workspace,
      actor,
      wallets,
      policy: {
        treasuryProvisionPct: 0.1,
        perPositionMinPct: 0.01,
        perPositionMaxPct: 0.05,
      },
    }),
  })
}
