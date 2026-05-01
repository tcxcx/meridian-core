'use client'

import { useState } from 'react'

const INITIAL_FORM = {
  email: '',
  fullName: '',
  organization: '',
  note: '',
}

export default function WaitlistForm() {
  const [form, setForm] = useState(INITIAL_FORM)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState({ type: '', message: '' })

  async function onSubmit(event) {
    event.preventDefault()
    setBusy(true)
    setStatus({ type: '', message: '' })

    try {
      const response = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }
      setStatus({
        type: 'success',
        message: 'Access request queued. We saved your email and operator note for this workspace.',
      })
      setForm(INITIAL_FORM)
    } catch (error) {
      setStatus({
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to queue access request.',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="mw-form-grid" onSubmit={onSubmit}>
      <label className="mw-form-label">
        Email
        <input
          className="mw-input"
          type="email"
          required
          value={form.email}
          onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
          placeholder="operator@fund.tld"
        />
      </label>
      <label className="mw-form-label">
        Full name
        <input
          className="mw-input"
          type="text"
          value={form.fullName}
          onChange={(event) => setForm((current) => ({ ...current, fullName: event.target.value }))}
          placeholder="Lead operator"
        />
      </label>
      <label className="mw-form-label">
        Organization
        <input
          className="mw-input"
          type="text"
          value={form.organization}
          onChange={(event) => setForm((current) => ({ ...current, organization: event.target.value }))}
          placeholder="MiroShark Main Fund"
        />
      </label>
      <label className="mw-form-label">
        What do you want the setup to control?
        <textarea
          className="mw-textarea"
          value={form.note}
          onChange={(event) => setForm((current) => ({ ...current, note: event.target.value }))}
          placeholder="Treasury passkeys, agent wallet policy, Polygon Amoy funding, OpenClaw operator..."
        />
      </label>
      <button className="mw-submit" type="submit" disabled={busy}>
        {busy ? 'Queueing…' : 'Join waitlist'}
      </button>
      <p className="mw-form-note">
        This is a private operator product. The waitlist is an access request queue, not a public marketing funnel.
      </p>
      {status.message ? (
        <p className={`mw-form-status ${status.type === 'success' ? 'is-success' : 'is-error'}`}>
          {status.message}
        </p>
      ) : null}
    </form>
  )
}
