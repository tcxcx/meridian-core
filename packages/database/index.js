import 'server-only'

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'

const globalForDatabase = globalThis
const ROOT = path.resolve(process.cwd(), '../..')
const STATE_DIR = path.join(ROOT, '.context', 'miroshark')
const FALLBACK_PATH = path.join(STATE_DIR, 'platform-db-fallback.json')
const WAITLIST_FALLBACK_PATH = path.join(STATE_DIR, 'waitlist-fallback.json')
const IV_LENGTH = 12

const DEFAULT_OPERATOR_STATE = Object.freeze({
  profile: {
    email: null,
    displayName: null,
  },
  workspace: {
    slug: 'miroshark-main',
    title: 'MiroShark Main Fund',
    liveblocksRoom: 'miroshark-main:operator',
  },
  setup: {
    currentStep: 'workspace',
    workspaceBootstrapped: false,
    treasuryProvisioned: false,
    tradingWalletReady: false,
    collaborationReady: false,
    openclawReady: false,
    completed: false,
  },
  wallets: {
    treasuryAddress: null,
    tradingAddress: null,
    treasuryFundingMode: 'unconfigured',
    agentIdentity: {
      provider: '0g',
      registered: false,
      identityId: '',
      label: '',
      identityAddress: '',
      agentWalletAddress: '',
      ownerEmail: '',
      note: '',
      explorerUrl: '',
      txHash: '',
      txUrl: '',
      blockNumber: '',
      payloadHash: '',
      status: {},
      registeredAt: null,
      updatedAt: null,
    },
  },
  automation: {
    openclaw: {
      connected: false,
      provider: 'openclaw',
      endpoint: '',
      operatorName: '',
      model: '',
      apiKeyPreview: '',
      manageAgentWallet: true,
      allowTreasuryProvisioning: true,
      notes: '',
      updatedAt: null,
      connectedAt: null,
    },
  },
})

const DEFAULT_WAITLIST_STATE = Object.freeze({
  leads: [],
  updatedAt: null,
})

if (!globalForDatabase.mirosharkPool && process.env.DATABASE_URL) {
  globalForDatabase.mirosharkPool = new Pool({
    connectionString: process.env.DATABASE_URL,
  })
}

export const pool = globalForDatabase.mirosharkPool || null
export const database = pool ? drizzle(pool) : null
export const persistenceMode = pool ? 'database' : 'fallback'

function normalizeUserId(userId) {
  return String(userId || 'local-owner').trim() || 'local-owner'
}

async function ensureDir() {
  await fs.mkdir(STATE_DIR, { recursive: true })
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJson(filePath, value) {
  await ensureDir()
  await fs.writeFile(filePath, JSON.stringify(value, null, 2))
}

function mergeOperatorState(previous = {}, next = {}) {
  return {
    ...DEFAULT_OPERATOR_STATE,
    ...previous,
    ...next,
    profile: {
      ...DEFAULT_OPERATOR_STATE.profile,
      ...(previous.profile || {}),
      ...(next.profile || {}),
    },
    workspace: {
      ...DEFAULT_OPERATOR_STATE.workspace,
      ...(previous.workspace || {}),
      ...(next.workspace || {}),
    },
    setup: {
      ...DEFAULT_OPERATOR_STATE.setup,
      ...(previous.setup || {}),
      ...(next.setup || {}),
    },
    wallets: {
      ...DEFAULT_OPERATOR_STATE.wallets,
      ...(previous.wallets || {}),
      ...(next.wallets || {}),
    },
    automation: {
      ...DEFAULT_OPERATOR_STATE.automation,
      ...(previous.automation || {}),
      ...(next.automation || {}),
      openclaw: {
        ...DEFAULT_OPERATOR_STATE.automation.openclaw,
        ...(previous.automation?.openclaw || {}),
        ...(next.automation?.openclaw || {}),
      },
    },
  }
}

function serializeSecret(value) {
  const secret = String(value || '').trim()
  if (!secret) return null
  const pepper = String(process.env.PLATFORM_SECRET_PEPPER || '').trim()
  if (!pepper) {
    return { mode: 'plain', value: secret }
  }

  const iv = randomBytes(IV_LENGTH)
  const key = createHash('sha256').update(pepper).digest()
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    mode: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    value: ciphertext.toString('base64'),
  }
}

