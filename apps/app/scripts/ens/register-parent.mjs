#!/usr/bin/env node
/**
 * Register the MiroShark parent .eth name on Sepolia via ETHRegistrarController
 * v3 commit-reveal flow.
 *
 * Flow:
 *   1. Check name availability + price
 *   2. Compute commitment = makeCommitment(name, owner, duration, secret, ...)
 *   3. Submit commit(commitment) tx
 *   4. Wait MIN_COMMITMENT_AGE (60s on Sepolia)
 *   5. Submit register(...) tx with full price (rentPrice * duration)
 *
 * The registered name is wrapped automatically by ETHRegistrarController v3 →
 * NameWrapper. After this, the signer holds the wrapped name token and can
 * mint subnames via NameWrapper.setSubnodeRecord (which the existing
 * register.mjs handles).
 *
 * Sepolia ENS deployment (canonical, from https://docs.ens.domains/learn/deployments):
 *   ETHRegistrarController     0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968
 *   PublicResolver             0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5
 */
import { config } from 'dotenv'
import { fileURLToPath } from 'node:url'
import { dirname, resolve as resolvePath } from 'node:path'
import {
  createPublicClient, createWalletClient, http, parseEther, toHex,
} from 'viem'
import { sepolia } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { randomBytes } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
config({ path: resolvePath(here, '../../.env.local') })
config({ path: resolvePath(here, '../../../../.env'), override: false })

const CONTROLLER = '0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968'
const PUBLIC_RESOLVER = '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5'

// ETHRegistrarController (Sepolia) — struct-based API.
// Per the deployed contract at 0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968,
// makeCommitment + register take a single Registration struct argument.
const REGISTRATION_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'label',         type: 'string' },
    { name: 'owner',         type: 'address' },
    { name: 'duration',      type: 'uint256' },
    { name: 'secret',        type: 'bytes32' },
    { name: 'resolver',      type: 'address' },
    { name: 'data',          type: 'bytes[]' },
    { name: 'reverseRecord', type: 'uint8' },     // 0 = no reverse, 1 = set reverse
    { name: 'referrer',      type: 'bytes32' },   // zero hash for none
  ],
}

const CONTROLLER_ABI = [
  { name: 'available', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'label', type: 'string' }],
    outputs: [{ name: '', type: 'bool' }] },
  { name: 'rentPrice', type: 'function', stateMutability: 'view',
    inputs: [
      { name: 'label', type: 'string' },
      { name: 'duration', type: 'uint256' },
    ],
    outputs: [
      { name: 'price', type: 'tuple',
        components: [
          { name: 'base', type: 'uint256' },
          { name: 'premium', type: 'uint256' },
        ] },
    ] },
  { name: 'minCommitmentAge', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'maxCommitmentAge', type: 'function', stateMutability: 'view',
    inputs: [], outputs: [{ name: '', type: 'uint256' }] },
  { name: 'makeCommitment', type: 'function', stateMutability: 'pure',
    inputs: [{ name: 'registration', ...REGISTRATION_TUPLE }],
    outputs: [{ name: 'commitment', type: 'bytes32' }] },
  { name: 'commit', type: 'function', stateMutability: 'nonpayable',
    inputs: [{ name: 'commitment', type: 'bytes32' }],
    outputs: [] },
  { name: 'register', type: 'function', stateMutability: 'payable',
    inputs: [{ name: 'registration', ...REGISTRATION_TUPLE }],
    outputs: [] },
]

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000'

