/**
 * Server-side ENS subname minting — used by both the CLI script
 * (apps/app/scripts/ens/register.mjs) and the /api/funds API route.
 *
 * Mint flow per subname (idempotent, skips already-correct steps):
 *   1. setSubnodeRecord — creates the subname + sets resolver
 *   2. setAddr           — points resolver at the target wallet address
 *   3. setText (×N)       — sets each text record (description, agent.skills, ...)
 *
 * On every step we report progress via the optional onProgress callback so the
 * /api/funds endpoint can stream provisioning updates to the AddFundDialog.
 *
 * Idempotency: each step reads current chain state first; only sends a tx if
 * the on-chain value differs. Re-running a fund creation after a partial
 * failure resumes from where it left off without burning gas.
 *
 * Note: no `import 'server-only'` here — this module is also used by CLI
 * scripts (apps/app/scripts/ens/register*.mjs) and one-off Node test runs.
 * Server-only would block those. The signerKey is passed in explicitly per
 * call, so the module never reads user secrets from runtime context.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  zeroAddress,
} from 'viem'
import { sepolia, mainnet } from 'viem/chains'
import { privateKeyToAccount } from 'viem/accounts'
import { namehash, normalize } from 'viem/ens'

const ENS_SEPOLIA = {
  registry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  publicResolver: '0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5',
  nameWrapper: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
}

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

function chainFor(network) {
  return network === 'sepolia' ? sepolia : mainnet
}

function deploymentFor(network) {
  // Mainnet uses identical Registry address but different Wrapper / Resolver.
  // For now this module only fully supports Sepolia (where MiroShark mints).
  // Mainnet support requires checking against the live mainnet deployment table.
  if (network === 'sepolia') return ENS_SEPOLIA
  throw new Error(`mintSubname: network "${network}" not supported yet — only sepolia`)
}

/** Slugify a display name into an ENS-safe label. */
export function slugifyLabel(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')        // strip accents
    .replace(/[^a-z0-9-]+/g, '-')           // any non [a-z0-9-] → hyphen
    .replace(/-{2,}/g, '-')                 // collapse multi-hyphens
    .replace(/^-+|-+$/g, '')                // trim hyphens
    .slice(0, 32)                           // ENS labels practical max
}

/** Connect a viem signer + public client for the given network. */
function buildClients({ rpcUrl, network, signerKey }) {
  const chain = chainFor(network)
  const transport = http(rpcUrl || (network === 'sepolia'
    ? 'https://ethereum-sepolia.publicnode.com'
    : undefined))
  const publicClient = createPublicClient({ chain, transport })
  if (!signerKey) return { publicClient, walletClient: null, account: null }
  const account = privateKeyToAccount(signerKey.startsWith('0x') ? signerKey : `0x${signerKey}`)
  const walletClient = createWalletClient({ chain, account, transport })
  return { publicClient, walletClient, account }
}

/**
 * Mint a single ENS subname under a parent the signer owns.
 *
 * @param {object} args
 * @param {string} args.parent        — full parent name, e.g. "miroshark.eth"
 * @param {string} args.label         — subname label, e.g. "fund-a" (NOT "fund-a.miroshark.eth")
 * @param {string} args.address       — target wallet address for the subname
 * @param {object} args.records       — text records to set, e.g. { description: ..., 'agent.skills': ... }
 * @param {string} args.signerKey     — 0x-prefixed private key that owns the parent
 * @param {string} [args.rpcUrl]      — optional RPC URL override
 * @param {string} [args.network]     — 'sepolia' (default) | 'mainnet'
 * @param {function} [args.onProgress]— called for each step: ({ step, status, txHash?, info? })
 *
 * @returns {Promise<{name, address, steps, alreadyExisted}>}
 */
