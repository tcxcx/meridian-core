import 'server-only'

/**
 * Circle Developer-Controlled Wallets provisioner.
 *
 * Custodial alternative to BURNER_SEED-derived per-fund wallets. When
 * CIRCLE_API_KEY + ENTITY_SECRET are set, /api/funds creates a fresh
 * Circle-managed wallet per fund. Address goes into the ENS subname; the
 * wallet ID is persisted on miroshark_fund so the operator can resolve it
 * back to the Circle dashboard.
 *
 * Per-position burner derivation in services/execution_router/burner.py
 * keeps the seed-based path for ephemeral signing — those wallets only
 * exist for ~minutes per trade. Migrating burners to Circle is a Phase 2
 * concern (cost: per-tx Circle execute call vs. local sign).
 *
 * Skill alignment (from /use-smart-contract-platform):
 *   - Idempotency keys are crypto.randomUUID() v4 — required by Circle SCP
 *   - Default network = ETH-SEPOLIA (testnet); ENV gates mainnet
 *   - All secrets read from process.env, never logged
 *   - Wallet creation is async — Circle queues + returns wallet rows; we use
 *     the .data.wallets[0] address synchronously since EVM EOA addresses are
 *     deterministic from the wallet's pubkey (no on-chain registration)
 */
import { randomUUID } from 'node:crypto'

let _client = null

function getClient() {
  if (_client) return _client
  const apiKey = (process.env.CIRCLE_API_KEY || '').trim()
  // Accept both ENTITY_SECRET (Circle skill default) and CIRCLE_ENTITY_SECRET
  // (the convention sendero/desk-v1 use across the wider tcxcx codebase).
  const entitySecret = (
    process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET || ''
  ).trim()
  if (!apiKey || !entitySecret) return null
  // Lazy-import so the route doesn't pull the SDK in dev when Circle isn't configured.
  // eslint-disable-next-line global-require
  const { initiateDeveloperControlledWalletsClient } = require('@circle-fin/developer-controlled-wallets')
  _client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret })
  return _client
}

/**
 * @returns {boolean} true if Circle DCW is configured + enabled (env present).
 */
export function isCircleDcwConfigured() {
  return Boolean(getClient())
}

/**
 * Default blockchain for new wallets. The address is the same EOA hex string
 * across all EVM chains — Circle just needs a primary blockchain to track
 * the wallet under. ETH-SEPOLIA matches our ENS network.
 */
function defaultBlockchain() {
  return (process.env.CIRCLE_DEFAULT_BLOCKCHAIN || 'ETH-SEPOLIA').toUpperCase()
}

/**
 * Create (or reuse) a wallet set. One set per owner is fine; reusing keeps
 * the Circle dashboard tidy. Pass a stable name like `miroshark-{ownerUserId}`.
 */
export async function ensureWalletSet({ name }) {
  const client = getClient()
  if (!client) throw new Error('Circle DCW not configured')
  const idempotencyKey = randomUUID()
  // Circle treats POST /developer/walletSets with a stable name + new
  // idempotency key as create-or-fail. We swallow duplicates and look up.
  try {
    const res = await client.createWalletSet({ name, idempotencyKey })
    return res?.data?.walletSet
  } catch (err) {
    // On duplicate: list + match by name.
    const list = await client.listWalletSets({ pageSize: 50 })
    const found = (list?.data?.walletSets || []).find((ws) => ws.name === name)
    if (found) return found
    throw err
  }
}

/**
 * Create a new wallet under the given wallet set.
 * Returns { id, address, blockchain, walletSetId, accountType }.
 */
export async function createWallet({ walletSetId, blockchain = null, accountType = 'EOA', name = null }) {
  const client = getClient()
  if (!client) throw new Error('Circle DCW not configured')
  const blockchains = [blockchain || defaultBlockchain()]
  const res = await client.createWallets({
    walletSetId,
    blockchains,
    count: 1,
    accountType,
    idempotencyKey: randomUUID(),
    ...(name ? { name } : {}),
  })
  const wallet = res?.data?.wallets?.[0]
  if (!wallet?.address) throw new Error('Circle createWallets returned no address')
  return {
    id: wallet.id,
    address: wallet.address,
    blockchain: wallet.blockchain,
    walletSetId: wallet.walletSetId,
    accountType: wallet.accountType,
  }
}

/**
 * Convenience: provision a fund's pair of wallets (treasury + trading) under
 * a single wallet set. Returns both wallets + the set id.
 */
export async function provisionFundWallets({ ownerUserId, label, displayName }) {
  const setName = `miroshark-${ownerUserId}`
  const walletSet = await ensureWalletSet({ name: setName })
  const trading = await createWallet({
    walletSetId: walletSet.id,
    name: `${label}-trading`,
  })
  // Treasury wallet — created once per owner and reused across funds in
  // future, but for the demo we mint a fresh treasury per fund so each fund
  // is self-contained. Comment out and lookup-existing if you want shared.
  const treasury = await createWallet({
    walletSetId: walletSet.id,
    name: `${label}-treasury`,
  })
  return { walletSet, trading, treasury }
}
