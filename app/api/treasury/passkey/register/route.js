import { verifyRegistrationResponse } from '@simplewebauthn/server'
import { NextResponse } from 'next/server'

import { readPasskeys, writePasskeys } from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const PASSKEY_CHALLENGES = globalThis.__mirosharkPasskeyChallenges || new Map()
globalThis.__mirosharkPasskeyChallenges = PASSKEY_CHALLENGES

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null)
    const challengeToken = String(body?.challengeToken || '')
    const response = body?.response
    if (!challengeToken || !response) {
      return NextResponse.json({ error: 'invalid_input', message: 'challengeToken and response are required.' }, { status: 400 })
    }

    const pending = PASSKEY_CHALLENGES.get(challengeToken)
    if (!pending) {
      return NextResponse.json({ error: 'challenge_missing', message: 'Passkey challenge expired or was not found.' }, { status: 410 })
    }

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: pending.challenge,
      expectedOrigin: pending.origin,
      expectedRPID: pending.rpID,
      requireUserVerification: true,
    })

    if (!verification.verified) {
      return NextResponse.json({ error: 'verification_failed', message: 'Passkey registration could not be verified.' }, { status: 400 })
    }

    const credentialRecord = {
      id: response.id,
      publicKey: verification.registrationInfo?.credential?.publicKey
        ? Buffer.from(verification.registrationInfo.credential.publicKey).toString('base64url')
        : null,
      counter: verification.registrationInfo?.credential?.counter ?? verification.registrationInfo?.counter ?? 0,
      transports: response?.response?.transports || [],
      deviceType: verification.registrationInfo?.credentialDeviceType || null,
      backedUp: verification.registrationInfo?.credentialBackedUp || false,
      createdAt: new Date().toISOString(),
      label: pending.label,
    }

    const current = await readPasskeys()
    const credentials = [...(current.credentials || []).filter((item) => item.id !== credentialRecord.id), credentialRecord]
    const saved = await writePasskeys({ credentials })
    PASSKEY_CHALLENGES.delete(challengeToken)

    return NextResponse.json({
      verified: true,
      credential: credentialRecord,
      credentials: saved.credentials,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'register_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
