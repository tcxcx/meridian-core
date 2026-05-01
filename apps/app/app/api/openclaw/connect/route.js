import { NextResponse } from 'next/server'

import { buildOpenClawManifest, writeOpenClawState } from '@repo/openclaw'
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
  const endpoint = String(body?.endpoint || '').trim()
  const apiKey = String(body?.apiKey || '').trim()
  if (!endpoint || !apiKey) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'endpoint and apiKey are required.' },
      { status: 400 },
    )
  }

  const [connector, platformState, wallets] = await Promise.all([
    writeOpenClawState(actor.userId, {
      endpoint,
      apiKey,
      operatorName: body?.operatorName || '',
      model: body?.model || '',
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
        openclawReady: true,
      },
    }),
    resolveWalletTopology(),
  ])

  return NextResponse.json({
    connector: {
      connected: connector.connected,
      provider: connector.provider,
      endpoint: connector.endpoint,
      operatorName: connector.operatorName,
      model: connector.model,
      apiKeyPreview: connector.apiKeyPreview,
      manageAgentWallet: connector.manageAgentWallet,
      allowTreasuryProvisioning: connector.allowTreasuryProvisioning,
      notes: connector.notes,
      updatedAt: connector.updatedAt,
      connectedAt: connector.connectedAt,
    },
    manifest: buildOpenClawManifest({
      openclaw: connector,
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
