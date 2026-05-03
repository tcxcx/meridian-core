import 'server-only'

import { NextResponse } from 'next/server'

import { getSwapQuote } from '@repo/uniswap'

/**
 * POST /api/uniswap/quote
 *
 * Bearer-gated read-only quote endpoint. Used by:
 *  - the operator terminal preview rail (before the operator approves a swap)
 *  - the Pinata agent + execution_router when converting non-USDC inflows
 *    (ETH from MoonPay, mainnet token profits) into USDC for Polymarket
 *
 * Auth: same MIROSHARK_AGENT_TOKEN bearer the agent uses for every other
 * write-side service call. No Clerk session required so the agent + Python
 * router can both call it directly.
 *
 * Body: { tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance?, routingPreference? }
 *   amount    — base units (e.g. wei) as a string
 *   swapper   — the wallet that will execute the swap (treasury or agent address)
 *
 * Returns the Uniswap quote summary plus the raw payload for the calldata step.
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
      { error: 'uniswap_not_configured', message: 'Set UNISWAP_API_KEY in apps/app env. Get a key at https://developers.uniswap.org/' },
      { status: 503 },
    )
  }

  let body
  try { body = await request.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const { tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance, routingPreference } = body || {}
  if (!tokenIn || !tokenOut || !amount || !chainId || !swapper) {
    return NextResponse.json({ error: 'invalid_input', message: 'tokenIn, tokenOut, amount, chainId, swapper are all required' }, { status: 400 })
  }

  try {
    const quote = await getSwapQuote({
      tokenIn,
      tokenOut,
      amount,
      chainId: Number(chainId),
      swapper,
      slippageTolerance,
      routingPreference,
    })
    return NextResponse.json(quote)
  } catch (error) {
    return NextResponse.json({ error: 'quote_failed', message: error?.message || String(error) }, { status: 502 })
  }
}
