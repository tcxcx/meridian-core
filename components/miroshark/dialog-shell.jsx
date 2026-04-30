'use client'

import { useEffect } from 'react'

export default function DialogShell({ open, title, subtitle, children, onClose }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="msk-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="msk-card" role="dialog" aria-modal="true">
        <div className="msk-head">
          <div className="msk-head-copy">
            <span className="msk-title">{title}</span>
            {subtitle ? <span className="msk-subtitle">{subtitle}</span> : null}
          </div>
          <button type="button" className="msk-close" onClick={onClose} aria-label="Close dialog">
            ×
          </button>
        </div>
        <div className="msk-body">{children}</div>
      </div>
    </div>
  )
}
