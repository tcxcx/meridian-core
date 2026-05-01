import { NextResponse } from 'next/server'

import { readSetupViewData } from '@/lib/server/setup-flow'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  const view = await readSetupViewData()
  if (!view.authenticated) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  return NextResponse.json(view)
}
