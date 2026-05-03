/**
 * Uniswap Trading API client (read-only quote + calldata).
 *
 * Used by MiroShark to convert non-USDC treasury inflows (ETH from MoonPay,
 * agent profits in random tokens) into USDC for Polymarket settlement, and to
 * preview swap routes before the operator approves on-chain execution.
 *
 * Execution is intentionally NOT in this module. The Trading API returns a
 * signed-order-ready payload; submission goes through services/execution_router
 * (EOA path) or apps/app/app/api/circle/execute (Circle DCW path) so every
 * spend hits the same approval gate + audit log + Telegram notification.
 *
 * Token catalog covers the assets MiroShark actually touches: stables and
 * majors on Ethereum mainnet (chainId 1) and Base (8453). Polymarket runs on
 * Polygon — when a Polygon path is needed, pass the token address directly.
 */

const UNISWAP_BASE = 'https://trade-api.gateway.uniswap.org/v1'
const MAX_RETRIES = 2
const TIMEOUT_MS = 15_000

// Address regex per the swap-integration skill input-validation rules.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const AMOUNT_RE = /^[0-9]+\.?[0-9]*$/

const TOKEN_ADDRESSES = {
  WETH: { 1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 8453: '0x4200000000000000000000000000000000000006' },
  ETH:  { 1: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 8453: '0x4200000000000000000000000000000000000006' },
  USDC: { 1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 137: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' },
  USDT: { 1: '0xdAC17F958D2ee523a2206206994597C13D831ec7', 8453: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 137: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F' },
  DAI:  { 1: '0x6B175474E89094C44Da98b954EedeAC495271d0F', 8453: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb' },
  EURC: { 1: '0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c', 8453: '0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42' },
  WBTC: { 1: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599' },
  cbBTC: { 1: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 8453: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
}

export function resolveTokenAddress(symbolOrAddress, chainId) {
  if (typeof symbolOrAddress !== 'string') return null
  if (ADDRESS_RE.test(symbolOrAddress)) return symbolOrAddress
  const upper = symbolOrAddress.toUpperCase()
  const entry = TOKEN_ADDRESSES[upper] ?? TOKEN_ADDRESSES[symbolOrAddress]
  return entry?.[chainId] ?? null
}

function getApiKey() {
  return (process.env.UNISWAP_API_KEY || '').trim()
}

async function uniswapPost(endpoint, body) {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error('UNISWAP_API_KEY not configured')

  let lastError = null
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

    let response
    try {
      response = await fetch(`${UNISWAP_BASE}${endpoint}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'x-universal-router-version': '2.0',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      if (err.name === 'AbortError') throw new Error(`Uniswap API timeout (${TIMEOUT_MS}ms) on ${endpoint}`)
      throw err
    } finally {
      clearTimeout(timeout)
    }

    if (response.status === 429 && attempt < MAX_RETRIES) {
      lastError = new Error('rate_limited (429)')
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      continue
    }
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      lastError = new Error(`upstream_${response.status}`)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const code = response.status === 401 ? 'unauthorized'
        : response.status === 403 ? 'forbidden'
        : response.status === 404 ? 'route_not_found'
        : `http_${response.status}`
      throw new Error(`uniswap_${code}: ${text.slice(0, 200)}`)
    }
    return response.json()
  }
  throw lastError ?? new Error('uniswap_max_retries')
}

function validateSwapInputs({ tokenIn, tokenOut, amount, chainId, swapper }) {
  if (!tokenIn || !tokenOut) throw new Error('tokenIn and tokenOut are required')
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('chainId must be a positive integer')
  if (!AMOUNT_RE.test(String(amount))) throw new Error('amount must be a non-negative numeric string in token base units')
  if (!swapper || !ADDRESS_RE.test(swapper)) throw new Error('swapper must be a 0x-prefixed 20-byte address')

  const tokenInAddr = resolveTokenAddress(tokenIn, chainId)
  const tokenOutAddr = resolveTokenAddress(tokenOut, chainId)
  if (!tokenInAddr) throw new Error(`tokenIn "${tokenIn}" not resolvable on chain ${chainId}`)
  if (!tokenOutAddr) throw new Error(`tokenOut "${tokenOut}" not resolvable on chain ${chainId}`)
  if (tokenInAddr.toLowerCase() === tokenOutAddr.toLowerCase()) throw new Error('tokenIn and tokenOut resolve to the same address')

  return { tokenInAddr, tokenOutAddr }
}

/**
 * Get a quote for swapping `amount` of tokenIn → tokenOut on `chainId`.
 *
 * Pure read — no on-chain calls, no signing. Cheap to call repeatedly while
 * the operator is reviewing routes in the UI.
 */
export async function getSwapQuote({ tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance = 0.5, routingPreference = 'CLASSIC' }) {
  const { tokenInAddr, tokenOutAddr } = validateSwapInputs({ tokenIn, tokenOut, amount, chainId, swapper })
  const json = await uniswapPost('/quote', {
    tokenIn: tokenInAddr,
    tokenOut: tokenOutAddr,
    tokenInChainId: String(chainId),
    tokenOutChainId: String(chainId),
    amount: String(amount),
    type: 'EXACT_INPUT',
    swapper,
    slippageTolerance,
    routingPreference,
  })
  const q = json?.quote
  if (!q?.output?.amount) throw new Error('uniswap_invalid_quote_response')
  return {
    routing: json.routing || null,
    requestId: json.requestId || null,
    amountIn: String(amount),
    amountOut: q.output.amount,
    gasUseEstimate: q.gasUseEstimate || null,
    gasFeeUSD: q.gasFeeUSD || null,
    priceImpact: q.priceImpact ?? null,
    slippage: q.slippage ?? slippageTolerance,
    raw: json,
  }
}

/**
 * Build a signed-order-ready calldata payload for the swap.
 *
 * Returns the request body that the executor (services/execution_router or
 * Circle DCW bridge) submits on-chain. This module never broadcasts.
 */
export async function buildSwapCalldata({ tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance = 0.5 }) {
  const quote = await getSwapQuote({ tokenIn, tokenOut, amount, chainId, swapper, slippageTolerance })
  const json = await uniswapPost('/swap', { quote: quote.raw.quote })
  const swap = json?.swap
  if (!swap?.to || !swap?.data) throw new Error('uniswap_invalid_swap_response')
  return {
    to: swap.to,
    from: swap.from || swapper,
    data: swap.data,
    value: swap.value || '0',
    gasLimit: swap.gasLimit || null,
    maxFeePerGas: swap.maxFeePerGas || null,
    maxPriorityFeePerGas: swap.maxPriorityFeePerGas || null,
    chainId,
    quote,
  }
}

/**
 * Check whether the swapper has approved the Universal Router to spend tokenIn.
 * If response.approval is null, no approve tx is needed.
 */
export async function checkApproval({ token, amount, walletAddress, chainId }) {
  if (!walletAddress || !ADDRESS_RE.test(walletAddress)) throw new Error('walletAddress must be a 0x-prefixed 20-byte address')
  if (!AMOUNT_RE.test(String(amount))) throw new Error('amount must be a non-negative numeric string')
  const tokenAddr = resolveTokenAddress(token, chainId)
  if (!tokenAddr) throw new Error(`token "${token}" not resolvable on chain ${chainId}`)
  const json = await uniswapPost('/check_approval', {
    walletAddress,
    token: tokenAddr,
    amount: String(amount),
    chainId,
  })
  return json?.approval ?? null
}

export const UNISWAP_TRADING_BASE = UNISWAP_BASE
