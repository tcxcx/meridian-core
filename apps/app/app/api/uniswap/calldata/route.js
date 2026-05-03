import 'server-only'

import { NextResponse } from 'next/server'

import { buildSwapCalldata, checkApproval } from '@repo/uniswap'

/**
 * POST /api/uniswap/calldata
 *
 * Bearer-gated. Returns the signed-tx-ready payload + (optional) approval
 * pre-tx. Submission is the caller's responsibility — Python execution_router
 * for EOA wallets, /api/circle/execute for Circle DCW wallets. This route
 * never broadcasts on-chain.
 *
 * Body: { tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance?, includeApproval? }
 *
 * Returns:
 *   {
 *     approval: { to, data, value, ... } | null,   // only when includeApproval=true
 *     swap:     { to, data, value, gasLimit, ... }, // execute-against-Universal-Router payload
 *     quote:    { amountIn, amountOut, priceImpact, ... }
 *   }
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function authorized(request) {
  const expected = (process.env.MIROSHARK_AGENT_TOKEN || '').trim()
  if (!expected) return true
  const provided = (request.headers.get('authorization') || '').trim()
  return provided === `Bearer ${expected}`
}

export async function POST(request) {
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!process.env.UNISWAP_API_KEY) {
    return NextResponse.json(
      { error: 'uniswap_not_configured', message: 'Set UNISWAP_API_KEY in apps/app env.' },
      { status: 503 },
    )
  }

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const { tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance, includeApproval = true } = body || {}
  if (!tokenIn || !tokenOut || !amount || !chainId || !swapper) {
    return NextResponse.json({ error: 'invalid_input', message: 'tokenIn, tokenOut, amount, chainId, swapper are all required' }, { status: 400 })
  }

  try {
    const swap = await buildSwapCalldata({
      tokenIn,
      tokenOut,
      amount,
      chainId: Number(chainId),
      swapper,
      slippageTolerance,
    })

    let approval = null
    if (includeApproval) {
      try {
        approval = await checkApproval({
          token: tokenIn,
          amount,
          walletAddress: swapper,
          chainId: Number(chainId),
        })
      } catch (e) {
        // Approval check is best-effort. If it fails we still return the swap
        // payload — the operator can pre-approve manually if needed.
        approval = { error: e?.message || String(e) }
      }
    }

    return NextResponse.json({
      approval,
      swap: {
        to: swap.to,
        from: swap.from,
        data: swap.data,
        value: swap.value,
        gasLimit: swap.gasLimit,
        maxFeePerGas: swap.maxFeePerGas,
        maxPriorityFeePerGas: swap.maxPriorityFeePerGas,
        chainId: swap.chainId,
      },
      quote: {
        routing: swap.quote.routing,
        requestId: swap.quote.requestId,
        amountIn: swap.quote.amountIn,
        amountOut: swap.quote.amountOut,
        gasUseEstimate: swap.quote.gasUseEstimate,
        gasFeeUSD: swap.quote.gasFeeUSD,
        priceImpact: swap.quote.priceImpact,
        slippage: swap.quote.slippage,
      },
    })
  } catch (error) {
    return NextResponse.json({ error: 'calldata_failed', message: error?.message || String(error) }, { status: 502 })
  }
}
