import { promises as fs } from 'fs'
import path from 'path'

import { buildDefaultMultisigPlan, computeThreshold, rebalanceWeights, sanitizeSigners } from '@/lib/multisig-plan'

const ROOT = path.resolve(process.cwd(), '../..')
const STATE_DIR = path.join(ROOT, '.context', 'miroshark')
const PASSKEYS_PATH = path.join(STATE_DIR, 'treasury-passkeys.json')
const MULTISIG_PATH = path.join(STATE_DIR, 'treasury-multisig-plan.json')
const TREASURY_WALLET_PATH = path.join(STATE_DIR, 'treasury-wallet.json')

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

export async function readPasskeys() {
  return readJson(PASSKEYS_PATH, { credentials: [] })
}

export async function writePasskeys(nextState) {
  const state = {
    credentials: Array.isArray(nextState?.credentials) ? nextState.credentials : [],
    updatedAt: new Date().toISOString(),
  }
  await writeJson(PASSKEYS_PATH, state)
  return state
}

export async function readMultisigPlan(actor) {
  const state = await readJson(MULTISIG_PATH, null)
  return buildDefaultMultisigPlan(actor, state)
}

export async function writeMultisigPlan(plan, actor) {
  const signers = sanitizeSigners(plan?.signers, actor)
  const weights = plan?.weights || rebalanceWeights(signers)
  const threshold = computeThreshold(weights)
  const normalized = {
    signers,
    weights,
    threshold: Number(threshold.threshold || 0),
    thresholdPct: Number(threshold.thresholdPct || 0),
    totalWeight: Number(threshold.totalWeight || 0),
    signerCount: Number(threshold.signerCount || 0),
    updatedAt: new Date().toISOString(),
  }
  await writeJson(MULTISIG_PATH, normalized)
  return normalized
}

export async function readTreasuryWalletState() {
  return readJson(TREASURY_WALLET_PATH, {
    walletAddress: null,
    chain: null,
    chainId: null,
    credentialId: null,
    credentialUsername: null,
    publicKey: null,
    recoveryRegistered: false,
    addressBookInstalled: false,
    registeredRecipients: [],
    addressMappings: [],
    userOpHash: null,
    updatedAt: null,
  })
}

export async function writeTreasuryWalletState(state) {
  const nextState = {
    walletAddress: state?.walletAddress || null,
    chain: state?.chain || null,
    chainId: Number(state?.chainId || 0) || null,
    credentialId: state?.credentialId || null,
    credentialUsername: state?.credentialUsername || null,
    publicKey: state?.publicKey || null,
    recoveryRegistered: Boolean(state?.recoveryRegistered),
    addressBookInstalled: Boolean(state?.addressBookInstalled),
    registeredRecipients: Array.isArray(state?.registeredRecipients)
      ? [...new Set(state.registeredRecipients.map((item) => String(item).toLowerCase()))]
      : [],
    addressMappings: Array.isArray(state?.addressMappings) ? state.addressMappings : [],
    userOpHash: state?.userOpHash || null,
    transportSegment: state?.transportSegment || null,
    updatedAt: new Date().toISOString(),
  }
  await writeJson(TREASURY_WALLET_PATH, nextState)
  return nextState
}
