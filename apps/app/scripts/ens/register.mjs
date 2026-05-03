#!/usr/bin/env node
/**
 * Register MiroShark ENS subnames on Sepolia.
 *
 * What it does:
 *   1. Reads MIROSHARK_PARENT_ENS_NAME (default `miroshark.eth`).
 *   2. Connects to Sepolia via SEPOLIA_RPC_URL (default publicnode).
 *   3. Loads the registrar signer from ENS_REGISTRAR_PRIVATE_KEY (or falls
 *      back to TREASURY_PRIVATE_KEY).
 *   4. Verifies the signer owns the parent name (Registry OR NameWrapper).
 *      If not owned, prints clear instructions and exits — DOES NOT brick.
 *   5. Mints 3 subnames + 1 agent name with the conventional MiroShark
 *      records:
 *        - xt1sgi73.<parent>     → trading wallet, agent text records
 *        - fund-a.<parent>       → tenant routing for FUND-A
 *        - fund-b.<parent>       → tenant routing for FUND-B
 *      Skips any subname already pointing at the right address (idempotent).
 *
 * Flags:
 *   --dry-run        — print what would happen, send zero txs
 *   --skip-records   — register subnames only, don't set text records
 *   --parent <name>  — override MIROSHARK_PARENT_ENS_NAME for this run
 *
 * Sepolia ENS deployment (canonical, from https://docs.ens.domains/learn/deployments):
 *   ENSRegistry      0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
 *   PublicResolver   0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5
 *   NameWrapper      0x0635513f179D50A207757E05759CbD106d7dFcE8
 *
 * Faucet for Sepolia ETH: https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import {
  createPublicClient,
  createWalletClient,
  http,
  isAddress,
  encodePacked,
  keccak256,
  zeroAddress,
} from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash, normalize } from 'viem/ens'

// Load env from apps/app/.env.local
const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolvePath(here, '../../.env.local') })
config({ path: resolvePath(here, '../../../../.env'), override: false })

const ENS_SEPOLIA = {
  registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  publicResolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
  nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
}

// MiroShark text-record convention. agentEnsName / tenantEnsName in
// packages/ens/index.js mirror these keys exactly.
const RECORDS = {
  xt1sgi73: {
    description: 'MiroShark autonomous Polymarket Trader (Pinata Cloud xt1sgi73)',
    'agent.template': 'Polymarket Trader',
    'agent.runtime': 'Pinata Cloud',
    'agent.skills': 'probe · swarm · open · settle',
    'org.telegram': '@miro_shark_bot',
    url: 'https://miro-shark.com',
    'miroshark.role': 'autonomous-trader',
  },
  'fund-a': {
    description: 'MiroShark FUND-A — tenant trading wallet',
    'miroshark.role': 'tenant-trading-wallet',
    'miroshark.tenant': 'fund-a',
    'org.telegram': '@miro_shark_bot',
  },
  'fund-b': {
    description: 'MiroShark FUND-B — tenant trading wallet',
    'miroshark.role': 'tenant-trading-wallet',
    'miroshark.tenant': 'fund-b',
    'org.telegram': '@miro_shark_bot',
  },
}

// Minimal ABI fragments — only the calls we use.
const REGISTRY_ABI = [
  { name: 'owner', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }] },
  { name: 'resolver', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }] },
  { name: 'setSubnodeRecord', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'label', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'ttl', type: 'uint64' },
    ], outputs: [] },
]

const NAME_WRAPPER_ABI = [
  { name: 'ownerOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'id', type: 'uint256' }],
    outputs: [{ name: '', type: 'address' }] },
  { name: 'setSubnodeRecord', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'parentNode', type: 'bytes32' },
      { name: 'label', type: 'string' },
      { name: 'owner', type: 'address' },
      { name: 'resolver', type: 'address' },
      { name: 'ttl', type: 'uint64' },
      { name: 'fuses', type: 'uint32' },
      { name: 'expiry', type: 'uint64' },
    ], outputs: [{ name: 'node', type: 'bytes32' }] },
]

const RESOLVER_ABI = [
  { name: 'addr', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'node', type: 'bytes32' }],
    outputs: [{ name: '', type: 'address' }] },
  { name: 'setAddr', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'a', type: 'address' },
    ], outputs: [] },
  { name: 'text', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
    ], outputs: [{ name: '', type: 'string' }] },
  { name: 'setText', type: 'function', stateMutability: 'nonpayable',
    inputs: [
      { name: 'node', type: 'bytes32' },
      { name: 'key', type: 'string' },
      { name: 'value', type: 'string' },
    ], outputs: [] },
]

function labelhash(label) {
  return keccak256(new TextEncoder().encode(label))
}

function parseArgs(argv) {
  const out = { dryRun: false, skipRecords: false, parent: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') out.dryRun = true
    else if (argv[i] === '--skip-records') out.skipRecords = true
    else if (argv[i] === '--parent') { out.parent = argv[++i] }
  }
  return out
}

function fail(msg) {
  console.error(`\n✗ ${msg}\n`)
  process.exit(1)
}

function info(msg) { console.log(`  ${msg}`) }
function step(msg) { console.log(`\n▸ ${msg}`) }

async function main() {
  const args = parseArgs(process.argv.slice(2))

  step('Config')
  const parent = normalize(args.parent || process.env.MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth')
  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.ENS_SEPOLIA_RPC || 'https://ethereum-sepolia.publicnode.com'
  const pkRaw = (process.env.ENS_REGISTRAR_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY || '').trim()

  info(`parent name:    ${parent}`)
  info(`rpc:            ${rpcUrl}`)
  info(`dry-run:        ${args.dryRun}`)
  info(`skip-records:   ${args.skipRecords}`)

  if (!pkRaw) fail('Set ENS_REGISTRAR_PRIVATE_KEY (or TREASURY_PRIVATE_KEY) in apps/app/.env.local — needs Sepolia ETH for gas.')

  const pk = pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`
  const account = privateKeyToAccount(pk)
  info(`signer:         ${account.address}`)

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ chain: sepolia, account, transport: http(rpcUrl) })

  step('Signer balance')
  const balance = await publicClient.getBalance({ address: account.address })
  const balanceEth = Number(balance) / 1e18
  info(`balance:        ${balanceEth.toFixed(6)} ETH`)
  if (!args.dryRun && balanceEth < 0.005) {
    fail(`Signer has < 0.005 Sepolia ETH. Top up at https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia and re-run.`)
  }

  step('Verify parent ownership')
  const parentNode = namehash(parent)
  info(`parent namehash: ${parentNode}`)

  const registryOwner = await publicClient.readContract({
    address: ENS_SEPOLIA.registry,
    abi: REGISTRY_ABI,
    functionName: 'owner',
    args: [parentNode],
  })
  info(`registry owner:  ${registryOwner}`)

  const wrapped = registryOwner.toLowerCase() === ENS_SEPOLIA.nameWrapper.toLowerCase()
  let parentOwner = registryOwner

  if (wrapped) {
    info('parent is wrapped — checking NameWrapper for true owner')
    const wrappedOwner = await publicClient.readContract({
      address: ENS_SEPOLIA.nameWrapper,
      abi: NAME_WRAPPER_ABI,
      functionName: 'ownerOf',
      args: [BigInt(parentNode)],
    })
    info(`wrapper owner:   ${wrappedOwner}`)
    parentOwner = wrappedOwner
  }

  if (parentOwner.toLowerCase() === zeroAddress.toLowerCase()) {
    console.log(`
  ✗ Parent name "${parent}" is NOT registered on Sepolia.

  To register it:
    1. Visit https://app.ens.domains/${parent}
    2. Connect this wallet (${account.address}) and switch to Sepolia
    3. Register for 1+ year (testnet ETH funded)
    4. Re-run this script

  Alternative: set MIROSHARK_PARENT_ENS_NAME to a name you already own.
`)
    process.exit(2)
  }

  if (parentOwner.toLowerCase() !== account.address.toLowerCase()) {
    console.log(`
  ✗ Parent name "${parent}" is owned by ${parentOwner}, not the configured signer.

  Either:
    - Use the correct ENS_REGISTRAR_PRIVATE_KEY for the owning wallet, OR
    - Transfer the name to ${account.address} via app.ens.domains, OR
    - Set MIROSHARK_PARENT_ENS_NAME to a name this signer owns.
`)
    process.exit(3)
  }

  info(`✓ signer owns the parent`)

  step('Plan subnames')
  // Subname → (target address, text records). All point at the signer for the
  // demo; in prod you'd point each at the corresponding wallet (agent EOA,
  // FUND-A trading EOA, etc).
  const tradingAddress = process.env.TRADING_WALLET_ADDRESS
    || process.env.MIROSHARK_TRADING_ADDRESS
    || account.address
  const fundAAddress = process.env.MIROSHARK_TENANT_ADDRESS_FUND_A || tradingAddress
  const fundBAddress = process.env.MIROSHARK_TENANT_ADDRESS_FUND_B || tradingAddress

  const subnames = [
    { label: 'xt1sgi73', target: tradingAddress, records: RECORDS.xt1sgi73 },
    { label: 'fund-a',   target: fundAAddress,   records: RECORDS['fund-a'] },
    { label: 'fund-b',   target: fundBAddress,   records: RECORDS['fund-b'] },
  ]

  for (const s of subnames) {
    info(`${s.label}.${parent} → ${s.target}`)
  }

  if (args.dryRun) {
    console.log('\n▸ DRY RUN — exiting without sending any tx.\n')
    return
  }

  for (const s of subnames) {
    step(`Subname: ${s.label}.${parent}`)
    const fullName = `${s.label}.${parent}`
    const subNode = namehash(fullName)
    const subLabelHash = labelhash(s.label)

    // Already registered to the right address?
    let currentResolver = '0x0000000000000000000000000000000000000000'
    try {
      currentResolver = await publicClient.readContract({
        address: ENS_SEPOLIA.registry,
        abi: REGISTRY_ABI,
        functionName: 'resolver',
        args: [subNode],
      })
    } catch (_) { /* doesn't exist yet */ }

    const subOwner = await publicClient.readContract({
      address: ENS_SEPOLIA.registry,
      abi: REGISTRY_ABI,
      functionName: 'owner',
      args: [subNode],
    })

    let needCreate = subOwner.toLowerCase() === zeroAddress.toLowerCase()
    info(`existing owner:    ${subOwner}`)
    info(`existing resolver: ${currentResolver}`)

    if (needCreate) {
      step(`  → setSubnodeRecord (creates ${fullName} pointing to PublicResolver)`)
      let txHash
      if (wrapped) {
        // NameWrapper path. Fuses=0 (no restrictions), expiry=0 (inherit parent expiry).
        txHash = await walletClient.writeContract({
          address: ENS_SEPOLIA.nameWrapper,
          abi: NAME_WRAPPER_ABI,
          functionName: 'setSubnodeRecord',
          args: [parentNode, s.label, account.address, ENS_SEPOLIA.publicResolver, 0n, 0, 0n],
        })
      } else {
        txHash = await walletClient.writeContract({
          address: ENS_SEPOLIA.registry,
          abi: REGISTRY_ABI,
          functionName: 'setSubnodeRecord',
          args: [parentNode, subLabelHash, account.address, ENS_SEPOLIA.publicResolver, 0n],
        })
      }
      info(`tx: ${txHash}`)
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      info(`✓ created`)
    } else {
      info(`✓ already exists`)
    }

    // Set address record
    let currentAddr = zeroAddress
    try {
      currentAddr = await publicClient.readContract({
        address: ENS_SEPOLIA.publicResolver,
        abi: RESOLVER_ABI,
        functionName: 'addr',
        args: [subNode],
      })
    } catch (_) {}

    if (currentAddr.toLowerCase() !== s.target.toLowerCase()) {
      step(`  → setAddr ${currentAddr} → ${s.target}`)
      const txHash = await walletClient.writeContract({
        address: ENS_SEPOLIA.publicResolver,
        abi: RESOLVER_ABI,
        functionName: 'setAddr',
        args: [subNode, s.target],
      })
      info(`tx: ${txHash}`)
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      info(`✓ address set`)
    } else {
      info(`✓ address already correct`)
    }

    // Text records
    if (args.skipRecords) {
      info('skipping text records (--skip-records)')
      continue
    }
    for (const [key, value] of Object.entries(s.records)) {
      let current = ''
      try {
        current = await publicClient.readContract({
          address: ENS_SEPOLIA.publicResolver,
          abi: RESOLVER_ABI,
          functionName: 'text',
          args: [subNode, key],
        })
      } catch (_) {}

      if (current === value) {
        info(`  ${key}: ✓ already set`)
        continue
      }

      step(`  → setText ${key} = "${value.slice(0, 50)}${value.length > 50 ? '…' : ''}"`)
      const txHash = await walletClient.writeContract({
        address: ENS_SEPOLIA.publicResolver,
        abi: RESOLVER_ABI,
        functionName: 'setText',
        args: [subNode, key, value],
      })
      info(`tx: ${txHash}`)
      await publicClient.waitForTransactionReceipt({ hash: txHash })
    }
  }

  step('Summary')
  for (const s of subnames) {
    console.log(`  ${s.label}.${parent} → ${s.target}`)
    console.log(`    https://sepolia.app.ens.domains/${s.label}.${parent}`)
  }

  console.log(`
  ✓ Done. Verify in the operator terminal:
    1. Set in apps/app/.env.local:
       ENS_NETWORK=sepolia
       MIROSHARK_AGENT_ENS=xt1sgi73.${parent}
       MIROSHARK_TENANT_ENS_FUND_A=fund-a.${parent}
       MIROSHARK_TENANT_ENS_FUND_B=fund-b.${parent}
    2. bun dev --filter app
    3. Open the AGENT panel → header shows "AGENT · xt1sgi73.${parent}"
    4. curl http://localhost:3000/api/ens/resolve?name=xt1sgi73.${parent}
       → returns address + text records
`)
}

main().catch((e) => {
  console.error('\n✗ Failed:', e?.message || e)
  if (e?.cause) console.error('cause:', e.cause)
  process.exit(1)
})
