import 'server-only'

import { Liveblocks } from '@liveblocks/node'

export async function authenticateRoom({ roomId, userId, userInfo }) {
  if (!process.env.LIVEBLOCKS_SECRET) {
    throw new Error('LIVEBLOCKS_SECRET is not set')
  }

  const liveblocks = new Liveblocks({ secret: process.env.LIVEBLOCKS_SECRET })
  const session = liveblocks.prepareSession(userId, { userInfo })
  session.allow(roomId, session.FULL_ACCESS)
  const { status, body } = await session.authorize()
  return new Response(body, { status })
}
