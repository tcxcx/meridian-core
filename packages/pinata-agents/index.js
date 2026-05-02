// @repo/pinata-agents — connector + state CRUD for Pinata Cloud hosted agents.
//
// Pinata Agents are hosted OpenClaw instances. We use the marketplace
// templates (prediction-market trader, MoonPay onramp concierge) as the 24/7
// autonomous loop instead of self-hosting OpenClaw. This module mirrors the
// shape of @repo/openclaw so the operator terminal can swap connectors with
// minimal UI delta — same status pill, same connect form, same manifest.
//
// State is stored in operator_state.automation.pinata (alongside the legacy
// openclaw block). The Pinata workspace API key is currently expected as a
// process-level env (PINATA_API_KEY) rather than per-user, since this is a
// hackathon-stage single-operator deployment. apiKeyPreview is kept for
// surface parity with @repo/openclaw — operators paste it for visibility,
// but actual programmatic calls pull from env.

import { readOperatorState, writeOperatorState } from '@repo/database'

const SUPPORTED_TEMPLATES = new Set([
  'prediction-market-trader',   // marketplace tak2z2xg — Polymarket+Kalshi auto-trader
  'moonpay-onramp-concierge',   // marketplace t8m5kbhc — fiat→crypto via MoonPay
  'custom',
])

const SUPPORTED_RUN_STATES = new Set(['idle', 'deployed', 'running', 'paused', 'error'])

function defaultState() {
  return {
    connected: false,
    provider: 'pinata-agents',
    // Trader (Template A) — drives the autonomous loop against MiroShark APIs.
    agentId: '',
    agentTemplate: '',
    agentChatUrl: '',
    telegramHandle: '',
    runState: 'idle',
    lastTickAt: null,
    // Onramp (Template B) — opens MoonPay onramp via Pinata chat.
    onrampAgentId: '',
    onrampChatUrl: '',
    // Workspace metadata.
    apiKeyPreview: '',
    operatorName: '',
    notes: '',
    manageAgentWallet: true,
    allowTreasuryProvisioning: true,
    updatedAt: null,
    connectedAt: null,
  }
}

function normalizeUserId(userId) {
  return String(userId || 'local-owner').trim() || 'local-owner'
}

