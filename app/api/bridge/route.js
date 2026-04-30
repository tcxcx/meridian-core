import { NextResponse } from 'next/server'

import { cogitoUrl, executionUrl, readJson } from '@/lib/server/service-clients'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/

function cogitoHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  const token = process.env.COGITO_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null)
    const amount = String(body?.amount || '').trim()
    if (!DECIMAL_RE.test(amount) || Number(amount) <= 0) {
      return NextResponse.json({ error: 'invalid_input', message: 'Amount must be a positive decimal with up to 6 places.' }, { status: 400 })
    }

    const capitalStatus = await readJson(executionUrl('/api/execution/capital/status'))
    const capital = capitalStatus?.capital || {}
    const available = Number(capital?.balances?.gateway_available || 0)
    if (Number(amount) > available) {
      return NextResponse.json(
        { error: 'insufficient_gateway_balance', message: `Gateway treasury only has ${available.toFixed(6)} USDC available.` },
        { status: 409 },
      )
    }

    const source = capital?.settlement_chain?.key || 'arbitrum_sepolia'
    const destination = capital?.primary_trading_chain?.key || 'polygon_amoy'
    const recipient = String(body?.recipient || '').trim() || undefined

    const response = await fetch(cogitoUrl('/bridge'), {
      method: 'POST',
      headers: cogitoHeaders(),
      body: JSON.stringify({
        signer: { kind: 'treasury' },
        from_chain: source,
        to_chain: destination,
        amount,
        ...(recipient ? { recipient } : {}),
      }),
    })

    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      return NextResponse.json(
        { error: 'bridge_failed', message: data?.message || data?.error || `HTTP ${response.status}` },
        { status: response.status >= 400 ? response.status : 502 },
      )
    }

    return NextResponse.json({
      state: data?.state || 'success',
      txHash: data?.forward_tx_hash || data?.transfer_id || null,
      explorerUrl: null,
      steps: Array.isArray(data?.steps) ? data.steps.map((step) => ({
        name: step.name,
        state: step.state,
        txHash: step.tx_hash || null,
        explorerUrl: step.explorer_url || null,
      })) : [],
      amount,
      fromChain: source,
      toChain: destination,
      source: 'circle-gateway',
      transferId: data?.transfer_id || null,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'bridge_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
