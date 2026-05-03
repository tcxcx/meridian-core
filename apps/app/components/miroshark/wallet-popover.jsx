'use client'

import { useEffect, useRef, useState } from 'react'

// Shared popover shell used by Treasury and Agent dropdowns. Same UI grammar,
// different contents passed as children. The trigger is a header pill that shows
// label + live balance; the panel opens beneath, click-outside or Esc closes.
export default function WalletPopover({ label, balance, balanceSub, accent = false, children, footer }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

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

  return (
    <div className={`wallet-pop ${accent ? 'is-accent' : ''}`} ref={wrapRef}>
      <button
        type="button"
        className={`wallet-pop-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="wallet-pop-trigger-label">{label}</span>
        <strong className="wallet-pop-trigger-balance">{balance}</strong>
        {balanceSub ? <span className="wallet-pop-trigger-sub">{balanceSub}</span> : null}
        <span className={`wallet-pop-chev ${open ? 'is-open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div className="wallet-pop-panel" role="dialog" aria-label={`${label} details`}>
          <div className="wallet-pop-body">{children}</div>
          {footer ? <div className="wallet-pop-foot">{footer}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

// Row helpers — keep the panel grammar consistent across both popovers.
export function WalletRow({ label, value, mono = false, tone = '' }) {
  return (
    <div className={`wallet-pop-row ${tone ? `tone-${tone}` : ''}`}>
      <span className="wallet-pop-row-label">{label}</span>
      <span className={`wallet-pop-row-value ${mono ? 'is-mono' : ''}`}>{value}</span>
    </div>
  )
}

export function WalletDivider({ label }) {
  return <div className="wallet-pop-divider">{label}</div>
}

export function WalletActionRow({ children }) {
  return <div className="wallet-pop-actions">{children}</div>
}

export function WalletAction({ label, hint, onClick, disabled, glyph = '▸', href }) {
  if (href) {
    return (
      <a className="wallet-pop-action" href={href} target="_blank" rel="noreferrer">
        <span className="wallet-pop-action-label">{label}</span>
        {hint ? <span className="wallet-pop-action-hint">{hint}</span> : null}
        <span className="wallet-pop-action-glyph">↗</span>
      </a>
    )
  }
  return (
    <button type="button" className="wallet-pop-action" onClick={onClick} disabled={disabled}>
      <span className="wallet-pop-action-label">{label}</span>
      {hint ? <span className="wallet-pop-action-hint">{hint}</span> : null}
      <span className="wallet-pop-action-glyph">{glyph}</span>
    </button>
  )
}
