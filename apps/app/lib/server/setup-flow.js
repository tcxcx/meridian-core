import { persistenceMode } from '@repo/database'
import { readOpenClawState, summarizeOpenClawState } from '@repo/openclaw'

import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'
import { readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const SETUP_STEP_ORDER = ['workspace', 'treasury', 'trading', 'openclaw', 'launch']

export function isValidSetupStep(step) {
  return SETUP_STEP_ORDER.includes(step)
}

export function getSetupStepIndex(step) {
  return Math.max(SETUP_STEP_ORDER.indexOf(step), 0)
}

export function resolveRecommendedSetupStep({
  workspaceBootstrapped,
  treasuryProvisioned,
  tradingWalletReady,
  openclawReady,
}) {
  if (!workspaceBootstrapped) return 'workspace'
  if (!treasuryProvisioned) return 'treasury'
  if (!tradingWalletReady) return 'trading'
  if (!openclawReady) return 'openclaw'
  return 'launch'
}

export function isSetupStepAccessible(requestedStep, recommendedStep) {
  return getSetupStepIndex(requestedStep) <= getSetupStepIndex(recommendedStep)
}

export async function readSetupViewData() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return {
      authenticated: false,
      actor,
    }
  }

  const [platformState, walletTopology, treasuryWallet, openclawState] = await Promise.all([
    synchronizeUserPlatformState(actor.userId),
    resolveWalletTopology(),
    readTreasuryWalletState(),
    readOpenClawState(actor.userId),
  ])

  const treasuryProvisioned = Boolean(treasuryWallet?.walletAddress)
  const tradingWalletReady = Boolean(walletTopology.agent.address)
  const collaborationReady = Boolean(platformState.workspace?.liveblocksRoom)
  const workspaceBootstrapped = Boolean(platformState.setup?.workspaceBootstrapped)
  const openclawReady = Boolean(openclawState?.connected)
  const recommendedStep = resolveRecommendedSetupStep({
    workspaceBootstrapped,
    treasuryProvisioned,
    tradingWalletReady,
    openclawReady,
  })
  const completed = Boolean(
    workspaceBootstrapped &&
    treasuryProvisioned &&
    tradingWalletReady &&
    collaborationReady &&
    openclawReady
  )
  const currentStep = isValidSetupStep(platformState.setup?.currentStep)
    ? platformState.setup.currentStep
    : recommendedStep

  return {
    authenticated: true,
    actor: {
      userId: actor.userId,
      email: actor.email,
      displayName: actor.displayName,
      authEnabled: actor.session.enabled,
    },
    workspace: platformState.workspace,
    setup: {
      ...platformState.setup,
      workspaceBootstrapped,
      treasuryProvisioned,
      tradingWalletReady,
      collaborationReady,
      openclawReady,
      completed,
      currentStep,
      recommendedStep,
    },
    wallets: {
      treasury: walletTopology.treasury,
      trading: walletTopology.agent,
    },
    persistence: {
      mode: persistenceMode,
      auth: actor.session.enabled ? 'clerk' : 'local',
    },
    automation: {
      openclaw: summarizeOpenClawState(openclawState),
    },
  }
}
