'use client'

import { useEffect, useMemo, useRef, useState } from 'react'

function formatUsd(value, digits = 2) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function shorten(value, head = 6, tail = 4) {
  const raw = String(value || '')
  if (!raw) return 'pending'
  if (raw.length <= head + tail + 1) return raw
  return `${raw.slice(0, head)}…${raw.slice(-tail)}`
}

function ActionCircle({ icon, label, onClick }) {
  return (
    <button type="button" className="ms-wallet-circle" onClick={onClick}>
      <span className="ms-wallet-circle-icon" aria-hidden="true">{icon}</span>
      <span className="ms-wallet-circle-label">{label}</span>
    </button>
  )
}

export default function WalletGatewayDropdown({
  gatewayBalance,
  capitalPlane,
  onOpenModal,
}) {
  const [open, setOpen] = useState(false)
  const [selectedToken, setSelectedToken] = useState('USDC')
  const [identity, setIdentity] = useState(null)
  const [identityBusy, setIdentityBusy] = useState(false)
  const [identityError, setIdentityError] = useState('')
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/agent-identity/status', { cache: 'no-store' })
      .then((response) => response.json().then((json) => ({ ok: response.ok, json })))
      .then(({ ok, json }) => {
        if (cancelled) return
        if (!ok) throw new Error(json?.error || 'identity_unavailable')
        setIdentity(json.identity || null)
        setIdentityError('')
      })
      .catch((error) => {
        if (cancelled) return
        setIdentity(null)
        setIdentityError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event) => {
      if (!wrapRef.current) return
      if (!wrapRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const spendableNow = Number(gatewayBalance?.spendableAvailable || 0)
  const trackedTotal = Number(gatewayBalance?.grandTotal || 0)
  const treasuryAddress = gatewayBalance?.treasuryAddress || capitalPlane?.treasury?.address || ''
  const tradingAddress = gatewayBalance?.tradingAddress || capitalPlane?.trading?.address || ''
  const treasuryFundingMode = gatewayBalance?.treasuryFundingMode || capitalPlane?.treasury?.funding_mode || 'unknown'
  const identityStateLabel = identity?.registered ? 'registered' : 'unregistered'
  const tokenBalance = selectedToken === 'USDC' ? spendableNow : 0

  const triggerLabel = useMemo(() => {
    return selectedToken === 'USDC'
      ? `$${formatUsd(spendableNow)}`
      : `${formatUsd(tokenBalance)} ${selectedToken}`
  }, [selectedToken, spendableNow, tokenBalance])

  const registerIdentity = async () => {
    setIdentityBusy(true)
    setIdentityError('')
    try {
      const response = await fetch('/api/agent-identity/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setIdentity(payload.identity || null)
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : String(error))
    } finally {
      setIdentityBusy(false)
    }
  }

  const openAction = (action) => {
    setOpen(false)
    onOpenModal(action)
  }

  return (
    <div className="ms-wallet-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`ms-wallet-trigger ${open ? 'is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="ms-wallet-trigger-mark">◎</span>
        <span className="ms-wallet-trigger-body">
          <span className="ms-wallet-trigger-name">Business Wallet</span>
          <span className="ms-wallet-trigger-balance">{triggerLabel}</span>
        </span>
        <span className={`ms-wallet-trigger-chevron ${open ? 'is-open' : ''}`}>▾</span>
      </button>

      {open ? (
        <div className="ms-wallet-panel" role="menu">
          <div className="ms-wallet-panel-head">
            <div className="ms-wallet-avatar">MS</div>
            <div className="ms-wallet-id">
              <div className="ms-wallet-id-name">MiroShark Wallet Gateway</div>
              <div className="ms-wallet-id-meta">{treasuryFundingMode} · treasury {shorten(treasuryAddress)}</div>
            </div>
          </div>

          <div className="ms-wallet-tabs">
            {['USDC', 'EURC'].map((token) => (
              <button
                key={token}
                type="button"
                className={`ms-wallet-tab ${selectedToken === token ? 'is-selected' : ''}`}
                onClick={() => setSelectedToken(token)}
              >
                <span className={`ms-wallet-tab-dot ${token === 'USDC' ? 'usdc' : 'eurc'}`} />
                {token}
              </button>
            ))}
          </div>

          <div className="ms-wallet-balance-card">
            <div className="ms-wallet-service-kicker">Business Wallet Service</div>
            <div className={`ms-wallet-coin ${selectedToken.toLowerCase()}`}>{selectedToken}</div>
            <div className="ms-wallet-amount">
              {selectedToken === 'USDC' ? `$${formatUsd(spendableNow)}` : `${formatUsd(0)} ${selectedToken}`}
            </div>
            <div className="ms-wallet-amount-sub">
              spendable now · ${formatUsd(trackedTotal)} tracked
            </div>

            <div className="ms-wallet-actions">
              <ActionCircle icon="+" label="Deposit" onClick={() => openAction('deposit')} />
              <ActionCircle icon="→" label="Send" onClick={() => openAction('send')} />
              <ActionCircle icon="⇄" label="Swap" onClick={() => openAction('swap')} />
              <ActionCircle icon="⤴" label="Bridge" onClick={() => openAction('bridge')} />
            </div>
          </div>

          <div className="ms-wallet-meta-row">
            <span className="ms-wallet-meta-kicker">Trading wallet</span>
            <span className="ms-wallet-meta-value">{shorten(tradingAddress)}</span>
          </div>

          <div className="ms-wallet-identity-card">
            <div className="ms-wallet-identity-head">
              <div>
                <div className="ms-wallet-service-kicker">0G Agent Identity</div>
                <div className="ms-wallet-identity-title">{identity?.label || 'MiroShark Agent'}</div>
              </div>
              <span className={`ms-wallet-identity-pill ${identity?.registered ? 'is-ready' : 'is-blocked'}`}>
                {identityStateLabel}
              </span>
            </div>
            <div className="ms-wallet-identity-copy">
              Register the prediction-market agent against the funded 0G identity wallet so treasury, trading, and swarm memory share one operator-readable identity surface.
            </div>
            <div className="ms-wallet-identity-grid">
              <div><span>ID</span><strong>{identity?.identityId || 'pending'}</strong></div>
              <div><span>Identity wallet</span><strong>{shorten(identity?.identityAddress || '')}</strong></div>
              <div><span>Agent wallet</span><strong>{shorten(identity?.agentWalletAddress || tradingAddress)}</strong></div>
            </div>
            {identityError ? <div className="ms-wallet-identity-error">{identityError}</div> : null}
            <div className="ms-wallet-identity-actions">
              <button type="button" className="ms-wallet-mini-btn" onClick={registerIdentity} disabled={identityBusy}>
                {identityBusy ? 'Registering…' : identity?.registered ? 'Refresh 0G identity' : 'Register 0G agent'}
              </button>
              {identity?.explorerUrl ? (
                <a className="ms-wallet-mini-btn alt" href={identity.explorerUrl} target="_blank" rel="noreferrer">
                  View 0G wallet
                </a>
              ) : null}
            </div>
          </div>

          <div className="ms-wallet-footer-actions">
            <button type="button" className="ms-wallet-footer-btn" onClick={() => openAction('treasury')}>Treasury setup</button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
