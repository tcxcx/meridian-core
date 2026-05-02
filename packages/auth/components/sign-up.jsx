'use client'

import { SignUp } from '@clerk/nextjs'
import dynamic from 'next/dynamic'
import { AuthShell, AuthUnavailable, mirosharkClerkAppearance } from './auth-shell'

function SignUpForm() {
  return (
    <SignUp
      appearance={mirosharkClerkAppearance}
      routing="path"
      path="/sign-up"
      oauthFlow="redirect"
      signInUrl="/sign-in"
      fallbackRedirectUrl="/setup"
    />
  )
}

const ClientSignUpForm = dynamic(() => Promise.resolve(SignUpForm), {
  ssr: false,
  loading: () => <div className="auth-card-skeleton">Loading sign up…</div>,
})

export function SignUpPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable />
  }

  return (
    <AuthShell
      mode="Operator setup"
      title="Create account."
      description="Create access, then set wallets."
    >
      <div className="auth-card-shell">
        <div className="auth-card-header">
          <span className="auth-card-kicker">Sign up</span>
          <span className="auth-route-head-r">/sign-up</span>
        </div>
        <div className="auth-card-body">
          <ClientSignUpForm />
        </div>
      </div>
    </AuthShell>
  )
}
