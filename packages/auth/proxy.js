import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/icon.svg',
  // Internal cross-service bridge — gates itself with CIRCLE_BRIDGE_TOKEN bearer
  // (see apps/app/app/api/circle/execute/route.js). Public so the Python
  // execution_router can call it without a Clerk session.
  '/api/circle/execute',
  // Public read-only ENS resolution — no secrets returned, mainnet-aware.
  '/api/ens/resolve',
  // Bearer-gated by MIROSHARK_AGENT_TOKEN — Pinata agent + execution_router
  // call these to quote/calldata Uniswap swaps without a Clerk session.
  '/api/uniswap/quote',
  '/api/uniswap/calldata',
])
const isProtectedPageRoute = createRouteMatcher(['/setup(.*)'])
const isProtectedApiRoute = createRouteMatcher(['/api/(.*)'])

function sanitizeReturnBackUrl(request) {
  const url = request.nextUrl.clone()
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('__clerk')) {
      url.searchParams.delete(key)
    }
  }
  return url.toString()
}

function hasClerkHandshakeParams(request) {
  return [...request.nextUrl.searchParams.keys()].some((key) => key.startsWith('__clerk'))
}

function scrubClerkCookies(request, response) {
  const host = request.nextUrl.hostname
  for (const cookie of request.cookies.getAll()) {
    if (
      cookie.name.startsWith('__clerk')
      || cookie.name.startsWith('__client_uat')
      || cookie.name.startsWith('__session')
      || cookie.name.startsWith('__refresh')
    ) {
      response.cookies.delete(cookie.name)
      response.cookies.set(cookie.name, '', { path: '/', maxAge: 0 })
      if (host === 'localhost') {
        response.cookies.set(cookie.name, '', { path: '/', domain: 'localhost', maxAge: 0 })
      }
      if (host === '127.0.0.1') {
        response.cookies.set(cookie.name, '', { path: '/', domain: '127.0.0.1', maxAge: 0 })
      }
    }
  }
  return response
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
    if (isPublicRoute(request)) {
      return NextResponse.next()
    }

    const session = await auth()
    const { userId } = session

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
      if (hasClerkHandshakeParams(request)) {
        const response = NextResponse.redirect(new URL(sanitizeReturnBackUrl(request)))
        return scrubClerkCookies(request, response)
      }
      throw error
    }
  }
}
