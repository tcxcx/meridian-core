import { readOpenClawSecret, readOperatorState, writeOpenClawSecret, writeOperatorState, clearOpenClawSecret } from '@repo/database'

function defaultState() {
  return {
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

export async function readOpenClawState(userId) {
  const key = normalizeUserId(userId)
  const state = await readOperatorState(key)
  return {
    ...defaultState(),
    ...(state.automation?.openclaw || {}),
  }
}

export async function writeOpenClawState(userId, input) {
  const key = normalizeUserId(userId)
  const existing = await readOpenClawState(key)
  const apiKey = String(input?.apiKey || '').trim()
  const endpoint = normalizeUrl(input?.endpoint || existing.endpoint)
  const next = {
    ...existing,
    provider: String(input?.provider || existing.provider || 'openclaw').trim() || 'openclaw',
    endpoint,
    operatorName: String(input?.operatorName || existing.operatorName || '').trim(),
    model: String(input?.model || existing.model || '').trim(),
    apiKeyPreview: apiKey ? maskApiKey(apiKey) : existing.apiKeyPreview,
    manageAgentWallet: input?.manageAgentWallet ?? existing.manageAgentWallet ?? true,
    allowTreasuryProvisioning: input?.allowTreasuryProvisioning ?? existing.allowTreasuryProvisioning ?? true,
    notes: String(input?.notes || existing.notes || '').trim(),
    connected: Boolean(endpoint && (apiKey || existing.apiKeyPreview)),
    connectedAt: existing.connectedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }

  if (apiKey) {
    await writeOpenClawSecret(key, apiKey)
  }

  await writeOperatorState(key, {
    automation: {
      openclaw: next,
    },
  })
  return next
}

export async function clearOpenClawState(userId) {
  const key = normalizeUserId(userId)
  await clearOpenClawSecret(key)
  const next = {
    ...defaultState(),
    updatedAt: new Date().toISOString(),
  }
  await writeOperatorState(key, {
    automation: {
      openclaw: next,
    },
  })
  return next
}

export async function getOpenClawApiKey(userId) {
  return readOpenClawSecret(normalizeUserId(userId))
}

export function summarizeOpenClawState(state) {
  const current = { ...defaultState(), ...state }
  return {
    connected: Boolean(current.connected),
    provider: current.provider,
    endpoint: current.endpoint,
    operatorName: current.operatorName,
    model: current.model,
    apiKeyPreview: current.apiKeyPreview,
    manageAgentWallet: Boolean(current.manageAgentWallet),
    allowTreasuryProvisioning: Boolean(current.allowTreasuryProvisioning),
    notes: current.notes,
    updatedAt: current.updatedAt,
    connectedAt: current.connectedAt,
  }
}

export function buildOpenClawManifest({ openclaw, workspace, actor, wallets, policy }) {
  const state = summarizeOpenClawState(openclaw)
  return {
    connector: 'openclaw',
    connected: state.connected,
    workspace: {
      slug: workspace?.slug || 'miroshark-main',
      title: workspace?.title || 'MiroShark Main Fund',
      room: workspace?.liveblocksRoom || null,
    },
    operator: {
      name: actor?.displayName || 'MiroShark Operator',
      email: actor?.email || null,
      openclawOperator: state.operatorName || actor?.displayName || 'MiroShark Operator',
    },
    endpoint: state.endpoint || null,
    model: state.model || null,
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
        'read_wallet_state',
        'request_replenishment',
        'fund_agent_wallet',
        'open_position',
        'close_position',
        'sweep_profit',
      ]
      : ['read_wallet_state', 'recommend_actions'],
    notes: state.notes || '',
  }
}
