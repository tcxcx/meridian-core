import { getCurrentSession } from '@repo/auth/server'

export async function getPlatformActor() {
  const session = await getCurrentSession()
  if (session.enabled && !session.userId) {
    return { authenticated: false, session, userId: null, email: null, displayName: null }
  }

  const email = session.user?.emailAddresses?.[0]?.emailAddress || process.env.MIROSHARK_OWNER_EMAIL || null
  const displayName =
    session.user?.fullName ||
    [session.user?.firstName, session.user?.lastName].filter(Boolean).join(' ') ||
    process.env.MIROSHARK_OWNER_NAME ||
    'MiroShark Operator'

  return {
    authenticated: true,
    session,
    userId: session.userId || 'local-owner',
    email,
    displayName,
  }
}
