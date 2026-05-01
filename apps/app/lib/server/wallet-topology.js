import { privateKeyToAccount } from 'viem/accounts'

import { readTreasuryWalletState } from '@/lib/server/treasury-state'

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

function deriveAddressFromPrivateKey(...names) {
  const key = envValue(...names)
  if (!key) return null
  try {
    return privateKeyToAccount(key).address
  } catch {
    return null
  }
}

export function resolveAgentWalletAddress() {
  return (
    envValue('MIROSHARK_AGENT_WALLET_ADDRESS', 'TRADING_WALLET_ADDRESS') ||
    deriveAddressFromPrivateKey('TRADING_WALLET_PRIVATE_KEY', 'GATEWAY_SIGNER_PRIVATE_KEY') ||
    null
  )
}

export async function resolveWalletTopology() {
  const walletState = await readTreasuryWalletState()
  const modularAddress = walletState?.walletAddress?.trim() || null
  const explicitTreasuryAddress = envValue('MIROSHARK_TREASURY_WALLET_ADDRESS', 'TREASURY_ADDRESS') || null
  const signerTreasuryAddress =
    envValue('TREASURY_VIEM_ADDRESS') ||
    deriveAddressFromPrivateKey('TREASURY_PRIVATE_KEY') ||
    null
  const legacyCircleTreasuryAddress = envValue('CIRCLE_TREASURY_ADDRESS') || null
  const agentWalletAddress = resolveAgentWalletAddress()

  const treasuryAddress =
    modularAddress ||
    explicitTreasuryAddress ||
    signerTreasuryAddress ||
    legacyCircleTreasuryAddress ||
    null

  const fundingMode = modularAddress
    ? 'polygon-modular'
    : explicitTreasuryAddress || signerTreasuryAddress
      ? 'polygon-direct'
      : legacyCircleTreasuryAddress
        ? 'legacy-circle'
        : 'unconfigured'

  const sharedWithTrading =
    Boolean(treasuryAddress) &&
    Boolean(agentWalletAddress) &&
    treasuryAddress.toLowerCase() === agentWalletAddress.toLowerCase()

  return {
    treasury: {
      address: treasuryAddress,
      modularAddress,
      explicitAddress: explicitTreasuryAddress,
      signerAddress: signerTreasuryAddress,
      legacyCircleAddress:
        legacyCircleTreasuryAddress && legacyCircleTreasuryAddress !== treasuryAddress
          ? legacyCircleTreasuryAddress
          : null,
      fundingMode,
      sharedWithTrading,
    },
    agent: {
      address: agentWalletAddress,
    },
    walletState,
  }
}
