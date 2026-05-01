import { NextResponse } from 'next/server'

import { executionUrl, readJson } from '@/lib/server/service-clients'
import { resolveWalletTopology } from '@/lib/server/wallet-topology'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fixed6(value) {
  return Number(value || 0).toFixed(6)
}

export async function GET() {
  try {
    const topology = await resolveWalletTopology()
    const payload = await readJson(executionUrl('/api/execution/capital/status'))
    const capital = payload?.capital || {}
    const balances = capital?.balances || {}
    const perDomain = Array.isArray(capital?.per_domain) ? capital.per_domain : []
    const fundingMode = String(capital?.treasury?.funding_mode || '')
    const sourceAvailable = fundingMode.startsWith('polygon')
      ? Number(balances.direct_polygon_available ?? balances.gateway_available ?? 0)
      : Number(balances.gateway_available ?? 0)
    const grandTotal = fundingMode.startsWith('polygon')
      ? Number(balances.grand_total ?? balances.direct_polygon_available ?? 0)
      : Number(balances.grand_total ?? 0)

    return NextResponse.json({
      grandTotal: fixed6(grandTotal),
      spendableTotal: fixed6(balances.spendable_now),
      available: fixed6(sourceAvailable),
      spendableAvailable: fixed6(balances.available_to_deploy),
      pendingCreditTotal: fixed6(balances.pending_credit_total),
      opsStagingTotal: fixed6(balances.ops_staging_total),
      unsupportedSourceTotal: '0.000000',
      treasuryAddress: topology.treasury.address,
      tradingAddress: topology.agent.address,
      treasuryFundingMode: topology.treasury.fundingMode,
      legacyCircleTreasuryAddress: topology.treasury.legacyCircleAddress,
      perDomain: perDomain.map((item) => ({
        domain: item.domain,
        chain: item.key,
        label: item.label,
        balance: fixed6(item.balance_usdc),
        depositor: null,
        scannerUrl: null,
      })),
      pendingCredits: [],
      opsStaging: [],
      depositor: null,
      enabledDomains: perDomain.map((item) => item.domain).filter((value) => Number.isInteger(value)),
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'gateway_balance_unavailable', message: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    )
  }
}
