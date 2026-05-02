'use client'

import { useEffect, useMemo, useState } from 'react'

import DialogShell from '@/components/miroshark/dialog-shell'
import { createTreasurySmartAccount, loginTreasuryCredential, connectTreasurySmartAccount } from '@/lib/circle/modular-client'
import { computeThreshold, createSigner, normalizeWeights, rebalanceWeights, weightToPct } from '@/lib/multisig-plan'

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

function ResultBanner({ tone = 'ok', children }) {
  return <div className={`msk-result ${tone}`}>{children}</div>
}

function ActionButton({ children, ...props }) {
  return <button type="button" className="msk-primary" {...props}>{children}</button>
}

function SecondaryButton({ children, ...props }) {
  return <button type="button" className="msk-secondary" {...props}>{children}</button>
}

const SIGNER_ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'device', label: 'Device' },
  { value: 'recovery', label: 'Recovery' },
  { value: 'member', label: 'Observer' },
]

function DepositDialog({ open, onClose, capitalPlane }) {
  const domainRows = capitalPlane?.per_domain || []
  return (
    <DialogShell open={open} onClose={onClose} title="Deposit" subtitle="Circle Gateway">
      <p className="msk-copy">
        Add USDC to the treasury balance.
      </p>
      <div className="msk-note-block">
        <div className="msk-note-title">Targets</div>
        <ul className="msk-list">
          {domainRows.map((item) => (
            <li key={item.key}>
              {item.label}: {item.role}
            </li>
          ))}
        </ul>
      </div>
      <div className="msk-link-row">
        <a className="msk-link-btn" href="https://www.circle.com/gateway" target="_blank" rel="noreferrer">Gateway</a>
        <a className="msk-link-btn" href="https://developers.circle.com" target="_blank" rel="noreferrer">Wallets</a>
      </div>
      <ResultBanner tone="info">
        Reserve {formatUsd(capitalPlane?.treasury?.gateway_balance_usdc || 0)} · Target {formatUsd(capitalPlane?.trading?.target_balance_usdc || 0)}
      </ResultBanner>
    </DialogShell>
  )
}

