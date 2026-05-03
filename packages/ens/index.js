/**
 * @repo/ens — ENS identity layer for MiroShark agents.
 *
 * MiroShark agents are autonomous: the swarm runs, the trader opens positions,
 * burner EOAs settle. Without persistent identity they're anonymous addresses
 * in an audit log. ENS gives each one a human-readable handle whose metadata
 * (skills, telegram, capabilities) lives on-chain in text records.
 *
 * Surfaces:
 * - Agent identity:    xt1sgi73.miroshark.eth → trading wallet, skills in text records
 * - Tenant subdomains: fund-a.miroshark.eth, fund-b.miroshark.eth → per-tenant trading EOA
 * - Per-trade names:   pos-{shortid}.miroshark.eth → burner EOA + market metadata
 *
 * Resolution always happens on Eth mainnet (or Sepolia in dev) regardless of
 * which chain the resolved address actually transacts on (Arb Sepolia, Polygon
 * Amoy, etc). ENS is the universal identity plane.
 *
 * The package is read-only by design. Subname registration happens off-band
 * (via the ENS app, scripts, or a future setup wizard) — we only resolve.
 */
import {
  createPublicClient,
  http,
  isAddress,
} from 'viem'
import { mainnet, sepolia } from 'viem/chains'
import { normalize } from 'viem/ens'

export const sponsor = 'ens'

const RESOLVER_TEXT_KEYS = [
  'avatar',
  'description',
  'url',
  'com.twitter',
  'com.github',
  'org.telegram',
  'eth.ens.delegate',
  // MiroShark-specific text records — convention only, not yet ratified.
  'agent.skills',
  'agent.template',
  'agent.runtime',
  'miroshark.tenant',
  'miroshark.role',
]

const _clientCache = new Map()

function clientFor(network) {
  if (_clientCache.has(network)) return _clientCache.get(network)
  const chain = network === 'sepolia' ? sepolia : mainnet
  // Allow override RPC via env (paid tier RPC for production resolution).
  const rpc =
    network === 'sepolia'
      ? process.env.ENS_SEPOLIA_RPC || process.env.SEPOLIA_RPC_URL
      : process.env.ENS_MAINNET_RPC || process.env.MAINNET_RPC_URL
  const transport = rpc ? http(rpc) : http()
  const client = createPublicClient({ chain, transport })
  _clientCache.set(network, client)
  return client
}

function resolveNetwork() {
  return (process.env.ENS_NETWORK || 'mainnet').toLowerCase() === 'sepolia'
    ? 'sepolia'
    : 'mainnet'
}

/** Resolve an ENS name to an address. Returns null if not registered. */
export async function resolveEnsAddress(name, { network } = {}) {
  if (!name || typeof name !== 'string') return null
  const net = network || resolveNetwork()
  try {
    const client = clientFor(net)
    return await client.getEnsAddress({ name: normalize(name) })
  } catch (_e) {
    return null
  }
}

/** Reverse-resolve an address to its primary ENS name. Returns null if no
 *  primary name set or address invalid. */
export async function reverseResolve(address, { network } = {}) {
  if (!isAddress(address)) return null
  const net = network || resolveNetwork()
  try {
    const client = clientFor(net)
    return await client.getEnsName({ address })
  } catch (_e) {
    return null
  }
}

/** Fetch a set of text records for a name. Returns { key: value } map; missing
 *  keys are simply absent. Pass `keys: ['*']` for the MiroShark convention set. */
export async function getTextRecords(name, { keys = ['*'], network } = {}) {
  if (!name) return {}
  const net = network || resolveNetwork()
  const client = clientFor(net)
  const target = keys.length === 1 && keys[0] === '*' ? RESOLVER_TEXT_KEYS : keys
  const out = {}
  await Promise.all(
    target.map(async (key) => {
      try {
        const value = await client.getEnsText({ name: normalize(name), key })
        if (value) out[key] = value
      } catch (_e) { /* skip */ }
    }),
  )
  return out
}

/** Resolve in either direction + pull text records in one shot. */
export async function resolveIdentity({ name, address, network } = {}) {
  const net = network || resolveNetwork()
  let resolvedName = name || null
  let resolvedAddress = address || null

  if (resolvedName && !resolvedAddress) {
    resolvedAddress = await resolveEnsAddress(resolvedName, { network: net })
  }
  if (resolvedAddress && !resolvedName) {
    resolvedName = await reverseResolve(resolvedAddress, { network: net })
  }

  const textRecords = resolvedName
    ? await getTextRecords(resolvedName, { network: net })
    : {}

  return {
    name: resolvedName,
    address: resolvedAddress,
    textRecords,
    network: net,
    resolvedAt: Date.now(),
  }
}

/** Display helper — used by UI to render an address with its ENS name when
 *  known, falling back to a short hex. */
export function formatEnsOrAddress({ address, name, length = 6 } = {}) {
  if (name) return name
  if (!address || typeof address !== 'string') return '—'
  if (address.length <= length * 2 + 3) return address
  return `${address.slice(0, length)}…${address.slice(-4)}`
}

/** Tenant convention: declare via env MIROSHARK_TENANT_ENS_<TENANT_ID_UPPER>,
 *  e.g. MIROSHARK_TENANT_ENS_FUND_A=fund-a.miroshark.eth. */
export function tenantEnsName(tenantId) {
  if (!tenantId) return null
  const envKey = `MIROSHARK_TENANT_ENS_${String(tenantId).toUpperCase().replace(/-/g, '_')}`
  const fromEnv = process.env[envKey]
  if (fromEnv) return fromEnv
  return `${tenantId}.miroshark.eth`
}

/** Agent convention: defaults to MIROSHARK_AGENT_ENS or {agentId}.miroshark.eth. */
export function agentEnsName(agentId) {
  if (process.env.MIROSHARK_AGENT_ENS) return process.env.MIROSHARK_AGENT_ENS
  if (!agentId) return null
  return `${agentId}.miroshark.eth`
}

export const TEXT_KEYS = RESOLVER_TEXT_KEYS