function deserializeSecret(payload) {
  if (!payload) return ''
  if (payload.mode === 'plain') return String(payload.value || '')
  if (payload.mode !== 'aes-256-gcm') return ''
  const pepper = String(process.env.PLATFORM_SECRET_PEPPER || '').trim()
  if (!pepper) return ''
  try {
    const iv = Buffer.from(payload.iv, 'base64')
    const tag = Buffer.from(payload.tag, 'base64')
    const encrypted = Buffer.from(payload.value, 'base64')
    const key = createHash('sha256').update(pepper).digest()
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return plaintext.toString('utf8')
  } catch {
    return ''
  }
}

async function readFallbackState() {
  return readJson(FALLBACK_PATH, {
    operators: {},
    secrets: {},
    updatedAt: null,
  })
}

async function writeFallbackState(state) {
  await writeJson(FALLBACK_PATH, {
    ...state,
    updatedAt: new Date().toISOString(),
  })
}

async function readWaitlistFallback() {
  return readJson(WAITLIST_FALLBACK_PATH, DEFAULT_WAITLIST_STATE)
}

async function writeWaitlistFallback(state) {
  await writeJson(WAITLIST_FALLBACK_PATH, {
    ...DEFAULT_WAITLIST_STATE,
    ...state,
    updatedAt: new Date().toISOString(),
  })
}

