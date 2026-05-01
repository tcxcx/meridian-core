import { redirect } from 'next/navigation'

import { readSetupViewData } from '@/lib/server/setup-flow'

export default async function SetupIndexPage() {
  const view = await readSetupViewData()
  if (!view.authenticated) {
    redirect('/sign-in?redirect_url=/setup')
  }

  redirect(`/setup/${view.setup?.recommendedStep || view.setup?.currentStep || 'workspace'}`)
}