function SendDialog({ open, onClose, capitalPlane }) {
  const [token, setToken] = useState('USDC')
  const [scope, setScope] = useState('treasury')
  const [recipient, setRecipient] = useState('')
  const [amount, setAmount] = useState('1')
  const [balance, setBalance] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    fetch('/api/gateway/balance', { cache: 'no-store' })
      .then((response) => response.json())
      .then((payload) => {
        if (!cancelled) setBalance(payload)
      })
      .catch(() => {
        if (!cancelled) setBalance(null)
      })
    return () => {
      cancelled = true
    }
  }, [open])

  const submit = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, to: recipient, amount, scope }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setResult(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Send" subtitle="Treasury / trading rail">
      <p className="msk-copy">
        Send USDC or EURC.
      </p>
      <div className="msk-balance-grid">
        <span>Deployable</span>
        <strong>{formatUsd(balance?.spendableAvailable || 0)}</strong>
        <span>Total</span>
        <strong>{formatUsd(balance?.grandTotal || 0)}</strong>
        <span>Source</span>
        <strong>{capitalPlane?.treasury?.funding_mode || balance?.treasuryFundingMode || 'unknown'}</strong>
        <span>Fallback</span>
        <strong>{balance?.legacyCircleTreasuryAddress ? 'fallback only' : 'none'}</strong>
      </div>
      <div className="msk-field">
        <label>Funding scope</label>
        <div className="msk-toggle-row">
          {[
            ['treasury', 'Treasury'],
            ['trading', 'Trading'],
          ].map(([value, label]) => (
            <button key={value} type="button" className={`msk-chip ${scope === value ? 'active' : ''}`} onClick={() => setScope(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="msk-field">
        <label>Token</label>
        <div className="msk-toggle-row">
          {['USDC', 'EURC'].map((item) => (
            <button key={item} type="button" className={`msk-chip ${token === item ? 'active' : ''}`} onClick={() => setToken(item)}>
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="msk-field">
        <label>Recipient</label>
        <input className="msk-input" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="0x..." />
      </div>
      <div className="msk-field">
        <label>Amount</label>
        <input className="msk-input" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" />
      </div>
      {error ? <ResultBanner tone="err">{error}</ResultBanner> : null}
      {result ? (
        <ResultBanner tone={result.state === 'planned' ? 'info' : 'ok'}>
          {result.detail || `${result.state} ${result.token} transfer prepared`}
        </ResultBanner>
      ) : null}
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Send'}</ActionButton>
    </DialogShell>
  )
}

function BridgeDialog({ open, onClose, capitalPlane }) {
  const [amount, setAmount] = useState('1')
  const [recipient, setRecipient] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const routeLabel = `${capitalPlane?.treasury_funding_chain?.label || capitalPlane?.settlement_chain?.label || 'Polygon treasury rail'} → ${capitalPlane?.primary_trading_chain?.label || 'Polygon'}`

  const submit = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/bridge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount, recipient: recipient || undefined }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setResult(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Bridge" subtitle="Circle Gateway">
      <p className="msk-copy">
        Move USDC between rails.
      </p>
      <div className="msk-route-card">
        <span>{routeLabel}</span>
        <strong>Unified USDC</strong>
      </div>
      <div className="msk-field">
        <label>Amount</label>
        <input className="msk-input" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" />
      </div>
      <div className="msk-field">
        <label>Recipient</label>
        <input className="msk-input" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="optional 0x" />
      </div>
      {error ? <ResultBanner tone="err">{error}</ResultBanner> : null}
      {result ? (
        <ResultBanner tone="ok">
          Submitted. {Array.isArray(result.steps) ? `${result.steps.length} step${result.steps.length === 1 ? '' : 's'}.` : ''}
        </ResultBanner>
      ) : null}
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Bridging…' : 'Bridge'}</ActionButton>
    </DialogShell>
  )
}

function SwapDialog({ open, onClose, capitalPlane }) {
  const [from, setFrom] = useState('USDC')
  const [to, setTo] = useState('EURC')
  const [amount, setAmount] = useState('5')
  const [scope, setScope] = useState('treasury')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)

  const submit = async () => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const response = await fetch('/api/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, amount, scope }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setResult(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Swap" subtitle="Hedge rail">
      <p className="msk-copy">
        Rebalance inventory.
      </p>
      <div className="msk-balance-grid">
        <span>Mode</span>
        <strong>{capitalPlane?.treasury?.funding_mode || 'unknown'}</strong>
        <span>Scope</span>
        <strong>{scope}</strong>
      </div>
      <div className="msk-field">
        <label>Funding scope</label>
        <div className="msk-toggle-row">
          {[
            ['treasury', 'Treasury'],
            ['trading', 'Trading'],
          ].map(([value, label]) => (
            <button key={value} type="button" className={`msk-chip ${scope === value ? 'active' : ''}`} onClick={() => setScope(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="msk-dual-grid">
        <div className="msk-field">
          <label>From</label>
          <div className="msk-toggle-row">
            {['USDC', 'EURC'].map((item) => (
              <button key={item} type="button" className={`msk-chip ${from === item ? 'active' : ''}`} disabled={to === item} onClick={() => setFrom(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
        <div className="msk-field">
          <label>To</label>
          <div className="msk-toggle-row">
            {['USDC', 'EURC'].map((item) => (
              <button key={item} type="button" className={`msk-chip ${to === item ? 'active' : ''}`} disabled={from === item} onClick={() => setTo(item)}>
                {item}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="msk-field">
        <label>Amount</label>
        <input className="msk-input" value={amount} onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} inputMode="decimal" />
      </div>
      {error ? <ResultBanner tone="err">{error}</ResultBanner> : null}
      {result ? <ResultBanner tone="info">{result.detail || 'Swap queued'}</ResultBanner> : null}
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Preparing…' : 'Swap'}</ActionButton>
    </DialogShell>
  )
}

export function TreasurySetupPanel({ open = true, onClose = () => {}, embedded = false, onProvisioned = null }) {
  const [config, setConfig] = useState(null)
  const [plan, setPlan] = useState(null)
  const [busy, setBusy] = useState(false)
  const [inviteBusyId, setInviteBusyId] = useState('')
  const [passkeyBusy, setPasskeyBusy] = useState(false)
  const [sessionBusy, setSessionBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [passkeyEmail, setPasskeyEmail] = useState('')
  const [deviceLabel, setDeviceLabel] = useState('Passkey')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    Promise.all([
      fetch('/api/treasury/passkey/config', { cache: 'no-store' }).then((response) => response.json()),
      fetch('/api/treasury/multisig', { cache: 'no-store' }).then((response) => response.json()),
    ]).then(([configPayload, planPayload]) => {
      if (cancelled) return
      setConfig(configPayload)
      setPlan(planPayload)
      setPasskeyEmail((current) => current || configPayload?.actor?.email || '')
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (typeof navigator === 'undefined') return
    setDeviceLabel(/Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Apple Passkey' : 'Device passkey')
  }, [])

  const updateWeight = (signerId, nextWeight) => {
    setPlan((current) => {
      if (!current) return current
      const nextWeights = { ...normalizeWeights(current.signers, current.weights), [signerId]: Number(nextWeight) }
      const threshold = computeThreshold(nextWeights)
      return { ...current, weights: nextWeights, ...threshold }
    })
  }

  const updateSigner = (signerId, patch) => {
    setPlan((current) => {
      if (!current) return current
      const signers = (current.signers || []).map((signer) => signer.id === signerId ? { ...signer, ...patch } : signer)
      const weights = patch.role ? normalizeWeights(signers, rebalanceWeights(signers)) : normalizeWeights(signers, current.weights || {})
      return { ...current, signers, weights, ...computeThreshold(weights) }
    })
  }

  const addSigner = (role = 'admin') => {
    setPlan((current) => {
      if (!current) return current
      const nextSigner = createSigner({ role })
      const signers = [...(current.signers || []), nextSigner]
      const weights = normalizeWeights(signers, rebalanceWeights(signers))
      return { ...current, signers, weights, ...computeThreshold(weights) }
    })
  }

  const removeSigner = (signerId) => {
    setPlan((current) => {
      if (!current) return current
      const signers = (current.signers || []).filter((signer) => signer.id !== signerId || signer.isBootstrap)
      const weights = normalizeWeights(signers, rebalanceWeights(signers))
      return { ...current, signers, weights, ...computeThreshold(weights) }
    })
  }

  const rebalance = () => {
    setPlan((current) => {
      if (!current) return current
      const signers = current.signers || []
      const nextWeights = {}
      const active = signers.filter((signer) => signer.role !== 'member')
      const each = active.length ? Math.floor(1000 / active.length) : 0
      for (const signer of active) nextWeights[signer.id] = each
      return { ...current, weights: nextWeights, ...computeThreshold(nextWeights) }
    })
  }

  const savePlan = async () => {
    if (!plan) return
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/treasury/multisig', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(plan),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setPlan(payload)
      setMessage('Signer plan saved.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sendInvite = async (signerId) => {
    setInviteBusyId(signerId)
    setError('')
    setMessage('')
    try {
      if (plan) {
        const saveResponse = await fetch('/api/treasury/multisig', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(plan),
        })
        const savePayload = await saveResponse.json()
        if (!saveResponse.ok) throw new Error(savePayload?.message || savePayload?.error || `HTTP ${saveResponse.status}`)
        setPlan(savePayload)
      }

      const response = await fetch('/api/treasury/multisig/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signerId }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      setPlan((current) => {
        if (!current) return current
        const signers = (current.signers || []).map((signer) => signer.id === signerId
          ? { ...signer, ...(payload.signer || {}), status: payload?.signer?.status || 'invited' }
          : signer)
        return { ...current, signers }
      })
      setMessage(`Invite sent to ${payload?.invitation?.emailAddress || 'signer'}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setInviteBusyId('')
    }
  }

  const createPasskey = async () => {
    setPasskeyBusy(true)
    setError('')
    setMessage('')
    try {
      const wallet = await createTreasurySmartAccount({
        label: passkeyEmail || config?.actor?.email || 'Miroshark Treasury',
        agentWalletAddress: config?.agentWalletAddress || undefined,
      })

      const persistResponse = await fetch('/api/treasury/modular/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wallet),
      })
      const persistPayload = await persistResponse.json()
      if (!persistResponse.ok) {
        throw new Error(persistPayload?.message || persistPayload?.error || `HTTP ${persistResponse.status}`)
      }

      const sessionResponse = await fetch('/api/treasury/modular/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wallet),
      })
      const sessionPayload = await sessionResponse.json()
      if (!sessionResponse.ok) {
        throw new Error(sessionPayload?.message || sessionPayload?.error || `HTTP ${sessionResponse.status}`)
      }

      setConfig((current) => ({
        ...(current || {}),
        credentials: persistPayload.credentials || current?.credentials || [],
        wallet: persistPayload.wallet || current?.wallet || null,
        session: sessionPayload.session || current?.session || null,
      }))
      await onProvisioned?.()
      setMessage(
        `Treasury smart account ready on ${wallet.chain}: ${wallet.walletAddress.slice(0, 10)}…${wallet.walletAddress.slice(-6)}`,
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('AbortError') || message.includes('NotAllowedError')) {
        setMessage('Passkey creation cancelled.')
      } else if (message.includes('username is duplicated')) {
        setError('Circle already used that passkey username. Refresh and try again; new attempts now use a unique internal name.')
      } else if (message.includes('relying party ID') || message.includes('webauthn')) {
        setError(`Passkey domain mismatch. This Circle client key must use passkey domain "${expectedRpId}".`)
      } else {
        setError(message)
      }
    } finally {
      setPasskeyBusy(false)
    }
  }

  const reconnectPasskey = async () => {
    if (!config?.wallet?.walletAddress) {
      setError('No treasury smart account is saved yet.')
      return
    }
    if (config?.circle?.modularChain === 'Polygon') {
      const proceed = typeof window === 'undefined'
        ? false
        : window.confirm('Reconnect Polygon mainnet treasury?')
      if (!proceed) return
    }

    setSessionBusy(true)
    setError('')
    setMessage('')
    try {
      const credentialUsername = config?.wallet?.credentialUsername
        || sessionState?.credentialUsername
        || config?.credentials?.find((item) => item.id === config?.wallet?.credentialId)?.username
        || 'Miroshark Treasury'
      const savedCredential = config?.credentials?.find((item) => item.id === config?.wallet?.credentialId)
      const credential = await loginTreasuryCredential({
        label: credentialUsername,
        credentialId: config?.wallet?.credentialId || savedCredential?.id,
        publicKey: config?.wallet?.publicKey || savedCredential?.publicKey,
        rpId: savedCredential?.rpId || config?.rpId,
      })
      const wallet = await connectTreasurySmartAccount({
        credential,
        walletAddress: config.wallet.walletAddress,
        label: credentialUsername,
        agentWalletAddress: config?.agentWalletAddress || undefined,
      })

      const sessionResponse = await fetch('/api/treasury/modular/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...wallet,
          credentialId: credential.id,
          credentialUsername,
        }),
      })
      const sessionPayload = await sessionResponse.json()
      if (!sessionResponse.ok) {
        throw new Error(sessionPayload?.message || sessionPayload?.error || `HTTP ${sessionResponse.status}`)
      }

      setConfig((current) => ({
        ...(current || {}),
        session: sessionPayload.session || null,
      }))
      setMessage(`Treasury passkey session reconnected for ${wallet.walletAddress.slice(0, 10)}…${wallet.walletAddress.slice(-6)}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (message.includes('AbortError') || message.includes('NotAllowedError')) {
        setMessage('Passkey login cancelled.')
      } else {
        setError(message)
      }
    } finally {
      setSessionBusy(false)
    }
  }

  const clearSession = async () => {
    setSessionBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/treasury/modular/session', {
        method: 'DELETE',
      })
      const payload = await response.json()
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      }
      setConfig((current) => ({
        ...(current || {}),
        session: null,
      }))
      setMessage('Treasury passkey session cleared.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSessionBusy(false)
    }
  }

  const walletState = config?.wallet
  const sessionState = config?.session
  const plannedAgentWallet = walletState?.registeredRecipients?.[0] || config?.agentWalletAddress || null
  const browserHost = typeof window === 'undefined' ? '' : window.location.hostname
  const expectedRpId = config?.rpId || 'localhost'
  const rpCompatible = config?.rpCompatible !== false
  const clientReady = Boolean(config?.circle?.clientKeyReady && config?.circle?.clientUrlReady)
  const normalizedEmail = passkeyEmail.trim()
  const emailReady = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  const createDisabled = passkeyBusy || !clientReady || !rpCompatible || !emailReady
  const hostPort = typeof window === 'undefined' ? '3301' : window.location.port
  const canonicalUrl = `${config?.canonicalOrigin || `http://${expectedRpId}${hostPort ? `:${hostPort}` : ''}`}/setup/treasury`
  const walletPreview = walletState?.walletAddress
    ? `${walletState.walletAddress.slice(0, 10)}…${walletState.walletAddress.slice(-6)}`
    : ''
  const agentPreview = plannedAgentWallet
    ? `${plannedAgentWallet.slice(0, 10)}…${plannedAgentWallet.slice(-6)}`
    : ''

  const content = (
    <div className="treasury-zen">
      <div className="treasury-zen-intro">
        <div className="treasury-zen-state">{walletState?.walletAddress ? 'passkey ready' : 'email + this device'}</div>
        <h3 className="treasury-zen-title">Create passkey</h3>
        <p className="treasury-zen-copy">
          {walletState?.walletAddress
            ? 'Your treasury wallet is protected by this device.'
            : 'Use your email and this device to protect the treasury wallet.'}
        </p>
      </div>

      <div className="treasury-zen-panel">
        {!walletState?.walletAddress ? (
          <div className="treasury-passkey-form">
            <label className="treasury-passkey-field">
              <span>Email</span>
              <input
                value={passkeyEmail}
                onChange={(event) => setPasskeyEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
                inputMode="email"
              />
            </label>
            <div className="treasury-device-line">
              <span>This device</span>
              <strong>{deviceLabel}</strong>
            </div>
          </div>
        ) : null}

        {!rpCompatible ? (
          <p className="treasury-zen-alert">
            Open on {expectedRpId}, not {browserHost || config?.currentHost || 'this host'}.
            {' '}<a href={canonicalUrl}>Switch</a>
          </p>
        ) : null}
        {!clientReady ? (
          <p className="treasury-zen-alert">Circle modular client key or client URL is missing.</p>
        ) : null}

        <div className="treasury-zen-actions">
          {!walletState?.walletAddress ? (
            <ActionButton disabled={createDisabled} onClick={createPasskey}>
              {passkeyBusy ? 'Creating…' : 'Create passkey'}
            </ActionButton>
          ) : (
            <SecondaryButton disabled={sessionBusy || !walletState?.walletAddress} onClick={reconnectPasskey}>
              {sessionBusy ? 'Connecting…' : sessionState?.connectedAt ? 'Connected' : 'Reconnect'}
            </SecondaryButton>
          )}
        </div>

        {walletPreview ? (
          <div className="treasury-zen-meta">
            <span>{walletPreview}</span>
            <span>{walletState?.chain || config?.circle?.modularChain || 'Polygon'}</span>
          </div>
        ) : null}
        {agentPreview ? <div className="treasury-zen-muted">Agent {agentPreview}</div> : null}
        {config?.circle?.downgradedToTestnet ? <div className="treasury-zen-muted">Polygon Amoy</div> : null}
        {error ? <p className="treasury-zen-error">{error}</p> : null}
        {message ? <p className="treasury-zen-ok">{message}</p> : null}
      </div>
    </div>
  )

  if (embedded) {
    return content
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Treasury" subtitle="Passkey + signers">
      {content}
    </DialogShell>
  )
}

function TreasurySetupDialog({ open, onClose }) {
  return <TreasurySetupPanel open={open} onClose={onClose} />
}

export default function WalletActionModals({ modal, onClose, capitalPlane }) {
  return (
    <>
      <DepositDialog open={modal === 'deposit'} onClose={onClose} capitalPlane={capitalPlane} />
      <SendDialog open={modal === 'send'} onClose={onClose} capitalPlane={capitalPlane} />
      <BridgeDialog open={modal === 'bridge'} onClose={onClose} capitalPlane={capitalPlane} />
      <SwapDialog open={modal === 'swap'} onClose={onClose} capitalPlane={capitalPlane} />
      <TreasurySetupDialog open={modal === 'treasury'} onClose={onClose} />
    </>
  )
}
