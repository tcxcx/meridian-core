import OperatorTerminal from '@/components/miroshark/operator-terminal'
import { getCurrentSession } from '@repo/auth/server'
import { redirect } from 'next/navigation'

import { readUserPlatformState } from '@/lib/server/platform-state'
import { readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export default async function Page({ searchParams }) {
  const session = await getCurrentSession()
  const params = await searchParams
  const onboardingMode = String(params?.onboarding || '').trim().toLowerCase() === '1'

  if (session.enabled && !session.userId) {
    return (
      <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: '#08111f', color: '#f5f8ff', padding: 32 }}>
        <section style={{ maxWidth: 640, width: '100%', border: '2px solid #2a5fff', padding: 28, background: '#0e1a30', boxShadow: '14px 14px 0 #12338f' }}>
          <div style={{ fontSize: 12, letterSpacing: '0.18em', textTransform: 'uppercase', color: '#7aa5ff', marginBottom: 12 }}>MiroShark Access</div>
          <h1 style={{ margin: '0 0 12px', fontSize: 'clamp(32px, 5vw, 56px)', lineHeight: 0.96 }}>Sign in to access the operator terminal.</h1>
          <p style={{ margin: '0 0 24px', lineHeight: 1.6, color: '#cbd7ff' }}>
            This platform migration adds authenticated treasury control, collaborative operations, and per-user provisioning on top of the existing MiroShark execution stack.
          </p>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <a href="/sign-in" style={{ background: '#2a5fff', color: '#fff', textDecoration: 'none', fontWeight: 700, padding: '14px 18px' }}>Sign in</a>
            <a href="/sign-up" style={{ border: '2px solid #7aa5ff', color: '#7aa5ff', textDecoration: 'none', fontWeight: 700, padding: '12px 16px' }}>Create account</a>
          </div>
        </section>
      </main>
    )
  }

  const userId = session.userId || 'local-owner'
  const [platformState, walletTopology, treasuryWallet] = await Promise.all([
    readUserPlatformState(userId),
    resolveWalletTopology(),
    readTreasuryWalletState(),
  ])
  const setup = platformState.setup || {}
  const setupComplete = Boolean(
    setup.workspaceBootstrapped
    && (setup.treasuryProvisioned || treasuryWallet?.walletAddress)
    && (setup.tradingWalletReady || walletTopology.agent.address)
    && setup.collaborationReady
  )

  if (!setupComplete && !onboardingMode) {
    redirect('/setup')
  }

  return <OperatorTerminal />
}
