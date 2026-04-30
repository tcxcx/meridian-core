import { NextResponse } from 'next/server'

import { computeThreshold, DEFAULT_SIGNERS, normalizeWeights } from '@/lib/multisig-plan'
import { readMultisigPlan, writeMultisigPlan } from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const plan = await readMultisigPlan()
  return NextResponse.json(plan)
}

export async function POST(request) {
  try {
    const body = await request.json().catch(() => null)
    const signers = Array.isArray(body?.signers) && body.signers.length ? body.signers : DEFAULT_SIGNERS
    const weights = normalizeWeights(signers, body?.weights || {})
    const threshold = computeThreshold(weights)
    const saved = await writeMultisigPlan({
      signers,
      weights,
      ...threshold,
    })
    return NextResponse.json(saved)
  } catch (error) {
    return NextResponse.json(
      { error: 'multisig_plan_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