function maskApiKey(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  if (raw.length <= 8) return `${raw.slice(0, 2)}…${raw.slice(-2)}`
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`
}

function normalizeTemplate(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  return SUPPORTED_TEMPLATES.has(raw) ? raw : 'custom'
}

function normalizeRunState(value) {
  const raw = String(value || 'idle').trim()
  return SUPPORTED_RUN_STATES.has(raw) ? raw : 'idle'
}

function normalizeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(raw.startsWith('http') ? raw : `https://${raw}`)
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function normalizeTelegram(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // Strip leading @ and t.me/ prefixes; store as bare handle.
  const stripped = raw
    .replace(/^https?:\/\/(www\.)?t\.me\//i, '')
    .replace(/^@/, '')
    .replace(/\/.*$/, '')
  return stripped ? `@${stripped}` : ''
}

export async function readPinataState(userId) {
  const key = normalizeUserId(userId)
  const state = await readOperatorState(key)
  return {
    ...defaultState(),
    ...(state.automation?.pinata || {}),
  }
}

export async function writePinataState(userId, input) {
  const key = normalizeUserId(userId)
  const existing = await readPinataState(key)
  const apiKey = String(input?.apiKey || '').trim()
  const agentChatUrl = normalizeUrl(input?.agentChatUrl ?? existing.agentChatUrl)
  const onrampChatUrl = normalizeUrl(input?.onrampChatUrl ?? existing.onrampChatUrl)
  const agentId = String(input?.agentId ?? existing.agentId ?? '').trim()
  const onrampAgentId = String(input?.onrampAgentId ?? existing.onrampAgentId ?? '').trim()
  const next = {
    ...existing,
    provider: 'pinata-agents',
    agentId,
    agentTemplate: normalizeTemplate(input?.agentTemplate ?? existing.agentTemplate),
    agentChatUrl,
    telegramHandle: normalizeTelegram(input?.telegramHandle ?? existing.telegramHandle),
    runState: normalizeRunState(input?.runState ?? existing.runState),
    lastTickAt: input?.lastTickAt ?? existing.lastTickAt,
    onrampAgentId,
    onrampChatUrl,
    apiKeyPreview: apiKey ? maskApiKey(apiKey) : existing.apiKeyPreview,
    operatorName: String(input?.operatorName ?? existing.operatorName ?? '').trim(),
    notes: String(input?.notes ?? existing.notes ?? '').trim(),
    manageAgentWallet: input?.manageAgentWallet ?? existing.manageAgentWallet ?? true,
    allowTreasuryProvisioning: input?.allowTreasuryProvisioning ?? existing.allowTreasuryProvisioning ?? true,
    connected: Boolean(agentId && agentChatUrl),
    connectedAt: existing.connectedAt || (agentId ? new Date().toISOString() : null),
    updatedAt: new Date().toISOString(),
  }

  await writeOperatorState(key, {
    automation: {
      pinata: next,
    },
  })
  return next
}

export async function clearPinataState(userId) {
  const key = normalizeUserId(userId)
  const next = {
    ...defaultState(),
    updatedAt: new Date().toISOString(),
  }
  await writeOperatorState(key, {
    automation: {
      pinata: next,
    },
  })
  return next
}

export async function setPinataRunState(userId, runState) {
  const key = normalizeUserId(userId)
  const existing = await readPinataState(key)
  const next = {
    ...existing,
    runState: normalizeRunState(runState),
    lastTickAt: runState === 'running' ? new Date().toISOString() : existing.lastTickAt,
    updatedAt: new Date().toISOString(),
  }
  await writeOperatorState(key, {
    automation: {
      pinata: next,
    },
  })
  return next
}

export function summarizePinataState(state) {
  const current = { ...defaultState(), ...state }
  return {
    connected: Boolean(current.connected),
    provider: current.provider,
    agentId: current.agentId,
    agentTemplate: current.agentTemplate,
    agentChatUrl: current.agentChatUrl,
    telegramHandle: current.telegramHandle,
    telegramUrl: current.telegramHandle
      ? `https://t.me/${current.telegramHandle.replace(/^@/, '')}`
      : '',
    runState: current.runState,
    lastTickAt: current.lastTickAt,
    onrampAgentId: current.onrampAgentId,
    onrampChatUrl: current.onrampChatUrl,
    operatorName: current.operatorName,
    apiKeyPreview: current.apiKeyPreview,
    manageAgentWallet: Boolean(current.manageAgentWallet),
    allowTreasuryProvisioning: Boolean(current.allowTreasuryProvisioning),
    notes: current.notes,
    updatedAt: current.updatedAt,
    connectedAt: current.connectedAt,
  }
}

export function buildPinataManifest({ pinata, workspace, actor, wallets, policy }) {
  // Manifest is the JSON the Pinata agent reads (via webhook or polling) to
  // know how to call MiroShark. The agent template ships with placeholders
  // for these fields; we publish the resolved values per-user so the agent
  // operates on this operator's wallets + risk policy.
  const state = summarizePinataState(pinata)
  const baseUrl = process.env.MIROSHARK_PUBLIC_URL || process.env.MIROSHARK_APP_URL || ''
  return {
    connector: 'pinata-agents',
    connected: state.connected,
    workspace: {
      slug: workspace?.slug || 'miroshark-main',
      title: workspace?.title || 'MiroShark Main Fund',
      room: workspace?.liveblocksRoom || null,
    },
    operator: {
      name: actor?.displayName || 'MiroShark Operator',
      email: actor?.email || null,
    },
    pinata: {
      agentId: state.agentId || null,
      agentTemplate: state.agentTemplate || null,
      agentChatUrl: state.agentChatUrl || null,
      telegramHandle: state.telegramHandle || null,
      runState: state.runState,
      onrampAgentId: state.onrampAgentId || null,
      onrampChatUrl: state.onrampChatUrl || null,
    },
    miroshark: {
      // Endpoints the Pinata agent calls to discover signals + place trades.
      // Override via MIROSHARK_PUBLIC_URL when the agent runs off-host.
      signalScanUrl: baseUrl ? `${baseUrl}/signal/api/signal/markets/scan` : '/signal/api/signal/markets/scan',
      signalRunUrl: baseUrl ? `${baseUrl}/signal/api/signal/run` : '/signal/api/signal/run',
      executionOpenUrl: baseUrl ? `${baseUrl}/execution/api/execution/open` : '/execution/api/execution/open',
      executionResolveUrl: baseUrl ? `${baseUrl}/execution/api/execution/resolve` : '/execution/api/execution/resolve',
      auditUrl: baseUrl ? `${baseUrl}/execution/api/execution/audit` : '/execution/api/execution/audit',
      operatorStatusUrl: baseUrl ? `${baseUrl}/execution/api/execution/operator/status` : '/execution/api/execution/operator/status',
    },
    walletControl: {
      manageAgentWallet: Boolean(state.manageAgentWallet),
      allowTreasuryProvisioning: Boolean(state.allowTreasuryProvisioning),
      tradingWalletAddress: wallets?.trading?.address || null,
      treasuryWalletAddress: wallets?.treasury?.address || null,
      treasuryFundingMode: wallets?.treasury?.fundingMode || 'unconfigured',
      sharedSigner: Boolean(wallets?.treasury?.sharedWithTrading),
    },
    policy: {
      treasuryProvisionPct: Number(policy?.treasuryProvisionPct || 0.1),
      perPositionMinPct: Number(policy?.perPositionMinPct || 0.01),
      perPositionMaxPct: Number(policy?.perPositionMaxPct || 0.05),
      maxScope: state.manageAgentWallet ? 'agent-wallet' : 'observe-only',
    },
    permissions: state.manageAgentWallet
      ? [
        'read_signals',
        'open_position',
        'monitor_position',
        'resolve_position',
        'request_replenishment',
        'sweep_profit',
      ]
      : ['read_signals', 'recommend_actions'],
    notes: state.notes || '',
  }
}
