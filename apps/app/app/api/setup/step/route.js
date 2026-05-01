import { NextResponse } from 'next/server'

import { getSetupStepIndex, resolveRecommendedSetupStep } from '@/lib/server/setup-flow'
import { getPlatformActor } from '@/lib/server/platform-session'
import { synchronizeUserPlatformState } from '@/lib/server/platform-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const VALID_STEPS = new Set(['workspace', 'treasury', 'trading', 'openclaw', 'launch'])

export async function POST(request) {
  const actor = await getPlatformActor()
  if (!actor.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await request.json().catch(() => ({}))
  const step = String(body?.step || '').trim().toLowerCase()
  if (!VALID_STEPS.has(step)) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'step must be one of workspace, treasury, trading, openclaw, launch.' },
      { status: 400 },
    )
  }

  const state = await synchronizeUserPlatformState(actor.userId, {
    setup: {
      currentStep: step,
    },
    profile: {
      email: actor.email,
      displayName: actor.displayName,
    },
  })

  const recommendedStep = resolveRecommendedSetupStep({
    workspaceBootstrapped: Boolean(state.setup?.workspaceBootstrapped),
    treasuryProvisioned: Boolean(state.setup?.treasuryProvisioned),
    tradingWalletReady: Boolean(state.setup?.tradingWalletReady),
    openclawReady: Boolean(state.setup?.openclawReady),
  })
  const nextStep = getSetupStepIndex(step) > getSetupStepIndex(recommendedStep) ? recommendedStep : step

  const nextState = nextStep === step
    ? state
    : await synchronizeUserPlatformState(actor.userId, {
        setup: {
          currentStep: nextStep,
        },
      })

  return NextResponse.json({
    setup: nextState.setup,
  })
}
