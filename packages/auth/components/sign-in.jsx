'use client'

import { SignIn } from '@clerk/nextjs'
import dynamic from 'next/dynamic'
import { AuthShell, AuthUnavailable, mirosharkClerkAppearance } from './auth-shell'

function SignInForm() {
  return (
    <SignIn
      appearance={mirosharkClerkAppearance}
      routing="path"
      path="/sign-in"
      oauthFlow="redirect"
      signUpUrl="/sign-up"
      fallbackRedirectUrl="/setup"
    />
  )
}

const ClientSignInForm = dynamic(() => Promise.resolve(SignInForm), {
  ssr: false,
  loading: () => <div className="auth-card-skeleton">Loading sign in…</div>,
})

export function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable />
  }

  return (
    <AuthShell
      mode="Operator entry"
      title="Sign in."
      description="Access the private terminal."
    >
      <div className="auth-card-shell">
        <div className="auth-card-header">
          <span className="auth-card-kicker">Sign in</span>
          <span className="auth-route-head-r">/sign-in</span>
        </div>
        <div className="auth-card-body">
          <ClientSignInForm />
        </div>
      </div>
    </AuthShell>
  )
}
