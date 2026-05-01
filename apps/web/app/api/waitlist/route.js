import { appendWaitlistLead } from '../../../../../packages/database/index.js'

export async function POST(request) {
  try {
    const payload = await request.json()
    const record = await appendWaitlistLead({
      email: payload?.email,
      fullName: payload?.fullName,
      organization: payload?.organization,
      note: payload?.note,
      source: 'marketing-web',
    })
    return Response.json({ ok: true, record })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to queue waitlist request.'
    return Response.json({ ok: false, error: message }, { status: 400 })
  }
}
