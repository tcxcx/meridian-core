'use client'

import { SignIn } from '@clerk/nextjs'
import { AuthShell, AuthUnavailable, mirosharkClerkAppearance } from './auth-shell'

export function SignInPage() {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <AuthUnavailable />
  }

  return (
    <AuthShell
      mode="Private operator entry"
      title="Sign in to continue the custody and launch sequence."
      description="Use the same console-native flow as the product itself. Authentication leads into treasury custody, trading confirmation, and external operator setup."
      asideTitle="This is not a generic auth page. It is the first gate in the MiroShark operating sequence."
    >
      <div className="auth-card-shell">
        <div className="auth-card-header">
          <span className="auth-card-kicker">Sign in</span>
          <span className="auth-route-head-r">/sign-in</span>
        </div>
        <div className="auth-card-body">
          <SignIn
            appearance={mirosharkClerkAppearance}
            signUpUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_UP_URL || '/sign-up'}
            fallbackRedirectUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL || '/setup'}
            forceRedirectUrl={process.env.NEXT_PUBLIC_CLERK_SIGN_IN_FORCE_REDIRECT_URL || undefined}
          />
        </div>
      </div>
    </AuthShell>
  )
}
