import { NextResponse } from 'next/server'

import { authenticateRoom } from '@repo/collaboration/auth'
import { getPlatformActor } from '@/lib/server/platform-session'
import { readUserPlatformState } from '@/lib/server/platform-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const state = await readUserPlatformState(actor.userId)
  const roomId = state.workspace?.liveblocksRoom
  if (!roomId) {
    return NextResponse.json({ error: 'workspace_not_ready' }, { status: 409 })
  }

  return authenticateRoom({
    roomId,
    userId: actor.userId,
    userInfo: {
      name: actor.displayName,
      email: actor.email,
    },
  })
}
