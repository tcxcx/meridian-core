import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { readPasskeys, readTreasuryWalletState } from '@/lib/server/treasury-state'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function resolveRpId() {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.MIROSHARK_APP_URL || 'http://localhost:3000'
  try {
    return new URL(appUrl).hostname
  } catch {
    return 'localhost'
  }
}

export async function GET() {
  const passkeys = await readPasskeys()
  const wallet = await readTreasuryWalletState()
  const topology = await resolveWalletTopology()
  const jar = await cookies()
  const sessionCookie = jar.get('miroshark_treasury_session')?.value || null
  let session = null
  if (sessionCookie) {
    try {
      session = JSON.parse(sessionCookie)
    } catch {
      session = null
    }
  }
  const modularChain =
    process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CHAIN ||
    (String(process.env.POLYMARKET_CHAIN_ID || '80002') === '137' ? 'Polygon' : 'Polygon_Amoy_Testnet')
  return NextResponse.json({
    rpId: resolveRpId(),
    credentials: passkeys.credentials || [],
    wallet,
    session,
    agentWalletAddress: topology.agent.address,
    treasuryTopology: topology.treasury,
    circle: {
      clientKeyReady: Boolean(process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_KEY || process.env.NEXT_PUBLIC_CIRCLE_CLIENT_KEY),
      clientUrlReady: Boolean(process.env.NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_URL || process.env.NEXT_PUBLIC_CIRCLE_CLIENT_URL),
      walletSetReady: Boolean(process.env.CIRCLE_WALLET_SET_ID),
      treasuryWalletReady: Boolean(topology.treasury.address && topology.treasury.fundingMode !== 'legacy-circle'),
      modularChain,
      mainnetProvisioning: modularChain === 'Polygon',
    },
    notes: [
      'Circle modular wallets require a client key and client URL with a domain matching the passkey RP.',
      'Active passkey sessions are kept in an httpOnly cookie; the user can reconnect with WebAuthn login without creating a new owner.',
      'The treasury signer plan here follows the desk-v1 private-multisig rollout: signer identity first, treasury MSCA second.',
      modularChain === 'Polygon'
        ? 'Mainnet provisioning is active for the treasury modular wallet on Polygon.'
        : 'Treasury modular-wallet provisioning is pointed at testnet.',
    ],
  })
}
