#!/usr/bin/env node
/**
 * Pre-flight: print the ENS Sepolia state for the configured parent + signer.
 * Read-only, no txs. Run before `register.mjs` to know what registration
 * will do.
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import { createPublicClient, http, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash, normalize } from 'viem/ens'

const here = dirname(fileURLToPath(import.meta.url))
// Load apps/app/.env.local first (more specific), then repo root .env (overrides false).
config({ path: resolvePath(here, '../../.env.local') })
config({ path: resolvePath(here, '../../../../.env'), override: false })

const REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const NAME_WRAPPER = '0x0635513f179D50A207757E05759CbD106d7dFcE8'
const PUBLIC_RESOLVER = '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5'

const REGISTRY_ABI = [
  { name: 'owner', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
  { name: 'resolver', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
]
const WRAPPER_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }], outputs: [{ name: '', type: 'address' }] },
]
const RESOLVER_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }], outputs: [{ name: '', type: 'address' }] },
]

async function main() {
  const parent = normalize(process.env.MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth')
  const rpcUrl = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com'
  const pk = (process.env.ENS_REGISTRAR_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY || '').trim()

  console.log(`Parent:  ${parent}`)
  console.log(`RPC:     ${rpcUrl}`)

  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const parentNode = namehash(parent)

  let signerAddress = '(no signer configured)'
  let balance = 0n
  if (pk) {
    const acct = privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`)
    signerAddress = acct.address
    balance = await client.getBalance({ address: signerAddress })
  }
  console.log(`Signer:  ${signerAddress}`)
  console.log(`Balance: ${(Number(balance) / 1e18).toFixed(6)} ETH (Sepolia)`)
  console.log('')

  const registryOwner = await client.readContract({
    address: REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [parentNode],
  })
  console.log(`Registry owner of ${parent}:  ${registryOwner}`)

  let trueOwner = registryOwner
  if (registryOwner.toLowerCase() === NAME_WRAPPER.toLowerCase()) {
    trueOwner = await client.readContract({
      address: NAME_WRAPPER, abi: WRAPPER_ABI, functionName: 'ownerOf', args: [BigInt(parentNode)],
    })
    console.log(`Wrapper owner (true):           ${trueOwner}  [name is wrapped]`)
  }

  if (trueOwner.toLowerCase() === zeroAddress.toLowerCase()) {
    console.log(`\n→ ${parent} is NOT registered on Sepolia. Register it via https://app.ens.domains/${parent} first.`)
    return
  }
  if (signerAddress !== '(no signer configured)' && trueOwner.toLowerCase() !== signerAddress.toLowerCase()) {
    console.log(`\n→ ${parent} is owned by ${trueOwner}, not your signer (${signerAddress}). Either transfer ownership or set ENS_REGISTRAR_PRIVATE_KEY to the owner.`)
    return
  }

  console.log(`\n${parent} is owned by your signer ✓`)

  for (const label of ['xt1sgi73', 'fund-a', 'fund-b']) {
    const sub = `${label}.${parent}`
    const subNode = namehash(sub)
    const subOwner = await client.readContract({
      address: REGISTRY, abi: REGISTRY_ABI, functionName: 'owner', args: [subNode],
    })
    let addr = zeroAddress
    try {
      addr = await client.readContract({
        address: PUBLIC_RESOLVER, abi: RESOLVER_ABI, functionName: 'addr', args: [subNode],
      })
    } catch (_) {}
    const status = subOwner.toLowerCase() === zeroAddress.toLowerCase()
      ? '✗ not minted'
      : addr.toLowerCase() === zeroAddress.toLowerCase()
        ? '⚠ minted but no addr'
        : `✓ → ${addr}`
    console.log(`  ${sub.padEnd(36)} ${status}`)
  }

  console.log(`\nRun: node apps/app/scripts/ens/register.mjs --dry-run`)
  console.log(`Then drop the --dry-run flag to actually mint.`)
}

main().catch((e) => {
  console.error('Failed:', e?.message || e)
  process.exit(1)
})
