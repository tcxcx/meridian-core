import { redirect } from 'next/navigation'

import SetupPageClient from '@/components/setup/setup-page-client'
import { isSetupStepAccessible, readSetupViewData } from '@/lib/server/setup-flow'

export async function renderSetupStepPage(step) {
  const view = await readSetupViewData()
  if (!view.authenticated) {
    redirect(`/sign-in?redirect_url=/setup/${step}`)
  }

  const recommendedStep = view.setup?.recommendedStep || 'workspace'
  if (!isSetupStepAccessible(step, recommendedStep)) {
    redirect(`/setup/${recommendedStep}`)
  }

  return <SetupPageClient routeStep={step} initialStatus={view} />
}