export async function mintSubname({
  parent,
  label,
  address,
  records = {},
  signerKey,
  rpcUrl,
  network = 'sepolia',
  onProgress,
}) {
  if (!parent || !label || !address || !signerKey) {
    throw new Error('mintSubname: parent + label + address + signerKey are required')
  }
  const deployment = deploymentFor(network)
  const { publicClient, walletClient } = buildClients({ rpcUrl, network, signerKey })
  if (!walletClient) throw new Error('mintSubname: walletClient not built — signerKey missing')

  const fullName = `${label}.${parent}`
  const parentNode = namehash(normalize(parent))
  const subNode = namehash(normalize(fullName))
  const subLabelHash = labelhash(label)

  const steps = []
  const emit = (event) => {
    steps.push({ ...event, ts: Date.now() })
    if (onProgress) {
      try { onProgress(event) } catch (_e) { /* swallow */ }
    }
  }

  // Detect parent ownership shape. If Registry says owner == NameWrapper, we
  // mint via NameWrapper; else direct via Registry. NameWrapper-owned parents
  // are the default for new ENS registrations made via the official UI; the
  // ETHRegistrarController v3 (struct-API) on Sepolia leaves names unwrapped.
  const registryOwner = await publicClient.readContract({
    address: deployment.registry, abi: REGISTRY_ABI,
    functionName: 'owner', args: [parentNode],
  })
  const wrapped = registryOwner.toLowerCase() === deployment.nameWrapper.toLowerCase()

  // Step 1 — create subname (or skip if already created).
  const existingSubOwner = await publicClient.readContract({
    address: deployment.registry, abi: REGISTRY_ABI,
    functionName: 'owner', args: [subNode],
  })
  let alreadyExisted = false
  if (existingSubOwner.toLowerCase() === zeroAddress.toLowerCase()) {
    emit({ step: 'subname.create', status: 'sending', info: { fullName } })
    let txHash
    if (wrapped) {
      txHash = await walletClient.writeContract({
        address: deployment.nameWrapper, abi: NAME_WRAPPER_ABI,
        functionName: 'setSubnodeRecord',
        args: [parentNode, label, walletClient.account.address, deployment.publicResolver, 0n, 0, 0n],
      })
    } else {
      txHash = await walletClient.writeContract({
        address: deployment.registry, abi: REGISTRY_ABI,
        functionName: 'setSubnodeRecord',
        args: [parentNode, subLabelHash, walletClient.account.address, deployment.publicResolver, 0n],
      })
    }
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    emit({ step: 'subname.create', status: 'ok', txHash, info: { fullName } })
  } else {
    alreadyExisted = true
    emit({ step: 'subname.create', status: 'skip', info: { reason: 'already exists' } })
  }

  // Step 2 — set address record (skip if already correct).
  let currentAddr = zeroAddress
  try {
    currentAddr = await publicClient.readContract({
      address: deployment.publicResolver, abi: RESOLVER_ABI,
      functionName: 'addr', args: [subNode],
    })
  } catch (_e) { /* resolver may not be set yet; treat as zero */ }

  if (currentAddr.toLowerCase() !== address.toLowerCase()) {
    emit({ step: 'subname.setAddr', status: 'sending', info: { address } })
    const txHash = await walletClient.writeContract({
      address: deployment.publicResolver, abi: RESOLVER_ABI,
      functionName: 'setAddr', args: [subNode, address],
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    emit({ step: 'subname.setAddr', status: 'ok', txHash, info: { address } })
  } else {
    emit({ step: 'subname.setAddr', status: 'skip', info: { reason: 'already correct' } })
  }

  // Step 3 — text records (one tx per record, skip if already correct).
  for (const [key, value] of Object.entries(records)) {
    let current = ''
    try {
      current = await publicClient.readContract({
        address: deployment.publicResolver, abi: RESOLVER_ABI,
        functionName: 'text', args: [subNode, key],
      })
    } catch (_e) { /* skip */ }
    if (current === value) {
      emit({ step: `subname.text.${key}`, status: 'skip', info: { reason: 'already correct' } })
      continue
    }
    emit({ step: `subname.text.${key}`, status: 'sending', info: { key, value } })
    const txHash = await walletClient.writeContract({
      address: deployment.publicResolver, abi: RESOLVER_ABI,
      functionName: 'setText', args: [subNode, key, value],
    })
    await publicClient.waitForTransactionReceipt({ hash: txHash })
    emit({ step: `subname.text.${key}`, status: 'ok', txHash, info: { key } })
  }

  emit({ step: 'subname.done', status: 'ok', info: { fullName, address } })

  return {
    name: fullName,
    address,
    steps,
    alreadyExisted,
  }
}
