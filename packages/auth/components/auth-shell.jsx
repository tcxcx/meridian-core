'use client'

import Link from 'next/link'

import { MirosharkUnicornScene } from '../../ui/src/components/unicorn-scene.jsx'

const SETUP_FLOW = [
  ['01', 'Workspace shell', 'Create the private room, operator identity, and shared control plane.'],
  ['02', 'Treasury custody', 'Provision the Polygon treasury with passkeys, weighted signers, and recovery.'],
  ['03', 'Trading rail', 'Confirm the agent wallet, deployable budget, and Polygon Amoy funding route.'],
  ['04', 'External operator', 'Attach OpenClaw only after policy and custody are explicit.'],
]

const PROOF_POINTS = [
  ['Execution surface', 'One command-driven terminal from landing through launch.'],
  ['Wallet model', 'Treasury first, trading second, automation last.'],
  ['Capital thesis', 'Swarm research exists to improve ROI, not decorate the product.'],
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
      title="Clerk is not configured for this app instance."
      description="Add the Clerk publishable and secret keys for the authenticated app before running the private operator flow."
      asideTitle="Private entry depends on authenticated custody."
    >
      <AuthFallback>
        <p className="auth-unavailable-copy">
          The sign-in surface cannot boot until the Clerk environment is present for this app.
        </p>
      </AuthFallback>
    </AuthShell>
  )
}

export function AuthShell({
  mode,
  title,
  description,
  asideTitle,
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
              <div className="auth-brand-sub">private operator entry for graph-native prediction market trading</div>
            </div>
            <nav className="auth-nav" aria-label="Authentication routes">
              <Link className="auth-nav-link" href="/sign-in">Sign in</Link>
              <Link className="auth-nav-link" href="/sign-up">Sign up</Link>
              <a className="auth-nav-link" href={marketingOrigin}>Overview</a>
            </nav>
          </header>

          <main className="auth-grid">
            <section className="auth-manifesto auth-reveal" data-step="1">
              <div className="auth-kicker-row">
                <span className="auth-mini-kicker">{mode}</span>
                <span className="auth-chip">Polygon-first</span>
                <span className="auth-chip">Passkey custody</span>
              </div>
              <h1 className="auth-title">{title}</h1>
              <p className="auth-copy">{description}</p>

              <div className="auth-proof-grid">
                {PROOF_POINTS.map(([label, copy], index) => (
                  <article className="auth-proof-card auth-reveal" data-step={String(index + 2)} key={label}>
                    <div className="auth-proof-label">{label}</div>
                    <p>{copy}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="auth-stage auth-reveal" data-step="3">
              <div className="auth-stage-rail">
                <div className="auth-route-card">
                  <div className="auth-route-head">
                    <span className="auth-card-kicker">Setup route</span>
                    <span className="auth-route-head-r">/setup</span>
                  </div>
                  <h2 className="auth-route-title">{asideTitle}</h2>
                  <div className="auth-route-list">
                    {SETUP_FLOW.map(([index, label, copy]) => (
                      <div className="auth-route-item" key={index}>
                        <span className="auth-step-index">{index}</span>
                        <div className="auth-route-body">
                          <strong>{label}</strong>
                          <span>{copy}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="auth-card-wrap">{children}</div>
            </section>
          </main>

          <footer className="auth-footer-note">
            <span>MiroShark design system: blue-command brutalism, financial density, swarm theater.</span>
            <span>Auth, setup, and terminal use the same scene and grammar.</span>
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
