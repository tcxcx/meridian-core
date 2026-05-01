'use client'

import { ClientSideSuspense, LiveblocksProvider, RoomProvider } from '@liveblocks/react/suspense'

export function Room({ id, authEndpoint, fallback, children }) {
  return (
    <LiveblocksProvider authEndpoint={authEndpoint}>
      <RoomProvider id={id} initialPresence={{ cursor: null }}>
        <ClientSideSuspense fallback={fallback}>{children}</ClientSideSuspense>
      </RoomProvider>
    </LiveblocksProvider>
  )
}