async function ensureTables() {
  if (!pool) return
  if (!globalForDatabase.mirosharkTablesPromise) {
    globalForDatabase.mirosharkTablesPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_operator_state (
          user_id TEXT PRIMARY KEY,
          profile JSONB NOT NULL DEFAULT '{}'::jsonb,
          workspace JSONB NOT NULL DEFAULT '{}'::jsonb,
          setup JSONB NOT NULL DEFAULT '{}'::jsonb,
          wallets JSONB NOT NULL DEFAULT '{}'::jsonb,
          automation JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_operator_secret (
          user_id TEXT PRIMARY KEY,
          openclaw JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_waitlist_lead (
          id BIGSERIAL PRIMARY KEY,
          email TEXT NOT NULL,
          full_name TEXT NOT NULL DEFAULT '',
          organization TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          source TEXT NOT NULL DEFAULT 'web',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      // Operator-terminal projection tables. Lean console reads from these
      // on boot; Python services dual-write through services/_shared/db.py
      // on every state change. SSE keeps live in-flight; DB owns history.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_position (
          position_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          market_id TEXT NOT NULL,
          token_id TEXT,
          question TEXT,
          side TEXT NOT NULL,
          outcome TEXT,
          usdc_amount NUMERIC(20, 6) NOT NULL,
          status TEXT NOT NULL,
          strategy TEXT,
          burner_address TEXT,
          fund_tx TEXT,
          bridge_send_burn_tx TEXT,
          bridge_send_mint_tx TEXT,
          clob_order_id TEXT,
          gateway_deposit_tx TEXT,
          bridge_recv_burn_tx TEXT,
          bridge_recv_mint_tx TEXT,
          resolve_tx TEXT,
          settle_tx TEXT,
          payout_usdc NUMERIC(20, 6),
          opened_by TEXT,
          error TEXT,
          extra JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_position_tenant_status_idx
          ON miroshark_position(tenant_id, status, updated_at DESC);
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_position_market_idx
          ON miroshark_position(market_id, updated_at DESC);
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_audit_event (
          id BIGSERIAL PRIMARY KEY,
          position_id TEXT,
          tenant_id TEXT,
          event TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'ok',
          payload JSONB NOT NULL DEFAULT '{}'::jsonb,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_audit_event_position_idx
          ON miroshark_audit_event(position_id, ts);
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_audit_event_tenant_idx
          ON miroshark_audit_event(tenant_id, ts DESC);
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_swarm_run (
          id BIGSERIAL PRIMARY KEY,
          market_id TEXT NOT NULL,
          tenant_id TEXT,
          question TEXT,
          phase TEXT,
          edge JSONB,
          consensus JSONB,
          confidence NUMERIC(8, 6),
          raw_confidence NUMERIC(8, 6),
          agreement_score NUMERIC(8, 6),
          signals JSONB,
          signals_diagnostic JSONB,
          reasoning TEXT,
          key_factors JSONB,
          minority_report JSONB,
          zg_root TEXT,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_swarm_run_market_ts_idx
          ON miroshark_swarm_run(market_id, ts DESC);
      `)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_treasury_transfer (
          transfer_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL DEFAULT 'default',
          amount_usdc NUMERIC(20, 6) NOT NULL,
          chain TEXT,
          threshold INTEGER NOT NULL,
          signers JSONB NOT NULL DEFAULT '[]'::jsonb,
          initiator TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          tx_hash TEXT,
          error TEXT,
          notified BOOLEAN NOT NULL DEFAULT false,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_treasury_transfer_status_idx
          ON miroshark_treasury_transfer(status, created_at DESC);
      `)
      // Per-fund row. Each fund is one tenant with its own trading wallet +
      // ENS subname under the platform parent (miroshark.eth on Sepolia for
      // the demo). Provisioning is multi-step (DB row → addr derive → ENS
      // mint → text records) — `provisioning_steps` is the live JSONB log
      // the AddFundDialog renders during the create flow.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS miroshark_fund (
          tenant_id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          label TEXT NOT NULL,
          display_name TEXT NOT NULL,
          ens_name TEXT,
          ens_alias TEXT,
          treasury_address TEXT,
          trading_address TEXT,
          wallet_provider TEXT NOT NULL DEFAULT 'seed-derived',
          treasury_wallet_id TEXT,
          trading_wallet_id TEXT,
          wallet_set_id TEXT,
          status TEXT NOT NULL DEFAULT 'provisioning',
          provisioning_steps JSONB NOT NULL DEFAULT '[]'::jsonb,
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `)
      await pool.query(`
        CREATE INDEX IF NOT EXISTS miroshark_fund_owner_idx
          ON miroshark_fund(owner_user_id, created_at DESC);
      `)
      await pool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS miroshark_fund_label_idx
          ON miroshark_fund(label);
      `)
    })()
  }
  await globalForDatabase.mirosharkTablesPromise
}

// ─── Operator-terminal read helpers ─────────────────────────────────────
// All require pool. When DATABASE_URL is missing, return safe empty values
// so the lean canvas degrades gracefully (still uses SSE for live data).

function rowToPosition(row) {
  if (!row) return null
  const tsToEpoch = (v) => (v instanceof Date ? Math.floor(v.getTime() / 1000) : v)
  return {
    position_id: row.position_id,
    tenant_id: row.tenant_id,
    market_id: row.market_id,
    token_id: row.token_id,
    question: row.question,
    side: row.side,
    outcome: row.outcome,
    usdc_amount: row.usdc_amount != null ? Number(row.usdc_amount) : null,
    status: row.status,
    strategy: row.strategy,
    burner_address: row.burner_address,
    fund_tx: row.fund_tx,
    bridge_send_burn_tx: row.bridge_send_burn_tx,
    bridge_send_mint_tx: row.bridge_send_mint_tx,
    clob_order_id: row.clob_order_id,
    gateway_deposit_tx: row.gateway_deposit_tx,
    bridge_recv_burn_tx: row.bridge_recv_burn_tx,
    bridge_recv_mint_tx: row.bridge_recv_mint_tx,
    resolve_tx: row.resolve_tx,
    settle_tx: row.settle_tx,
    payout_usdc: row.payout_usdc != null ? Number(row.payout_usdc) : null,
    opened_by: row.opened_by,
    error: row.error,
    extra: row.extra || {},
    created_at: tsToEpoch(row.created_at),
    updated_at: tsToEpoch(row.updated_at),
  }
}

function rowToAudit(row) {
  if (!row) return null
  return {
    id: Number(row.id),
    position_id: row.position_id,
    tenant_id: row.tenant_id,
    event: row.event,
    status: row.status,
    payload: row.payload || {},
    ts: row.ts instanceof Date ? Math.floor(row.ts.getTime() / 1000) : row.ts,
  }
}

export async function listPositions({ tenantId = null, limit = 200 } = {}) {
  if (!pool) return []
  await ensureTables()
  const params = []
  let where = ''
  if (tenantId) { params.push(tenantId); where = 'WHERE tenant_id = $1' }
  params.push(limit)
  const result = await pool.query(
    `SELECT * FROM miroshark_position ${where}
     ORDER BY updated_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return result.rows.map(rowToPosition)
}

export async function getPosition(positionId) {
  if (!pool || !positionId) return null
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_position WHERE position_id = $1`,
    [positionId],
  )
  return rowToPosition(result.rows[0] || null)
}

export async function listAuditByPosition(positionId, { limit = 200 } = {}) {
  if (!pool || !positionId) return []
  await ensureTables()
  const result = await pool.query(
    `SELECT id, position_id, tenant_id, event, status, payload, ts
     FROM miroshark_audit_event
     WHERE position_id = $1
     ORDER BY ts ASC
     LIMIT $2`,
    [positionId, limit],
  )
  return result.rows.map(rowToAudit)
}

export async function recentAuditEvents({ tenantId = null, limit = 20 } = {}) {
  if (!pool) return []
  await ensureTables()
  const params = []
  let where = ''
  if (tenantId) { params.push(tenantId); where = 'WHERE tenant_id = $1' }
  params.push(limit)
  const result = await pool.query(
    `SELECT id, position_id, tenant_id, event, status, payload, ts
     FROM miroshark_audit_event
     ${where}
     ORDER BY ts DESC
     LIMIT $${params.length}`,
    params,
  )
  return result.rows.map(rowToAudit)
}

export async function latestSwarmRun({ marketId } = {}) {
  if (!pool || !marketId) return null
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_swarm_run WHERE market_id = $1
     ORDER BY ts DESC LIMIT 1`,
    [marketId],
  )
  return result.rows[0] || null
}

export async function listSwarmRuns({ marketId = null, limit = 50 } = {}) {
  if (!pool) return []
  await ensureTables()
  const params = []
  let where = ''
  if (marketId) { params.push(marketId); where = 'WHERE market_id = $1' }
  params.push(limit)
  const result = await pool.query(
    `SELECT * FROM miroshark_swarm_run ${where}
     ORDER BY ts DESC LIMIT $${params.length}`,
    params,
  )
  return result.rows
}

export async function getTreasuryTransferDb(transferId) {
  if (!pool || !transferId) return null
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_treasury_transfer WHERE transfer_id = $1`,
    [transferId],
  )
  return result.rows[0] || null
}

