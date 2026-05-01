import { clerkClient } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

import { getPlatformActor } from '@/lib/server/platform-session'
import { readMultisigPlan, writeMultisigPlan } from '@/lib/server/treasury-state'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function buildRedirectUrl() {
  const origin =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.MIROSHARK_APP_URL ||
    'http://127.0.0.1:3301'
  return `${origin.replace(/\/$/, '')}/sign-up?redirect_url=/setup/treasury`
}

export async function POST(request) {
  try {
    const actor = await getPlatformActor()
    if (!actor.authenticated) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (!process.env.CLERK_SECRET_KEY || !process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
      return NextResponse.json({ error: 'clerk_not_configured' }, { status: 400 })
    }

    const body = await request.json().catch(() => null)
    const signerId = String(body?.signerId || '').trim()
    if (!signerId) {
      return NextResponse.json({ error: 'signer_id_required' }, { status: 400 })
    }

    const plan = await readMultisigPlan(actor)
    const signer = plan.signers.find((item) => item.id === signerId)
    if (!signer) {
      return NextResponse.json({ error: 'signer_not_found' }, { status: 404 })
    }
    if (signer.isBootstrap) {
      return NextResponse.json({ error: 'bootstrap_signer_cannot_be_invited' }, { status: 400 })
    }
    if (!signer.email) {
      return NextResponse.json({ error: 'signer_email_required' }, { status: 400 })
    }

    const client = await clerkClient()
    const invitation = await client.invitations.createInvitation({
      emailAddress: signer.email,
      redirectUrl: buildRedirectUrl(),
      ignoreExisting: true,
      notify: true,
      publicMetadata: {
        app: 'miroshark',
        treasurySigner: true,
        signerId: signer.id,
        signerRole: signer.role,
        signerLabel: signer.label,
        invitedBy: actor.email || actor.userId,
      },
    })

    const signers = plan.signers.map((item) => item.id === signer.id
      ? {
          ...item,
          status: 'invited',
          invitationId: invitation.id,
          invitedAt: invitation.createdAt ? new Date(invitation.createdAt).toISOString() : new Date().toISOString(),
        }
      : item)

    const saved = await writeMultisigPlan({
      ...plan,
      signers,
    }, actor)

    return NextResponse.json({
      ok: true,
      signer: saved.signers.find((item) => item.id === signer.id),
      invitation: {
        id: invitation.id,
        emailAddress: invitation.emailAddress,
        status: invitation.status,
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'multisig_invite_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}
