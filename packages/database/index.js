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
    })()
  }
  await globalForDatabase.mirosharkTablesPromise
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