// ─── Funds (per-tenant) ────────────────────────────────────────────────
function rowToFund(row) {
  if (!row) return null
  const tsToEpoch = (v) => (v instanceof Date ? Math.floor(v.getTime() / 1000) : v)
  return {
    tenant_id: row.tenant_id,
    owner_user_id: row.owner_user_id,
    label: row.label,
    display_name: row.display_name,
    ens_name: row.ens_name,
    ens_alias: row.ens_alias,
    treasury_address: row.treasury_address,
    trading_address: row.trading_address,
    wallet_provider: row.wallet_provider || 'seed-derived',
    treasury_wallet_id: row.treasury_wallet_id || null,
    trading_wallet_id: row.trading_wallet_id || null,
    wallet_set_id: row.wallet_set_id || null,
    status: row.status,
    provisioning_steps: row.provisioning_steps || [],
    error: row.error,
    created_at: tsToEpoch(row.created_at),
    updated_at: tsToEpoch(row.updated_at),
  }
}

export async function listFunds({ ownerUserId = null, limit = 200 } = {}) {
  if (!pool) return []
  await ensureTables()
  const params = []
  let where = ''
  if (ownerUserId) { params.push(ownerUserId); where = 'WHERE owner_user_id = $1' }
  params.push(limit)
  const result = await pool.query(
    `SELECT * FROM miroshark_fund ${where}
     ORDER BY created_at ASC
     LIMIT $${params.length}`,
    params,
  )
  return result.rows.map(rowToFund)
}

export async function getFund(tenantId) {
  if (!pool || !tenantId) return null
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_fund WHERE tenant_id = $1`,
    [tenantId],
  )
  return rowToFund(result.rows[0] || null)
}

export async function getFundByLabel(label) {
  if (!pool || !label) return null
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_fund WHERE label = $1`,
    [label],
  )
  return rowToFund(result.rows[0] || null)
}

