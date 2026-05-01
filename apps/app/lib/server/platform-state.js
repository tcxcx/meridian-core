import { DEFAULT_OPERATOR_STATE, readOperatorState, writeOperatorState } from '@repo/database'

import { readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

function normalizeKey(userId) {
  return String(userId || 'local-owner').trim() || 'local-owner'
}

export async function readPlatformState() {
  return {
    users: {},
    updatedAt: null,
  }
}

export async function readUserPlatformState(userId) {
  const key = normalizeKey(userId)
  const state = await readOperatorState(key)
  return {
    ...DEFAULT_OPERATOR_STATE,
    ...state,
    userId: key,
  }
}

export async function writeUserPlatformState(userId, nextState) {
  const key = normalizeKey(userId)
  return writeOperatorState(key, {
    ...nextState,
    userId: key,
  })
}

export async function synchronizeUserPlatformState(userId, nextState = {}) {
  const key = normalizeKey(userId)
  const previous = await readUserPlatformState(key)
  const [walletTopology, treasuryWallet] = await Promise.all([
    resolveWalletTopology(),
    readTreasuryWalletState(),
  ])

  const workspaceBootstrapped = Boolean(
    nextState?.setup?.workspaceBootstrapped ??
    previous.setup?.workspaceBootstrapped,
  )
  const collaborationReady = Boolean(
    nextState?.setup?.collaborationReady ??
    nextState?.workspace?.liveblocksRoom ??
    previous.setup?.collaborationReady ??
    previous.workspace?.liveblocksRoom,
  )
  const openclawReady = Boolean(
    nextState?.setup?.openclawReady ??
    previous.setup?.openclawReady,
  )
  const treasuryProvisioned = Boolean(treasuryWallet?.walletAddress)
  const tradingWalletReady = Boolean(walletTopology.agent.address)
  const currentStep = String(
    nextState?.setup?.currentStep ??
    previous.setup?.currentStep ??
    'workspace',
  ).trim() || 'workspace'
  const completed = Boolean(
    workspaceBootstrapped &&
    treasuryProvisioned &&
    tradingWalletReady &&
    collaborationReady
  )

  return writeUserPlatformState(key, {
    ...nextState,
    profile: {
      ...previous.profile,
      ...nextState.profile,
    },
    workspace: {
      ...previous.workspace,
      ...nextState.workspace,
    },
    setup: {
      ...previous.setup,
      ...nextState.setup,
      workspaceBootstrapped,
      treasuryProvisioned,
      tradingWalletReady,
      collaborationReady,
      openclawReady,
      currentStep,
      completed,
    },
    wallets: {
      ...previous.wallets,
      ...nextState.wallets,
      treasuryAddress: walletTopology.treasury.address,
      tradingAddress: walletTopology.agent.address,
      treasuryFundingMode: walletTopology.treasury.fundingMode,
      agentIdentity: {
        ...DEFAULT_OPERATOR_STATE.wallets.agentIdentity,
        ...(previous.wallets?.agentIdentity || {}),
        ...(nextState.wallets?.agentIdentity || {}),
        agentWalletAddress:
          nextState.wallets?.agentIdentity?.agentWalletAddress ||
          previous.wallets?.agentIdentity?.agentWalletAddress ||
          walletTopology.agent.address,
      },
    },
  })
}
