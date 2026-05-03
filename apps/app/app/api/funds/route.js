import 'server-only'

import { NextResponse } from 'next/server'
import { keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import {
  createFund,
  getFundByLabel,
  listFunds,
  recordFundStep,
  updateFundStatus,
} from '@repo/database'
import { mintSubname, slugifyLabel } from '@repo/ens/mint'
import { isCircleDcwConfigured, provisionFundWallets } from '@/lib/circle/dcw'

// Per-fund trading wallet derivation. Mirrors services/execution_router/burner.py
// pattern: keccak(BURNER_SEED || tenant || role) → private key → address.
// Platform treasury (the registrar signer) is shared across funds for the demo;
// future v2 swaps to Circle Developer-Controlled Wallets per user.
function deriveAddressForTenant(tenantId, role) {
  const seedHex = (process.env.BURNER_SEED || '').replace(/^0x/, '')
  if (!seedHex || seedHex.length !== 64) {
    throw new Error('BURNER_SEED must be a 32-byte hex string in env')
  }
  const seedBytes = Buffer.from(seedHex, 'hex')
  const tenantBytes = Buffer.from(tenantId, 'utf-8')
  const roleBytes = Buffer.from(role, 'utf-8')
  const concat = Buffer.concat([seedBytes, tenantBytes, roleBytes])
  const digest = keccak256(concat)
  const account = privateKeyToAccount(digest)
  return account.address
}

function platformTreasuryAddress() {
  const key = (process.env.TREASURY_PRIVATE_KEY || '').trim()
  if (!key) return null
  try {
    return privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`).address
  } catch {
    return null
  }
}

function ownerUserIdFromRequest(request) {
  // Convention: trust X-User-Id header in dev; production wires to Clerk auth.
  // For the demo MiroShark is single-tenant per browser, so a hardcoded fallback
  // is fine and lets the lean canvas Just Work.
  return request.headers.get('x-user-id')
    || request.headers.get('x-clerk-user-id')
    || 'local-owner'
}

function tenantEnsName(label) {
  const parent = process.env.MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth'
  return `${label}.${parent}`
}

// GET /api/funds — list all funds for the current user.
export async function GET(request) {
  try {
    const ownerUserId = ownerUserIdFromRequest(request)
    const funds = await listFunds({ ownerUserId, limit: 100 })
    return NextResponse.json({ funds, ownerUserId })
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || 'failed to list funds', funds: [] },
      { status: 500 },
    )
  }
}

// POST /api/funds — atomic-ish fund provisioning.
// Body: { displayName: string, ensAlias?: string, label?: string }
// Returns: { fund, steps, complete }
export async function POST(request) {
  let pendingTenantId = null
  try {
    const body = await request.json().catch(() => ({}))
    const ownerUserId = ownerUserIdFromRequest(request)
    const displayName = String(body?.displayName || '').trim()
    if (!displayName) {
      return NextResponse.json({ error: 'displayName required' }, { status: 400 })
    }

    const proposedLabel = body?.label
      ? slugifyLabel(body.label)
      : slugifyLabel(displayName)
    if (!proposedLabel) {
      return NextResponse.json({ error: 'displayName must produce a non-empty ENS-safe label' }, { status: 400 })
    }
    if (proposedLabel.length < 2) {
      return NextResponse.json({ error: 'label too short (min 2 chars)' }, { status: 400 })
    }

    const ensAlias = body?.ensAlias
      ? String(body.ensAlias).trim()
      : null

    // Idempotency: if a fund already exists for this label and the same owner,
    // surface it; if owned by another user, refuse (slug collision in shared
    // namespace).
    const existing = await getFundByLabel(proposedLabel)
    if (existing) {
      if (existing.owner_user_id !== ownerUserId) {
        return NextResponse.json(
          { error: `label "${proposedLabel}" is taken — choose a different display name` },
          { status: 409 },
        )
      }
      // Same owner re-creating: return the existing fund as-is.
      return NextResponse.json({ fund: existing, steps: existing.provisioning_steps, complete: existing.status === 'active' })
    }

    // Tenant id mirrors the slug — operator UI + Python burner derivation
    // both key off this string.
    const tenantId = proposedLabel

    // Wallet provisioning. Prefer Circle DCW when env is set; fall back to
    // BURNER_SEED-derived addresses so the demo works without Circle credentials.
    let walletProvider = 'seed-derived'
    let tradingAddress = null
    let treasuryAddress = platformTreasuryAddress()
    let tradingWalletId = null
    let treasuryWalletId = null
    let walletSetId = null

    if (isCircleDcwConfigured()) {
      try {
        const provisioned = await provisionFundWallets({
          ownerUserId, label: proposedLabel, displayName,
        })
        walletProvider = 'circle-dcw'
        tradingAddress = provisioned.trading.address
        treasuryAddress = provisioned.treasury.address
        tradingWalletId = provisioned.trading.id
        treasuryWalletId = provisioned.treasury.id
        walletSetId = provisioned.walletSet.id
      } catch (circleError) {
        // If Circle fails, fall through to seed-derived rather than blocking
        // the demo. Surface the error in provisioning_steps so it's visible.
        await recordFundStep(tenantId, {
          step: 'wallet.circle.failed',
          status: 'err',
          info: { error: circleError?.message || String(circleError) },
        }).catch(() => null)
      }
    }

    if (!tradingAddress) {
      try {
        tradingAddress = deriveAddressForTenant(tenantId, 'trading')
      } catch (e) {
        return NextResponse.json({ error: e.message }, { status: 503 })
      }
    }

    const fund = await createFund({
      tenantId,
      ownerUserId,
      label: proposedLabel,
      displayName,
      ensAlias,
      treasuryAddress,
      tradingAddress,
      walletProvider,
      treasuryWalletId,
      tradingWalletId,
      walletSetId,
      status: 'provisioning',
    })
    pendingTenantId = tenantId
    await recordFundStep(tenantId, {
      step: 'fund.create', status: 'ok',
      info: { label: proposedLabel, displayName, walletProvider },
    })
    if (walletProvider === 'circle-dcw') {
      await recordFundStep(tenantId, {
        step: 'wallet.circle.provisioned', status: 'ok',
        info: {
          trading_wallet_id: tradingWalletId,
          treasury_wallet_id: treasuryWalletId,
          wallet_set_id: walletSetId,
        },
      })
    }

    // ENS subname mint. The label used on chain is the ENS alias if set,
    // else the slug. Records mirror the convention from packages/ens/index.js.
    const ensLabel = ensAlias ? slugifyLabel(ensAlias) : proposedLabel
    const ensName = tenantEnsName(ensLabel)
    const parent = process.env.MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth'
    const network = (process.env.ENS_NETWORK || 'sepolia').toLowerCase() === 'mainnet'
      ? 'mainnet'
      : 'sepolia'

    const signerKey = (process.env.ENS_REGISTRAR_PRIVATE_KEY
      || process.env.TREASURY_PRIVATE_KEY
      || '').trim()
    if (!signerKey) {
      await updateFundStatus(tenantId, {
        status: 'failed',
        error: 'ENS_REGISTRAR_PRIVATE_KEY (or TREASURY_PRIVATE_KEY) not set; cannot mint subname',
      })
      const updated = await getFundByLabel(proposedLabel)
      return NextResponse.json({ fund: updated, error: updated.error }, { status: 503 })
    }

    await recordFundStep(tenantId, {
      step: 'ens.mint.start', status: 'ok',
      info: { ensName, parent, label: ensLabel, address: tradingAddress, network },
    })

    const records = {
      description: `MiroShark fund "${displayName}" — tenant trading wallet`,
      'miroshark.tenant': tenantId,
      'miroshark.role': 'tenant-trading-wallet',
      'agent.template': 'Polymarket Trader',
      'agent.skills': 'probe · swarm · open · settle',
      'org.telegram': '@miro_shark_bot',
    }

    let mintResult
    try {
      mintResult = await mintSubname({
        parent,
        label: ensLabel,
        address: tradingAddress,
        records,
        signerKey,
        network,
        rpcUrl: network === 'sepolia'
          ? (process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com')
          : process.env.MAINNET_RPC_URL,
        onProgress: async (event) => {
          // Persist each step inline so even if the request is interrupted,
          // the fund row reflects how far we got.
          await recordFundStep(tenantId, event).catch(() => null)
        },
      })
    } catch (mintError) {
      await updateFundStatus(tenantId, {
        status: 'failed',
        error: mintError?.shortMessage || mintError?.message || String(mintError),
      })
      const updated = await getFundByLabel(proposedLabel)
      return NextResponse.json({ fund: updated, error: updated.error }, { status: 502 })
    }

    const finalFund = await updateFundStatus(tenantId, {
      status: 'active',
      ensName,
    })
    return NextResponse.json({
      fund: finalFund,
      steps: mintResult.steps,
      complete: true,
    })
  } catch (error) {
    if (pendingTenantId) {
      await updateFundStatus(pendingTenantId, {
        status: 'failed',
        error: error?.message || String(error),
      }).catch(() => null)
    }
    return NextResponse.json(
      { error: error?.message || 'fund provisioning failed' },
      { status: 500 },
    )
  }
}
