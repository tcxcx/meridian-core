import 'server-only'

import { NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'

/**
 * Internal Circle bridge — POST /api/circle/execute
 *
 * The Python execution_router calls this route to sign+broadcast on-chain
 * transactions through Circle Developer-Controlled Wallets, instead of
 * signing locally with TREASURY_PRIVATE_KEY.
 *
 * Two operations:
 *   { operation: 'transfer',
 *     walletId, destinationAddress, amount, tokenAddress?, blockchain? }
 *   { operation: 'contract',
 *     walletId, contractAddress, abiFunctionSignature, abiParameters,
 *     amount?, blockchain? }
 *
 * Auth: Bearer token via CIRCLE_BRIDGE_TOKEN env (separate from MIROSHARK_AGENT_TOKEN
 * so the agent can't accidentally call this — only our own services can).
 *
 * Response: { id, state, txHash, blockchain, polledStates: [...] }
 *
 * Polling: Circle's createTransaction returns immediately with state=INITIATED.
 * We poll getTransaction every 2s up to 30s and return the latest known state +
 * any txHash that's been published. Caller can re-query if still in flight.
 */
import { isCircleDcwConfigured } from '@/lib/circle/dcw'

function authorized(request) {
  const expected = (process.env.CIRCLE_BRIDGE_TOKEN || '').trim()
  if (!expected) return true  // no token set → open in dev (warn in prod via /health)
  const provided = (request.headers.get('authorization') || '').trim()
  return provided === `Bearer ${expected}`
}

async function pollUntilTerminal(walletsClient, txId, { maxMs = 30_000, stepMs = 2000 } = {}) {
  const polled = []
  const start = Date.now()
  let last = null
  while (Date.now() - start < maxMs) {
    const res = await walletsClient.getTransaction({ id: txId })
    const tx = res?.data?.transaction
    if (!tx) break
    polled.push({ ts: Date.now() - start, state: tx.state, txHash: tx.txHash || null })
    last = tx
    if (tx.state === 'CONFIRMED' || tx.state === 'COMPLETE' || tx.state === 'FAILED' || tx.state === 'CANCELLED') {
      break
    }
    await new Promise((r) => setTimeout(r, stepMs))
  }
  return { final: last, polled }
}

export async function POST(request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!isCircleDcwConfigured()) {
    return NextResponse.json({
      error: 'circle_not_configured',
      message: 'CIRCLE_API_KEY + ENTITY_SECRET not set in apps/app env. /api/funds will use seed-derived wallets; this bridge route returns 503 until Circle is wired.',
    }, { status: 503 })
  }

  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const operation = body?.operation
  if (operation !== 'transfer' && operation !== 'contract') {
    return NextResponse.json({ error: 'operation must be "transfer" or "contract"' }, { status: 400 })
  }

  // Lazy require so the build doesn't bundle the SDK when this route isn't hit.
  const { initiateDeveloperControlledWalletsClient } = await import('@circle-fin/developer-controlled-wallets')
  const walletsClient = initiateDeveloperControlledWalletsClient({
    apiKey: process.env.CIRCLE_API_KEY,
    entitySecret: process.env.CIRCLE_ENTITY_SECRET || process.env.ENTITY_SECRET,
  })

  try {
    const blockchain = (body.blockchain || process.env.CIRCLE_DEFAULT_BLOCKCHAIN || 'ETH-SEPOLIA').toUpperCase()
    let txId, txInitial

    if (operation === 'transfer') {
      const { walletId, destinationAddress, amount, tokenAddress } = body
      if (!walletId || !destinationAddress || amount == null) {
        return NextResponse.json({ error: 'transfer requires walletId + destinationAddress + amount' }, { status: 400 })
      }
      // Circle's createTransaction takes amount as a string in token units.
      const res = await walletsClient.createTransaction({
        walletId,
        destinationAddress,
        amounts: [String(amount)],
        ...(tokenAddress ? { tokenAddress } : {}),
        blockchain,
        idempotencyKey: randomUUID(),
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      })
      txId = res?.data?.id
      txInitial = res?.data
    } else {
      const { walletId, contractAddress, abiFunctionSignature, abiParameters = [], amount = '0' } = body
      if (!walletId || !contractAddress || !abiFunctionSignature) {
        return NextResponse.json({ error: 'contract requires walletId + contractAddress + abiFunctionSignature' }, { status: 400 })
      }
      const res = await walletsClient.createContractExecutionTransaction({
        walletId,
        contractAddress,
        abiFunctionSignature,
        abiParameters,
        amount: String(amount),
        blockchain,
        idempotencyKey: randomUUID(),
        fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
      })
      txId = res?.data?.id
      txInitial = res?.data
    }

    if (!txId) {
      return NextResponse.json({ error: 'circle returned no transaction id', initial: txInitial }, { status: 502 })
    }

    const { final, polled } = await pollUntilTerminal(walletsClient, txId, { maxMs: 30_000, stepMs: 2000 })

    return NextResponse.json({
      id: txId,
      state: final?.state || 'UNKNOWN',
      txHash: final?.txHash || null,
      blockchain: final?.blockchain || blockchain,
      polledStates: polled,
      complete: ['CONFIRMED', 'COMPLETE'].includes(final?.state),
    })
  } catch (error) {
    return NextResponse.json({
      error: error?.message || 'circle execute failed',
      cause: error?.cause?.message || null,
    }, { status: 502 })
  }
}
