import 'server-only'

export async function getCurrentSession() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return { enabled: false, userId: null, user: null }
  }

  const { auth, currentUser } = await import('@clerk/nextjs/server')
  const session = await auth()
  if (!session?.userId) {
    return { enabled: true, userId: null, user: null }
  }
  const user = await currentUser()
  return { enabled: true, userId: session.userId, user }
}
