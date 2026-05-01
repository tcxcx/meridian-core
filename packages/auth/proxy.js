import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const isProtectedPageRoute = createRouteMatcher(['/setup(.*)'])
const isProtectedApiRoute = createRouteMatcher(['/api/(.*)'])
const isAuthRoute = createRouteMatcher(['/sign-in(.*)', '/sign-up(.*)'])

function sanitizeReturnBackUrl(request) {
  const url = request.nextUrl.clone()
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('__clerk')) {
      url.searchParams.delete(key)
    }
  }
  return url.toString()
}

function toLocalSignInRedirect(request) {
  const redirectUrl = request.nextUrl.clone()
  redirectUrl.pathname = '/sign-in'
  redirectUrl.search = ''

  const returnPath = request.nextUrl.clone()
  for (const key of [...returnPath.searchParams.keys()]) {
    if (key.startsWith('__clerk')) {
      returnPath.searchParams.delete(key)
    }
  }

  const relativeReturn = `${returnPath.pathname}${returnPath.search}${returnPath.hash}`
  redirectUrl.searchParams.set('redirect_url', relativeReturn || '/setup')
  return NextResponse.redirect(redirectUrl)
}

export function authMiddleware() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY || !process.env.CLERK_SECRET_KEY) {
    return () => NextResponse.next()
  }

  const signInUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL || '/sign-in'
  const signUpUrl = process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL || '/sign-up'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.MIROSHARK_APP_URL
  const authorizedParties = Array.from(
    new Set(
      [appUrl, 'http://127.0.0.1:3301', 'http://localhost:3301'].filter(Boolean),
    ),
  )

  const handler = clerkMiddleware(async (auth, request) => {
    const session = await auth()
    const { userId } = session
    if (userId && isAuthRoute(request)) {
      return NextResponse.redirect(new URL('/setup', request.url))
    }

    if (!userId && isProtectedApiRoute(request)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    if (!userId && isProtectedPageRoute(request)) {
      return toLocalSignInRedirect(request)
    }

    return NextResponse.next()
  }, () => ({
    signInUrl,
    signUpUrl,
    authorizedParties,
  }))

  return async (request, event) => {
    try {
      return await handler(request, event)
    } catch (error) {
      if ([...request.nextUrl.searchParams.keys()].some((key) => key.startsWith('__clerk'))) {
        return NextResponse.redirect(new URL(sanitizeReturnBackUrl(request)))
      }
      throw error
    }
  }
}
