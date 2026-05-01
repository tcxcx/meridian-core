import { NextResponse } from 'next/server'

import {
  createAdapterForExecution,
  getAppKit,
  getKitKey,
  getExecutionSignerAddress,
  resolveSendChainConfig,
  summarizeSend,
} from '@/lib/server/circle-app-kit'
import { cogitoUrl, executionUrl, readJson } from '@/lib/server/service-clients'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const DECIMAL_RE = /^\d+(\.\d{1,6})?$/

function cogitoHeaders() {
  const headers = { 'Content-Type': 'application/json' }
  const token = process.env.COGITO_TOKEN
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function fundSignerFromGateway({ amount, recipient, destinationKey }) {
  const capitalStatus = await readJson(executionUrl('/api/execution/capital/status'))
  const capital = capitalStatus?.capital || {}
  const available = Number(capital?.balances?.gateway_available || 0)
  if (Number(amount) > available) {
    throw new Error(`Gateway treasury only has ${available.toFixed(6)} USDC available.`)
  }

  const response = await fetch(cogitoUrl('/bridge'), {
    method: 'POST',
    headers: cogitoHeaders(),
    body: JSON.stringify({
      signer: { kind: 'treasury' },
      from_chain: capital?.settlement_chain?.key || 'arbitrum_sepolia',
      to_chain: destinationKey,
      amount,
      recipient,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`)
  }
  return data
}

async function directGatewaySend({ amount, recipient }) {
  const capitalStatus = await readJson(executionUrl('/api/execution/capital/status'))
  const capital = capitalStatus?.capital || {}
  const available = Number(capital?.balances?.gateway_available || 0)
  if (Number(amount) > available) {
    throw new Error(`Gateway treasury only has ${available.toFixed(6)} USDC available.`)
  }

  const response = await fetch(cogitoUrl('/bridge'), {
    method: 'POST',
    headers: cogitoHeaders(),
    body: JSON.stringify({
      signer: { kind: 'treasury' },
      from_chain: capital?.settlement_chain?.key || 'arbitrum_sepolia',
      to_chain: capital?.primary_trading_chain?.key || 'polygon_amoy',
      amount,
      recipient,
    }),
  })

  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `HTTP ${response.status}`)
  }

  return {
    state: data?.state || 'success',
    txHash: data?.forward_tx_hash || data?.transfer_id || null,
    explorerUrl: null,
    transferLogId: data?.transfer_id || `snd_${Date.now()}`,
    source: 'circle-gateway',
    gatewayFunding: data,
    detail: 'USDC sent directly from the unified Gateway balance to the destination recipient.',
  }
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null)
    const to = String(body?.to || '').trim()
    const amount = String(body?.amount || '').trim()
    const token = String(body?.token || 'USDC').trim().toUpperCase()
    const scope = String(body?.scope || 'treasury').trim().toLowerCase()

    if (!ADDRESS_RE.test(to)) {
      return NextResponse.json({ error: 'invalid_input', message: 'Recipient must be a 0x address.' }, { status: 400 })
    }
    if (!DECIMAL_RE.test(amount) || Number(amount) <= 0) {
      return NextResponse.json({ error: 'invalid_input', message: 'Amount must be a positive decimal with up to 6 places.' }, { status: 400 })
    }

    const operator = await readJson(executionUrl('/api/execution/operator/status'))
    const capital = operator?.capital_plane || {}
    const spendable = Number(capital?.balances?.available_to_deploy || 0)
    const treasuryFundingMode = String(capital?.treasury?.funding_mode || '')
    if (scope === 'trading' && Number(amount) > spendable) {
      return NextResponse.json(
        { error: 'insufficient_spendable_balance', message: `Only ${spendable.toFixed(6)} USDC is currently deployable from the trading budget.` },
        { status: 409 },
      )
    }

    const chainConfig = resolveSendChainConfig()

    if (token === 'USDC') {
      try {
        const { adapter, signerAddress } = createAdapterForExecution()
        const kit = getAppKit()
        getKitKey()
        const shouldUseGatewayFunding = scope === 'trading' || treasuryFundingMode === 'legacy-circle'
        const gatewayFunding = shouldUseGatewayFunding && chainConfig.gatewayKey
          ? await fundSignerFromGateway({
              amount,
              recipient: signerAddress,
              destinationKey: chainConfig.gatewayKey,
            })
          : null

        const step = await kit.send({
          from: {
            adapter,
            chain: chainConfig.appKitChain,
          },
          to,
          amount,
          token,
        })

        return NextResponse.json({
          ...summarizeSend(step),
          amount,
          token,
          to,
          signerAddress,
          source: 'circle-app-kit',
          sendChain: chainConfig.appKitChain,
          gatewayFunding,
          transferLogId: gatewayFunding?.transfer_id || `snd_${Date.now()}`,
          detail: shouldUseGatewayFunding
            ? `USDC funded from Gateway and sent on ${chainConfig.appKitChain} through Circle App Kit.`
            : `USDC sent directly from the Polygon-first Miroshark treasury signer on ${chainConfig.appKitChain}.`,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('CIRCLE_KIT_KEY') || message.includes('signing key')) {
          return NextResponse.json(await directGatewaySend({ amount, recipient: to }))
        }
        throw error
      }
    }

    const { adapter, signerAddress } = createAdapterForExecution()
    const kit = getAppKit()
    const step = await kit.send({
      from: {
        adapter,
        chain: chainConfig.appKitChain,
      },
      to,
      amount,
      token,
      config: {
        kitKey: getKitKey(),
      },
    })

    return NextResponse.json({
      ...summarizeSend(step),
      amount,
      token,
      to,
      signerAddress,
      source: 'circle-app-kit',
      sendChain: chainConfig.appKitChain,
      transferLogId: `snd_${Date.now()}`,
      detail: `${token} sent on ${chainConfig.appKitChain} through Circle App Kit.`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'send_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