export async function createFund({
  tenantId, ownerUserId, label, displayName,
  ensName = null, ensAlias = null,
  treasuryAddress = null, tradingAddress = null,
  walletProvider = 'seed-derived',
  treasuryWalletId = null, tradingWalletId = null, walletSetId = null,
  status = 'provisioning',
}) {
  if (!pool) throw new Error('createFund: DATABASE_URL not configured')
  await ensureTables()
  const result = await pool.query(
    `INSERT INTO miroshark_fund
      (tenant_id, owner_user_id, label, display_name, ens_name, ens_alias,
       treasury_address, trading_address, wallet_provider,
       treasury_wallet_id, trading_wallet_id, wallet_set_id,
       status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
     RETURNING *`,
    [tenantId, ownerUserId, label, displayName, ensName, ensAlias,
     treasuryAddress, tradingAddress, walletProvider,
     treasuryWalletId, tradingWalletId, walletSetId, status],
  )
  return rowToFund(result.rows[0] || null)
}

export async function recordFundStep(tenantId, step) {
  if (!pool || !tenantId) return null
  await ensureTables()
  // Append to JSONB array atomically.
  const result = await pool.query(
    `UPDATE miroshark_fund
       SET provisioning_steps = provisioning_steps || $2::jsonb,
           updated_at = NOW()
     WHERE tenant_id = $1
     RETURNING *`,
    [tenantId, JSON.stringify([{ ...step, ts: step.ts || Date.now() }])],
  )
  return rowToFund(result.rows[0] || null)
}

export async function updateFundStatus(tenantId, {
  status, ensName, error, treasuryAddress, tradingAddress,
}) {
  if (!pool || !tenantId) return null
  await ensureTables()
  const sets = []
  const params = [tenantId]
  if (status !== undefined)           { sets.push(`status = $${sets.length + 2}`);            params.push(status) }
  if (ensName !== undefined)          { sets.push(`ens_name = $${sets.length + 2}`);          params.push(ensName) }
  if (error !== undefined)            { sets.push(`error = $${sets.length + 2}`);             params.push(error) }
  if (treasuryAddress !== undefined)  { sets.push(`treasury_address = $${sets.length + 2}`);  params.push(treasuryAddress) }
  if (tradingAddress !== undefined)   { sets.push(`trading_address = $${sets.length + 2}`);   params.push(tradingAddress) }
  if (!sets.length) return getFund(tenantId)
  sets.push(`updated_at = NOW()`)
  const result = await pool.query(
    `UPDATE miroshark_fund SET ${sets.join(', ')} WHERE tenant_id = $1 RETURNING *`,
    params,
  )
  return rowToFund(result.rows[0] || null)
}

export async function pendingTreasuryTransfersDb({ signerAddress = null, limit = 20 } = {}) {
  if (!pool) return []
  await ensureTables()
  const result = await pool.query(
    `SELECT * FROM miroshark_treasury_transfer
     WHERE status = 'pending'
     ORDER BY created_at DESC LIMIT $1`,
    [limit],
  )
  let rows = result.rows
  if (signerAddress) {
    const sa = String(signerAddress).toLowerCase()
    rows = rows.filter((row) => {
      const signers = row.signers || []
      return signers.some((s) => String(s.address || '').toLowerCase() === sa && !s.signed)
    })
  }
  return rows
}

export async function readOperatorState(userId) {
  const key = normalizeUserId(userId)
  if (!pool) {
    const state = await readFallbackState()
    return mergeOperatorState(DEFAULT_OPERATOR_STATE, state.operators?.[key] || {})
  }

  await ensureTables()
  const result = await pool.query(
    `SELECT profile, workspace, setup, wallets, automation, created_at, updated_at
     FROM miroshark_operator_state
     WHERE user_id = $1`,
    [key],
  )
  if (!result.rows.length) {
    return mergeOperatorState(DEFAULT_OPERATOR_STATE, {
      userId: key,
      createdAt: null,
      updatedAt: null,
    })
  }
  const row = result.rows[0]
  return mergeOperatorState(DEFAULT_OPERATOR_STATE, {
    userId: key,
    profile: row.profile,
    workspace: row.workspace,
    setup: row.setup,
    wallets: row.wallets,
    automation: row.automation,
    createdAt: row.created_at?.toISOString?.() || row.created_at || null,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at || null,
  })
}

