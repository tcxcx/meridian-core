import { NextResponse } from 'next/server'

import {
  canUseSwapChain,
  createAdapterForExecution,
  getAppKit,
  getKitKey,
  getExecutionSignerAddress,
  resolveSwapChainConfig,
  summarizeSwap,
} from '@/lib/server/circle-app-kit'
import { executionUrl, readJson } from '@/lib/server/service-clients'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null)
    const from = String(body?.from || '').trim().toUpperCase()
    const to = String(body?.to || '').trim().toUpperCase()
    const amount = String(body?.amount || '').trim()
    const scope = String(body?.scope || 'treasury').trim().toLowerCase()

    if (!['USDC', 'EURC'].includes(from) || !['USDC', 'EURC'].includes(to) || from === to) {
      return NextResponse.json({ error: 'invalid_input', message: 'Swap must move between USDC and EURC.' }, { status: 400 })
    }
    if (!DECIMAL_RE.test(amount) || Number(amount) <= 0) {
      return NextResponse.json({ error: 'invalid_input', message: 'Amount must be a positive decimal with up to 6 places.' }, { status: 400 })
    }

    const operator = await readJson(executionUrl('/api/execution/operator/status'))
    const capital = operator?.capital_plane || {}
    const spendable = Number(capital?.balances?.available_to_deploy || 0)
    if (scope === 'trading' && from === 'USDC' && Number(amount) > spendable) {
      return NextResponse.json(
        { error: 'insufficient_spendable_balance', message: `Only ${spendable.toFixed(6)} USDC is currently deployable from the trading budget.` },
        { status: 409 },
      )
    }

    const chainConfig = resolveSwapChainConfig()
    if (!canUseSwapChain(chainConfig)) {
      return NextResponse.json(
        {
          error: 'swap_chain_unsupported',
          message: `Circle App Kit same-chain swap is not available on ${chainConfig.appKitChain}. Set MIROSHARK_SWAP_CHAIN=Polygon for mainnet swaps.`,
        },
        { status: 503 },
      )
    }

    const { adapter, signerAddress } = createAdapterForExecution()
    const kit = getAppKit()
    const result = await kit.swap({
      from: {
        adapter,
        chain: chainConfig.appKitChain,
      },
      tokenIn: from,
      tokenOut: to,
      amountIn: amount,
      config: {
        kitKey: getKitKey(),
      },
    })

    return NextResponse.json({
      ...summarizeSwap(result),
      amountIn: result.amountIn,
      tokenIn: result.tokenIn,
      tokenOut: result.tokenOut,
      chain: result.chain,
      signerAddress,
      detail: `${from} → ${to} executed through Circle App Kit on ${chainConfig.appKitChain}${scope === 'trading' ? ' from the trading budget.' : ' from the Polygon-first treasury / hedge rail.'}`,
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'swap_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
