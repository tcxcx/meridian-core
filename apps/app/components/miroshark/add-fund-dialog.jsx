'use client'

import { useEffect, useMemo, useState } from 'react'

import DialogShell from '@/components/miroshark/dialog-shell'

// Same slugify rules as packages/ens/mint.js. Kept inline so the dialog can
// preview the ENS label live without a server roundtrip.
function slugifyLabel(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

const PARENT = process.env.NEXT_PUBLIC_MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth'

function StatusGlyph({ status }) {
  if (status === 'ok')      return <span className="msk-step-ok">✓</span>
  if (status === 'sending') return <span className="msk-step-pending">●</span>
  if (status === 'skip')    return <span className="msk-step-skip">·</span>
  return <span className="msk-step-pending">◯</span>
}

export default function AddFundDialog({ open, onClose, onCreated }) {
  const [displayName, setDisplayName] = useState('')
  const [ensAlias, setEnsAlias] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [steps, setSteps] = useState([])
  const [createdFund, setCreatedFund] = useState(null)

  useEffect(() => {
    if (!open) {
      setDisplayName('')
      setEnsAlias('')
      setBusy(false)
      setError('')
      setSteps([])
      setCreatedFund(null)
    }
  }, [open])

  const computedLabel = useMemo(() => {
    const aliasSlug = slugifyLabel(ensAlias)
    if (aliasSlug) return aliasSlug
    return slugifyLabel(displayName)
  }, [displayName, ensAlias])

  const willResolveTo = computedLabel ? `${computedLabel}.${PARENT}` : ''

  const submit = async () => {
    if (!displayName.trim()) {
      setError('Give the fund a name.')
      return
    }
    setBusy(true)
    setError('')
    setSteps([])
    setCreatedFund(null)
    try {
      const res = await fetch('/api/funds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: displayName.trim(),
          ensAlias: ensAlias.trim() || undefined,
        }),
      })
      const json = await res.json()
      if (!res.ok) {
        setError(json?.error || `HTTP ${res.status}`)
        if (json?.fund?.provisioning_steps) setSteps(json.fund.provisioning_steps)
        setBusy(false)
        return
      }
      setCreatedFund(json.fund)
      setSteps(json.fund?.provisioning_steps || json.steps || [])
      if (onCreated) onCreated(json.fund)
    } catch (e) {
      setError(e?.message || String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Add fund" subtitle="New tenant + trading wallet + ENS subname">
      {!createdFund ? (
        <>
          <p className="msk-copy">
            Each fund gets its own trading wallet (BURNER_SEED-derived) and an ENS
            subname under <code>{PARENT}</code>. The agent operates from the trading
            wallet; the ENS name + text records make it auditable.
          </p>

          <div className="msk-field">
            <label>Fund name</label>
            <input
              className="msk-input"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Pinata Macro Fund"
              disabled={busy}
              autoFocus
            />
          </div>

          <div className="msk-field">
            <label>ENS alias <span className="msk-hint">(optional — defaults to slug of fund name)</span></label>
            <input
              className="msk-input"
              value={ensAlias}
              onChange={(e) => setEnsAlias(e.target.value)}
              placeholder={`e.g. ${slugifyLabel(displayName) || 'pinata-macro'}`}
              disabled={busy}
            />
          </div>

          {willResolveTo ? (
            <div className="msk-note-block">
              <div className="msk-note-title">Will resolve to</div>
              <div className="msk-resolve-preview">
                <code>{willResolveTo}</code>
              </div>
            </div>
          ) : null}

          {error ? <div className="msk-result err">{error}</div> : null}

          <div className="msk-link-row">
            <button type="button" className="msk-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              type="button"
              className="msk-primary"
              onClick={submit}
              disabled={busy || !displayName.trim() || !computedLabel}
            >
              {busy ? 'Provisioning…' : 'Provision fund'}
            </button>
          </div>

          {busy || steps.length ? (
            <div className="msk-note-block">
              <div className="msk-note-title">Provisioning steps</div>
              <ul className="msk-step-list">
                {steps.length ? steps.map((s, i) => (
                  <li key={`${s.step}-${i}`} className={`msk-step-row is-${s.status || 'pending'}`}>
                    <StatusGlyph status={s.status} />
                    <span className="msk-step-name">{s.step}</span>
                    {s.info?.fullName ? <span className="msk-step-meta">{s.info.fullName}</span> : null}
                    {s.info?.address ? <span className="msk-step-meta">→ {s.info.address.slice(0, 10)}…</span> : null}
                    {s.txHash ? (
                      <a className="msk-step-tx" href={`https://sepolia.etherscan.io/tx/${s.txHash}`} target="_blank" rel="noreferrer">
                        {s.txHash.slice(0, 10)}↗
                      </a>
                    ) : null}
                  </li>
                )) : <li className="msk-step-row"><StatusGlyph status="sending" /><span>contacting server…</span></li>}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <>
          <div className="msk-result ok">
            ✓ Fund provisioned: <strong>{createdFund.display_name}</strong>
          </div>
          <div className="msk-balance-grid">
            <span>Tenant ID</span>
            <strong>{createdFund.tenant_id}</strong>
            <span>ENS name</span>
            <strong>{createdFund.ens_name || '(none)'}</strong>
            <span>Trading wallet</span>
            <strong>{createdFund.trading_address ? `${createdFund.trading_address.slice(0, 6)}…${createdFund.trading_address.slice(-4)}` : '(none)'}</strong>
            <span>Wallet provider</span>
            <strong>
              <span className={`msk-provider-badge is-${createdFund.wallet_provider}`}>
                {createdFund.wallet_provider === 'circle-dcw' ? 'Circle DCW' : 'Seed-derived'}
              </span>
            </strong>
            <span>Status</span>
            <strong>{createdFund.status}</strong>
          </div>
          {createdFund.ens_name ? (
            <div className="msk-link-row">
              <a className="msk-link-btn" href={`https://sepolia.app.ens.domains/${createdFund.ens_name}`} target="_blank" rel="noreferrer">
                View on ENS app ↗
              </a>
              <a className="msk-link-btn" href={`/api/ens/resolve?name=${createdFund.ens_name}`} target="_blank" rel="noreferrer">
                JSON resolve ↗
              </a>
              {createdFund.wallet_provider === 'circle-dcw' && createdFund.trading_wallet_id ? (
                <a className="msk-link-btn" href={`https://console.circle.com/wallets/${createdFund.trading_wallet_id}`} target="_blank" rel="noreferrer">
                  Circle dashboard ↗
                </a>
              ) : null}
            </div>
          ) : null}
          <div className="msk-link-row">
            <button type="button" className="msk-primary" onClick={onClose}>Done</button>
          </div>
        </>
      )}
    </DialogShell>
  )
}