function info(msg) { console.log(`  ${msg}`) }
function step(msg) { console.log(`\n▸ ${msg}`) }
function fail(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1) }

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')

  step('Config')
  const fullName = (process.env.MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth').toLowerCase()
  if (!fullName.endsWith('.eth')) fail(`Parent name must end in .eth: got "${fullName}"`)
  const label = fullName.slice(0, -'.eth'.length)
  if (label.includes('.')) fail(`Parent must be a 2LD (no dots in label): got "${fullName}"`)
  const durationYears = Number(process.env.ENS_REGISTER_YEARS || 1)
  const duration = BigInt(Math.floor(durationYears * 365 * 24 * 60 * 60))

  const rpcUrl = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com'
  const pkRaw = (process.env.ENS_REGISTRAR_PRIVATE_KEY || process.env.TREASURY_PRIVATE_KEY || '').trim()
  if (!pkRaw) fail('Set ENS_REGISTRAR_PRIVATE_KEY (or TREASURY_PRIVATE_KEY) in env.')
  const pk = pkRaw.startsWith('0x') ? pkRaw : `0x${pkRaw}`
  const account = privateKeyToAccount(pk)

  info(`name:           ${fullName}`)
  info(`label:          ${label}`)
  info(`duration:       ${durationYears} year(s) (${duration} seconds)`)
  info(`signer:         ${account.address}`)
  info(`rpc:            ${rpcUrl}`)
  info(`controller:     ${CONTROLLER}`)
  info(`resolver:       ${PUBLIC_RESOLVER}`)
  info(`dry-run:        ${dryRun}`)

  const publicClient = createPublicClient({ chain: sepolia, transport: http(rpcUrl) })
  const walletClient = createWalletClient({ chain: sepolia, account, transport: http(rpcUrl) })

  step('Availability + price')
  const available = await publicClient.readContract({
    address: CONTROLLER, abi: CONTROLLER_ABI,
    functionName: 'available', args: [label],
  })
  info(`available:      ${available}`)
  if (!available) fail(`${fullName} is NOT available on Sepolia. Choose a different name (set MIROSHARK_PARENT_ENS_NAME).`)

  const price = await publicClient.readContract({
    address: CONTROLLER, abi: CONTROLLER_ABI,
    functionName: 'rentPrice', args: [label, duration],
  })
  const totalWei = price.base + price.premium
  info(`rent base:      ${price.base} wei`)
  info(`rent premium:   ${price.premium} wei`)
  info(`total:          ${Number(totalWei) / 1e18} ETH`)

  const balance = await publicClient.getBalance({ address: account.address })
  info(`signer balance: ${Number(balance) / 1e18} ETH`)
  if (balance < totalWei + parseEther('0.005')) {
    fail(`Insufficient balance. Need ${Number(totalWei + parseEther('0.005')) / 1e18} ETH (rent + gas buffer).`)
  }

  step('Commit-reveal config')
  const minAge = await publicClient.readContract({
    address: CONTROLLER, abi: CONTROLLER_ABI, functionName: 'minCommitmentAge', args: [],
  })
  const maxAge = await publicClient.readContract({
    address: CONTROLLER, abi: CONTROLLER_ABI, functionName: 'maxCommitmentAge', args: [],
  })
  info(`min age:        ${minAge} seconds`)
  info(`max age:        ${maxAge} seconds`)

  const secret = toHex(randomBytes(32))
  info(`secret:         ${secret.slice(0, 12)}…${secret.slice(-6)}`)

  const owner = account.address
  const resolver = PUBLIC_RESOLVER
  const data = []        // no extra resolver data on initial register
  const reverseRecord = 0  // 0 = don't auto-set reverse; we'll set it later if wanted
  const referrer = ZERO_BYTES32

  const registration = {
    label,
    owner,
    duration,
    secret,
    resolver,
    data,
    reverseRecord,
    referrer,
  }

  const commitment = await publicClient.readContract({
    address: CONTROLLER, abi: CONTROLLER_ABI,
    functionName: 'makeCommitment',
    args: [registration],
  })
  info(`commitment:     ${commitment}`)

  if (dryRun) {
    console.log('\n▸ DRY RUN — would commit then wait then register. Exiting.\n')
    return
  }

  step('Tx 1/2: commit')
  const commitHash = await walletClient.writeContract({
    address: CONTROLLER, abi: CONTROLLER_ABI,
    functionName: 'commit', args: [commitment],
  })
  info(`commit tx: https://sepolia.etherscan.io/tx/${commitHash}`)
  await publicClient.waitForTransactionReceipt({ hash: commitHash })
  info('✓ commit confirmed')

  step(`Wait ${minAge}s for commitment to mature (anti-frontrunning)`)
  // Wait min + small buffer for clock skew between providers.
  const waitMs = Number(minAge) * 1000 + 5000
  let remaining = waitMs
  const tick = 5000
  while (remaining > 0) {
    await new Promise((r) => setTimeout(r, Math.min(tick, remaining)))
    remaining -= tick
    if (remaining > 0) info(`waiting... ${Math.ceil(remaining / 1000)}s remaining`)
  }

  step('Tx 2/2: register')
  // Add 5% buffer to the rent price for any base-fee fluctuation between
  // commit and register (rent is denominated in USD, computed in ETH at
  // current rate, can shift slightly).
  const valueToSend = (totalWei * 105n) / 100n
  info(`value to send:  ${Number(valueToSend) / 1e18} ETH (105% of rent for headroom)`)

  const registerHash = await walletClient.writeContract({
    address: CONTROLLER, abi: CONTROLLER_ABI,
    functionName: 'register',
    args: [registration],
    value: valueToSend,
  })
  info(`register tx: https://sepolia.etherscan.io/tx/${registerHash}`)
  await publicClient.waitForTransactionReceipt({ hash: registerHash })
  info('✓ register confirmed')

  console.log(`\n  ✓ ${fullName} registered for ${durationYears} year(s) on Sepolia.`)
  console.log(`  Wrapped name now owned by ${owner}.`)
  console.log(`  View: https://sepolia.app.ens.domains/${fullName}`)
  console.log(`\n  Next: mint MiroShark subnames + text records:`)
  console.log(`    node apps/app/scripts/ens/register.mjs --dry-run`)
  console.log(`    node apps/app/scripts/ens/register.mjs\n`)
}

main().catch((e) => {
  console.error('\n✗ Failed:', e?.shortMessage || e?.message || e)
  if (e?.cause) console.error('cause:', e.cause)
  process.exit(1)
})
