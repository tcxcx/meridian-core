'use client'

import { SignUp } from '@clerk/nextjs'
import { AuthShell, AuthUnavailable, mirosharkClerkAppearance } from './auth-shell'

export function SignUpPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable />
  }

  return (
    <AuthShell
      mode="Private setup admission"
      title="Create the operator account before treasury provisioning begins."
      description="The sign-up route feeds directly into the five-stage setup flow: workspace, treasury, trading, OpenClaw, and launch. No dead-end auth screens."
      asideTitle="Sendero-style auth entry, but pointed at a wallet ceremony and execution setup that only MiroShark runs."
    >
      <div className="auth-card-shell">
        <div className="auth-card-header">
          <span className="auth-card-kicker">Sign up</span>
          <span className="auth-route-head-r">/sign-up</span>
        </div>
        <div className="auth-card-body">
          <SignUp
            appearance={mirosharkClerkAppearance}
            signInUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_IN_URL || '/sign-in'}
            fallbackRedirectUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL || '/setup'}
            forceRedirectUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_UP_FORCE_REDIRECT_URL || undefined}
          />
        </div>
      </div>
    </AuthShell>
  )
}
