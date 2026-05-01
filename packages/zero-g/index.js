export const sponsor = 'zero-g'

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

export function getZeroGIdentityWalletAddress() {
  const explicit = envValue(
    'ZG_IDENTITY_ADDRESS',
    'ZG_WALLET_ADDRESS',
    'TREASURY_VIEM_ADDRESS',
    'MIROSHARK_AGENT_WALLET_ADDRESS',
  )
  if (explicit) return explicit
  return ''
}

export function getZeroGExplorerUrl(address) {
  const normalized = String(address || '').trim()
  if (!normalized) return ''
  return `https://chainscan-galileo.0g.ai/address/${normalized}`
}

export function buildZeroGAgentIdentity({ agentWalletAddress, ownerEmail, label }) {
  const identityAddress = getZeroGIdentityWalletAddress()
  const walletSuffix = String(agentWalletAddress || '').replace(/^0x/i, '').slice(-8).toLowerCase()
  const ownerSlug = String(ownerEmail || 'operator')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 18) || 'operator'
  const identityId = `0g-agent:${ownerSlug}:${walletSuffix || 'pending'}`
  return {
    provider: '0g',
    identityId,
    label: label || `MiroShark Agent ${walletSuffix ? walletSuffix.toUpperCase() : 'PENDING'}`,
    identityAddress,
    agentWalletAddress: agentWalletAddress || '',
    ownerEmail: ownerEmail || '',
    explorerUrl: getZeroGExplorerUrl(identityAddress),
  }
}
