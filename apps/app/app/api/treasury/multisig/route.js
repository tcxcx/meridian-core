import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { buildDefaultMultisigPlan, normalizeWeights, sanitizeSigners } from '@/lib/multisig-plan'
import { readMultisigPlan, writeMultisigPlan } from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const plan = await readMultisigPlan(actor)
  return NextResponse.json(plan)
}

export async function POST(request) {
  try {
    const actor = await getPlatformActor()
    if (!actor.authenticated) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }

    const body = await request.json().catch(() => null)
    const base = await readMultisigPlan(actor)
    const signers = sanitizeSigners(
      Array.isArray(body?.signers) && body.signers.length ? body.signers : base.signers,
      actor,
    )
    const weights = normalizeWeights(signers, body?.weights || base.weights || {})
    const saved = await writeMultisigPlan({
      ...buildDefaultMultisigPlan(actor, base),
      ...body,
      signers,
      weights,
    }, actor)
    return NextResponse.json(saved)
  } catch (error) {
    return NextResponse.json(
      { error: 'multisig_plan_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
