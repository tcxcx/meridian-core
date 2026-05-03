import OperatorTerminal from '@/components/miroshark/operator-terminal'
import { getCurrentSession } from '@repo/auth/server'
import { MirosharkMarketingHome } from '@miroshark/ui/marketing-home'
import { redirect } from 'next/navigation'

import { readUserPlatformState } from '@/lib/server/platform-state'
import { readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export default async function Page({ searchParams }) {
  const session = await getCurrentSession()
  const params = await searchParams
  const onboardingMode = String(params?.onboarding || '').trim().toLowerCase() === '1'

  if (session.enabled && !session.userId) {
    return <MirosharkMarketingHome />
  }

  const userId = session.userId || 'local-owner'
  const [platformState, walletTopology, treasuryWallet] = await Promise.all([
    readUserPlatformState(userId),
    resolveWalletTopology(),
    readTreasuryWalletState(),
  ])
  // Setup gate is opt-in via ?onboarding=1 — every signed-in user lands on
  // the operator terminal. The /setup wizard is still reachable directly
  // for users who want to complete the full provisioning flow.
  void platformState; void walletTopology; void treasuryWallet; void onboardingMode

  return <OperatorTerminal />
}
