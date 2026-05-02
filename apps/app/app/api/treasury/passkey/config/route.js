import { cookies, headers } from 'next/headers'
import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { readPasskeys, readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function hostWithoutPort(value) {
  return String(value || '').split(':')[0].trim().toLowerCase()
}

function resolveRpId(currentHost) {
  if (currentHost === '127.0.0.1' || currentHost === '::1') {
    return 'localhost'
  }
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.MIROSHARK_APP_URL || 'http://localhost:3000'
  try {
    return hostWithoutPort(new URL(appUrl).hostname) || 'localhost'
  } catch {
    return 'localhost'
  }
}

function isRpCompatible(currentHost, rpId) {
  if (!currentHost || !rpId) return false
  return currentHost === rpId || currentHost.endsWith(`.${rpId}`)
}

function resolveClientKey() {
  return process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_KEY || process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY || ''
}

function resolveClientUrl() {
  return process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_URL || process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL || ''
}

async function resolveCirclePasskeyDomain({ clientKey, clientUrl, currentHost }) {
  if (!clientKey || !clientUrl || !currentHost) {
    return { rpId: null, rpName: null, error: null }
  }

  try {
    const response = await fetch(clientUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientKey}`,
        'X-AppInfo': `platform=web;version=1.0.13;uri=${currentHost}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'miroshark-passkey-domain-check',
        method: 'rp_getRegistrationOptions',
        params: [`Miroshark_Check_${Date.now().toString(36)}`],
      }),
      cache: 'no-store',
    })
    const payload = await response.json().catch(() => ({}))
    return {
      rpId: payload?.result?.rp?.id || null,
      rpName: payload?.result?.rp?.name || null,
      error: response.ok ? payload?.error?.message || null : payload?.error?.message || payload?.message || `HTTP ${response.status}`,
    }
  } catch (error) {
    return { rpId: null, rpName: null, error: error instanceof Error ? error.message : String(error) }
  }
}

function resolveRequestedModularChain() {
  return (
    process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CHAIN ||
    (String(process.env.POLYMARKET_CHAIN_ID || '80002') === '137' ? 'Polygon' : 'Polygon_Amoy_Testnet')
  )
}

function resolveEffectiveModularChain(clientKey, requestedChain) {
  if (String(clientKey || '').startsWith('TEST_CLIENT_KEY:') && requestedChain === 'Polygon') {
    return 'Polygon_Amoy_Testnet'
  }
  return requestedChain
}

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const passkeys = await readPasskeys()
  const wallet = await readTreasuryWalletState()
  const topology = await resolveWalletTopology()
  const jar = await cookies()
  const headerList = await headers()
  const currentHost = hostWithoutPort(headerList.get('x-forwarded-host') || headerList.get('host'))
  const requestPort = String(headerList.get('x-forwarded-host') || headerList.get('host') || '').split(':')[1] || ''
  const protocol = headerList.get('x-forwarded-proto') || (process.env.NODE_ENV === 'production' ? 'https' : 'http')
  const rpId = resolveRpId(currentHost)
  const rpCompatible = isRpCompatible(currentHost, rpId)
  const sessionCookie = jar.get('miroshark_treasury_session')?.value || null
  let session = null
  if (sessionCookie) {
    try {
      session = JSON.parse(sessionCookie)
    } catch {
      session = null
    }
  }
  const clientKey = resolveClientKey()
  const clientUrl = resolveClientUrl()
  const circlePasskeyDomain = await resolveCirclePasskeyDomain({
    clientKey,
    clientUrl,
    currentHost: rpId,
  })
  const requestedModularChain = resolveRequestedModularChain()
  const modularChain = resolveEffectiveModularChain(clientKey, requestedModularChain)
  const downgradedToTestnet = requestedModularChain !== modularChain
  const passkeyDomainMatches = !circlePasskeyDomain.rpId || isRpCompatible(rpId, circlePasskeyDomain.rpId)
  return NextResponse.json({
    rpId,
    currentHost,
    rpCompatible,
    canonicalOrigin: `${protocol}://${rpId}${requestPort ? `:${requestPort}` : ''}`,
    actor: {
      email: actor.email || '',
      displayName: actor.displayName || '',
    },
    credentials: passkeys.credentials || [],
    wallet,
    session,
    agentWalletAddress: topology.agent.address,
    treasuryTopology: topology.treasury,
    circle: {
      clientKeyReady: Boolean(clientKey),
      clientUrlReady: Boolean(clientUrl),
      walletSetReady: Boolean(process.env.CIRCLE_WALLET_SET_ID),
      treasuryWalletReady: Boolean(topology.treasury.address && topology.treasury.fundingMode !== 'legacy-circle'),
      passkeyDomain: circlePasskeyDomain.rpId,
      passkeyDomainName: circlePasskeyDomain.rpName,
      passkeyDomainMatches,
      passkeyDomainError: circlePasskeyDomain.error,
      requestedModularChain,
      modularChain,
      downgradedToTestnet,
      mainnetProvisioning: modularChain === 'Polygon',
    },
    notes: [
      'Circle modular wallets require a client key and client URL with a domain matching the passkey RP.',
      circlePasskeyDomain.rpId && !passkeyDomainMatches
        ? `Circle is returning passkey RP "${circlePasskeyDomain.rpId}". Set the Circle Passkey Domain to "${rpId}" for this local app.`
        : null,
      'Active passkey sessions are kept in an httpOnly cookie; the user can reconnect with WebAuthn login without creating a new owner.',
      'The treasury signer plan here follows the desk-v1 private-multisig rollout: signer identity first, treasury MSCA second.',
      downgradedToTestnet
        ? 'A TEST_CLIENT_KEY cannot provision a Polygon mainnet modular wallet. The ceremony is using Polygon Amoy testnet until a LIVE_CLIENT_KEY is configured.'
        : null,
      modularChain === 'Polygon'
        ? 'Mainnet provisioning is active for the treasury modular wallet on Polygon.'
        : 'Treasury modular-wallet provisioning is pointed at testnet.',
    ].filter(Boolean),
  })
}