export async function writeOperatorState(userId, nextState) {
  const key = normalizeUserId(userId)
  const previous = await readOperatorState(key)
  const merged = {
    ...mergeOperatorState(previous, nextState),
    userId: key,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  if (!pool) {
    const state = await readFallbackState()
    state.operators[key] = merged
    await writeFallbackState(state)
    return merged
  }

  await ensureTables()
  await pool.query(
    `INSERT INTO miroshark_operator_state
      (user_id, profile, workspace, setup, wallets, automation, created_at, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, COALESCE($7::timestamptz, NOW()), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       profile = EXCLUDED.profile,
       workspace = EXCLUDED.workspace,
       setup = EXCLUDED.setup,
       wallets = EXCLUDED.wallets,
       automation = EXCLUDED.automation,
       updated_at = NOW()`,
    [
      key,
      JSON.stringify(merged.profile || {}),
      JSON.stringify(merged.workspace || {}),
      JSON.stringify(merged.setup || {}),
      JSON.stringify(merged.wallets || {}),
      JSON.stringify(merged.automation || {}),
      merged.createdAt,
    ],
  )
  return merged
}

export async function readOpenClawSecret(userId) {
  const key = normalizeUserId(userId)
  if (!pool) {
    const state = await readFallbackState()
    return deserializeSecret(state.secrets?.[key]?.openclaw?.apiKey)
  }

  await ensureTables()
  const result = await pool.query(
    `SELECT openclaw FROM miroshark_operator_secret WHERE user_id = $1`,
    [key],
  )
  if (!result.rows.length) return ''
  return deserializeSecret(result.rows[0]?.openclaw?.apiKey)
}

export async function writeOpenClawSecret(userId, apiKey) {
  const key = normalizeUserId(userId)
  const payload = { apiKey: serializeSecret(apiKey) }
  if (!pool) {
    const state = await readFallbackState()
    state.secrets[key] = {
      ...(state.secrets[key] || {}),
      openclaw: payload,
      updatedAt: new Date().toISOString(),
    }
    await writeFallbackState(state)
    return true
  }

  await ensureTables()
  await pool.query(
    `INSERT INTO miroshark_operator_secret
      (user_id, openclaw, created_at, updated_at)
     VALUES ($1, $2::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       openclaw = EXCLUDED.openclaw,
       updated_at = NOW()`,
    [key, JSON.stringify(payload)],
  )
  return true
}

export async function clearOpenClawSecret(userId) {
  const key = normalizeUserId(userId)
  if (!pool) {
    const state = await readFallbackState()
    state.secrets[key] = {
      ...(state.secrets[key] || {}),
      openclaw: {},
      updatedAt: new Date().toISOString(),
    }
    await writeFallbackState(state)
    return true
  }

  await ensureTables()
  await pool.query(
    `INSERT INTO miroshark_operator_secret
      (user_id, openclaw, created_at, updated_at)
     VALUES ($1, '{}'::jsonb, NOW(), NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       openclaw = '{}'::jsonb,
       updated_at = NOW()`,
    [key],
  )
  return true
}

export async function appendWaitlistLead(input) {
  const email = String(input?.email || '').trim().toLowerCase()
  const fullName = String(input?.fullName || '').trim()
  const organization = String(input?.organization || '').trim()
  const note = String(input?.note || '').trim()
  const source = String(input?.source || 'web').trim() || 'web'

  if (!email) {
    throw new Error('Email is required')
  }

  if (!pool) {
    const state = await readWaitlistFallback()
    const nextLead = {
      email,
      fullName,
      organization,
      note,
      source,
      createdAt: new Date().toISOString(),
    }
    const existingIndex = state.leads.findIndex((lead) => lead.email === email)
    if (existingIndex >= 0) {
      state.leads[existingIndex] = {
        ...state.leads[existingIndex],
        ...nextLead,
      }
    } else {
      state.leads.unshift(nextLead)
    }
    await writeWaitlistFallback(state)
    return nextLead
  }

  await ensureTables()
  const result = await pool.query(
    `INSERT INTO miroshark_waitlist_lead (email, full_name, organization, note, source)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, full_name, organization, note, source, created_at`,
    [email, fullName, organization, note, source],
  )
  const row = result.rows[0]
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    organization: row.organization,
    note: row.note,
    source: row.source,
    createdAt: row.created_at?.toISOString?.() || row.created_at || null,
  }
}

export { DEFAULT_OPERATOR_STATE, mergeOperatorState }
