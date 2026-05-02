import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  keccak256,
  stringToHex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const sponsor = 'zero-g'

export const zeroGGalileo = {
  id: 16602,
  name: '0G Galileo Testnet',
  nativeCurrency: {
    name: 'OG',
    symbol: 'OG',
    decimals: 18,
  },
  rpcUrls: {
    default: {
      http: ['https://evmrpc-testnet.0g.ai'],
    },
  },
  blockExplorers: {
    default: {
      name: '0G Galileo Explorer',
      url: 'https://chainscan-galileo.0g.ai',
    },
  },
  testnet: true,
}

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  return ''
}

export function getZeroGRpcUrl() {
  return envValue('ZG_RPC_URL') || zeroGGalileo.rpcUrls.default.http[0]
}

export function getZeroGIdentityWalletAddress() {
  const explicit = envValue(
    'ZG_IDENTITY_ADDRESS',
    'ZG_WALLET_ADDRESS',
    'MIROSHARK_AGENT_WALLET_ADDRESS',
  )
  if (explicit) return explicit

  const privateKey = envValue('ZG_PRIVATE_KEY')
  if (privateKey) {
    try {
      return privateKeyToAccount(privateKey).address
    } catch {
      return ''
    }
  }

  return envValue('TREASURY_VIEM_ADDRESS')
}

export function getZeroGIdentityStatus(extra = {}) {
  return {
    keyReady: Boolean(envValue('ZG_PRIVATE_KEY')),
    rpcReady: Boolean(envValue('ZG_RPC_URL')),
    indexerReady: Boolean(envValue('ZG_INDEXER_URL')),
    mode: extra.onchain ? 'onchain-anchor' : 'local-proof',
    onchain: Boolean(extra.onchain),
    ...extra,
  }
}

export function getZeroGExplorerUrl(address) {
  const normalized = String(address || '').trim()
  if (!normalized) return ''
  return `https://chainscan-galileo.0g.ai/address/${normalized}`
}

export function getZeroGTransactionUrl(hash) {
  const normalized = String(hash || '').trim()
  if (!normalized) return ''
  return `https://chainscan-galileo.0g.ai/tx/${normalized}`
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
    status: getZeroGIdentityStatus(),
    identityId,
    label: label || `MiroShark Agent ${walletSuffix ? walletSuffix.toUpperCase() : 'PENDING'}`,
    identityAddress,
    agentWalletAddress: agentWalletAddress || '',
    ownerEmail: ownerEmail || '',
    explorerUrl: getZeroGExplorerUrl(identityAddress),
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForZeroGReceipt(publicClient, hash, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null

  while (Date.now() < deadline) {
    try {
      return await publicClient.getTransactionReceipt({ hash })
    } catch (error) {
      lastError = error
      await wait(2_000)
    }
  }

  throw lastError || new Error(`Timed out waiting for 0G transaction receipt ${hash}.`)
}

export async function readZeroGSignerStatus() {
  const privateKey = envValue('ZG_PRIVATE_KEY')
  const rpcUrl = getZeroGRpcUrl()
  if (!privateKey) {
    return {
      ready: false,
      address: '',
      balanceWei: '0',
      balanceOg: '0',
      reason: 'ZG_PRIVATE_KEY is missing.',
    }
  }

  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({
    chain: {
      ...zeroGGalileo,
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  })
  const balance = await publicClient.getBalance({ address: account.address })

  return {
    ready: balance > 0n,
    address: account.address,
    balanceWei: balance.toString(),
    balanceOg: formatEther(balance),
    reason: balance > 0n ? '' : `Fund ${account.address} with 0G Galileo gas before anchoring identity.`,
  }
}

export async function anchorZeroGAgentIdentity({ identity, operatorAddress, note } = {}) {
  const privateKey = envValue('ZG_PRIVATE_KEY')
  if (!privateKey) {
    const error = new Error('ZG_PRIVATE_KEY is required to anchor the 0G agent identity onchain.')
    error.code = 'ZG_PRIVATE_KEY_MISSING'
    throw error
  }

  const rpcUrl = getZeroGRpcUrl()
  const chain = {
    ...zeroGGalileo,
    rpcUrls: { default: { http: [rpcUrl] } },
  }
  const account = privateKeyToAccount(privateKey)
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) })
  const balance = await publicClient.getBalance({ address: account.address })

  if (balance === 0n) {
    const error = new Error(`0G signer ${account.address} has no OG gas on Galileo.`)
    error.code = 'ZG_INSUFFICIENT_GAS'
    error.signerAddress = account.address
    error.balanceOg = formatEther(balance)
    throw error
  }

  const anchoredAt = new Date().toISOString()
  const payload = {
    schema: 'miroshark.agent.identity.v1',
    sponsor,
    chainId: zeroGGalileo.id,
    identityId: identity.identityId,
    label: identity.label,
    agentWalletAddress: identity.agentWalletAddress,
    identityAddress: account.address,
    operatorAddress: operatorAddress || '',
    ownerEmailHash: identity.ownerEmail ? keccak256(stringToHex(identity.ownerEmail.toLowerCase())) : '',
    note: note || '',
    anchoredAt,
  }
  const encodedPayload = JSON.stringify(payload)
  const payloadHash = keccak256(stringToHex(encodedPayload))
  const hash = await walletClient.sendTransaction({
    account,
    chain,
    to: account.address,
    data: stringToHex(`MIROSHARK_0G_AGENT_IDENTITY:${encodedPayload}`),
    value: 0n,
  })
  const receipt = await waitForZeroGReceipt(publicClient, hash)

  return {
    onchain: true,
    mode: 'onchain-anchor',
    chainId: zeroGGalileo.id,
    chainName: zeroGGalileo.name,
    signerAddress: account.address,
    txHash: hash,
    txUrl: getZeroGTransactionUrl(hash),
    blockNumber: receipt.blockNumber?.toString() || '',
    status: receipt.status,
    payloadHash,
    anchoredAt,
  }
}
