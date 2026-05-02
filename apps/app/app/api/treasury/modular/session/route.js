import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const COOKIE_NAME = 'miroshark_treasury_session'
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 7,
  }
}

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const jar = await cookies()
  const raw = jar.get(COOKIE_NAME)?.value
  if (!raw) {
    return NextResponse.json({ connected: false, session: null })
  }
  try {
    return NextResponse.json({ connected: true, session: JSON.parse(raw) })
  } catch {
    return NextResponse.json({ connected: false, session: null })
  }
}

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
    const credentialUsername = String(body?.credentialUsername || '').trim() || null

    if (!ADDRESS_RE.test(walletAddress) || !chain || !chainId || !credentialId) {
      return NextResponse.json(
        { error: 'invalid_input', message: 'walletAddress, chain, chainId, and credentialId are required.' },
        { status: 400 },
      )
    }

    const session = {
      walletAddress,
      chain,
      chainId,
      credentialId,
      credentialUsername,
      connectedAt: new Date().toISOString(),
    }

    const jar = await cookies()
    jar.set(COOKIE_NAME, JSON.stringify(session), cookieOptions())
    return NextResponse.json({ connected: true, session })
  } catch (error) {
    return NextResponse.json(
      { error: 'session_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export async function DELETE() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const jar = await cookies()
  jar.delete(COOKIE_NAME)
  return NextResponse.json({ connected: false, session: null })
}
