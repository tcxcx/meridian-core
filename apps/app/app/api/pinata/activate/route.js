import { NextResponse } from 'next/server'

import { setPinataRunState, summarizePinataState } from '@repo/pinata-agents'
import { getPlatformActor } from '@/lib/server/platform-session'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED = new Set(['idle', 'deployed', 'running', 'paused', 'error'])

export async function POST(request) {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const requested = String(body?.runState || '').trim().toLowerCase()
  if (!ALLOWED.has(requested)) {
    return NextResponse.json(
      {
        error: 'invalid_input',
        message: `runState must be one of: ${[...ALLOWED].join(', ')}`,
        allowed_states: [...ALLOWED],
      },
      { status: 400 },
    )
  }

  // Note: this endpoint flips MiroShark's view of the autonomous-mode state
  // (what the operator-terminal pill shows). Actually starting/pausing the
  // hosted Pinata agent is done via the Pinata dashboard or the Pinata CLI.
  // Future work: wire `pinata agents start <id>` here when an API key is set.
  const next = await setPinataRunState(actor.userId, requested)
  return NextResponse.json({ connector: summarizePinataState(next) })
}
