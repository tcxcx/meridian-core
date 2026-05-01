import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import {
  readPasskeys,
  writePasskeys,
  writeTreasuryWalletState,
} from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

export async function POST(request) {
  try {
    const actor = await getPlatformActor()
    if (!actor.authenticated) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const walletAddress = String(body?.walletAddress || '').trim()
    const chain = String(body?.chain || '').trim()
    const chainId = Number(body?.chainId || 0)
    const credentialId = String(body?.credentialId || '').trim()
    const publicKey = typeof body?.publicKey === 'string' ? body.publicKey : null
    const recoveryRegistered = Boolean(body?.recoveryRegistered)
    const addressBookInstalled = Boolean(body?.addressBookInstalled)
    const registeredRecipients = Array.isArray(body?.registeredRecipients) ? body.registeredRecipients : []
    const addressMappings = Array.isArray(body?.addressMappings) ? body.addressMappings : []
    const userOpHash = typeof body?.userOpHash === 'string' ? body.userOpHash : null

    if (!ADDRESS_RE.test(walletAddress)) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'walletAddress must be a valid 0x address.' },
        { status: 400 },
      )
    }
    if (!credentialId || !chain || !chainId) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'chain, chainId, and credentialId are required.' },
        { status: 400 },
      )
    }

    const wallet = await writeTreasuryWalletState({
      walletAddress,
      chain,
      chainId,
      credentialId,
      publicKey,
      recoveryRegistered,
      addressBookInstalled,
      registeredRecipients,
      addressMappings,
      userOpHash,
      transportSegment: body?.transportSegment || null,
    })

    const passkeyState = await readPasskeys()
    const credential = {
      id: credentialId,
      publicKey,
      transports: ['internal'],
      deviceType: 'passkey',
      backedUp: true,
      createdAt: new Date().toISOString(),
      label: `Circle modular treasury (${chain})`,
      source: 'circle-modular',
      walletAddress,
    }
    const credentials = [
      ...(passkeyState.credentials || []).filter((item) => item.id !== credentialId),
      credential,
    ]
    const savedPasskeys = await writePasskeys({ credentials })
    await synchronizeUserPlatformState(actor.userId, {
      profile: {
        email: actor.email,
        displayName: actor.displayName,
      },
      setup: {
        currentStep: 'trading',
        treasuryProvisioned: true,
      },
    })

    return NextResponse.json({
      wallet,
      credentials: savedPasskeys.credentials,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'activate_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
