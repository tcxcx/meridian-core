import { randomUUID } from 'crypto'

import { generateRegistrationOptions } from '@simplewebauthn/server'
import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { readPasskeys } from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PASSKEY_CHALLENGES = globalThis.__mirosharkPasskeyChallenges || new Map()
globalThis.__mirosharkPasskeyChallenges = PASSKEY_CHALLENGES

function resolveOrigin(request) {
  const origin = request.headers.get('origin')
  if (origin) return origin
  return process.env.NEXT_PUBLIC_APP_URL || process.env.MIROSHARK_APP_URL || 'http://localhost:3000'
}

function resolveRpId(request) {
  try {
    return new URL(resolveOrigin(request)).hostname
  } catch {
    return 'localhost'
  }
}

export async function POST(request) {
  try {
    const actor = await getPlatformActor()
    if (!actor.authenticated) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => ({}))
    const label = String(body?.label || 'Miroshark Treasury Signer').trim()
    const rpID = resolveRpId(request)
    const rpName = 'Miroshark Treasury'
    const passkeys = await readPasskeys()

    const options = await generateRegistrationOptions({
      rpID,
      rpName,
      userName: label,
      userDisplayName: label,
      userID: Buffer.from(`miroshark:${randomUUID()}`),
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'required',
        authenticatorAttachment: 'platform',
      },
      excludeCredentials: (passkeys.credentials || []).map((credential) => ({
        id: Buffer.from(credential.id, 'base64url'),
        type: 'public-key',
        transports: credential.transports || [],
      })),
    })

    const challengeToken = randomUUID()
    PASSKEY_CHALLENGES.set(challengeToken, {
      challenge: options.challenge,
      origin: resolveOrigin(request),
      rpID,
      createdAt: Date.now(),
      label,
      actorUserId: actor.userId,
    })

    return NextResponse.json({ challengeToken, options })
  } catch (error) {
    return NextResponse.json(
      { error: 'challenge_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
