'use client'

import Link from 'next/link'

import { MirosharkUnicornScene } from '../../ui/src/components/unicorn-scene.jsx'

const ENTRY_POINTS = [
  'One console for signals, wallets, and trades.',
  'Treasury and trading stay separated.',
  'OpenClaw connects after setup.',
]

function AuthFallback({ children }) {
  return (
    <div className="auth-card-shell">
      <div className="auth-card-header">
        <span className="auth-card-kicker">Configuration required</span>
      </div>
      <div className="auth-card-body auth-card-body-static">{children}</div>
    </div>
  )
}

export function AuthUnavailable() {
  return (
    <AuthShell
      mode="setup locked"
      title="Auth not configured."
      description="Add Clerk keys to continue."
    >
      <AuthFallback>
        <p className="auth-unavailable-copy">
          Clerk env missing.
        </p>
      </AuthFallback>
    </AuthShell>
  )
}

export function AuthShell({
  mode,
  title,
  description,
  children,
}) {
  const marketingOrigin = process.env.NEXT_PUBLIC_MARKETING_URL || 'http://127.0.0.1:3302'

  return (
    <MirosharkUnicornScene variant="setup">
      <div className="auth-shell">
        <div className="auth-frame">
          <header className="auth-header">
            <div className="auth-brand-block">
              <div className="auth-brand-mark">MiroShark</div>
              <div className="auth-brand-sub">private operator entry</div>
            </div>
            <nav className="auth-nav" aria-label="Authentication routes">
              <Link className="auth-nav-link" href="/sign-in">Sign in</Link>
              <Link className="auth-nav-link" href="/sign-up">Sign up</Link>
              <a className="auth-nav-link" href={marketingOrigin}>Overview</a>
            </nav>
          </header>

          <main className="auth-grid auth-grid-single">
            <section className="auth-manifesto auth-reveal" data-step="1">
              <div className="auth-kicker-row">
                <span className="auth-mini-kicker">{mode}</span>
                <span className="auth-chip">Passkey custody</span>
              </div>
              <h1 className="auth-title">{title}</h1>
              <p className="auth-copy">{description}</p>

              <div className="auth-manifesto-clerk">
                {children}
              </div>

              <div className="auth-plain-points">
                {ENTRY_POINTS.map((point) => (
                  <span key={point}>{point}</span>
                ))}
              </div>
            </section>
          </main>

          <footer className="auth-footer-note">
            <span>MiroShark</span>
            <span>Auth. Setup. Terminal.</span>
          </footer>
        </div>
      </div>
    </MirosharkUnicornScene>
  )
}

export const mirosharkClerkAppearance = {
  variables: {
    colorPrimary: '#0000ff',
    colorText: '#050505',
    colorBackground: '#ffffff',
    colorInputBackground: '#ffffff',
    colorInputText: '#050505',
    borderRadius: '0px',
  },
  elements: {
    rootBox: 'clerk-root',
    cardBox: 'clerk-card-box',
    card: 'clerk-card',
    headerTitle: 'clerk-header-title',
    headerSubtitle: 'clerk-header-subtitle',
    socialButtonsBlockButton: 'clerk-secondary-button',
    socialButtonsBlockButtonText: 'clerk-secondary-button-text',
    formButtonPrimary: 'clerk-primary-button',
    footerActionLink: 'clerk-footer-link',
    formFieldLabel: 'clerk-label',
    formFieldInput: 'clerk-input',
    formFieldInputShowPasswordButton: 'clerk-password-button',
    dividerLine: 'clerk-divider-line',
    dividerText: 'clerk-divider-text',
    formFieldErrorText: 'clerk-error',
    alertText: 'clerk-alert',
    otpCodeFieldInput: 'clerk-input',
    identityPreviewText: 'clerk-identity-preview',
    formResendCodeLink: 'clerk-footer-link',
    alternativeMethodsBlockButton: 'clerk-secondary-button',
  },
}
