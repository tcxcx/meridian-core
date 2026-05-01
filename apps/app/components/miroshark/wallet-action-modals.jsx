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
        Sendero’s Gateway pattern starts here: deposit USDC into the unified balance, then materialize liquidity only when the swarm wants to trade on Polygon.
      </p>
      <div className="msk-note-block">
        <div className="msk-note-title">Unified balance targets</div>
        <ul className="msk-list">
          {domainRows.map((item) => (
            <li key={item.key}>
              {item.label}: {item.role}
            </li>
          ))}
        </ul>
      </div>
      <div className="msk-link-row">
        <a className="msk-link-btn" href="https://www.circle.com/gateway" target="_blank" rel="noreferrer">Gateway docs</a>
        <a className="msk-link-btn" href="https://developers.circle.com" target="_blank" rel="noreferrer">Circle wallet docs</a>
      </div>
      <ResultBanner tone="info">
        Treasury reserve: {formatUsd(capitalPlane?.treasury?.gateway_balance_usdc || 0)} · Trading target: {formatUsd(capitalPlane?.trading?.target_balance_usdc || 0)}
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
        Same-chain send now prefers Miroshark’s Polygon-first treasury path. Use the trading scope only when you want the 1–5% deployment policy guardrail enforced.
      </p>
      <div className="msk-balance-grid">
        <span>Deployable now</span>
        <strong>{formatUsd(balance?.spendableAvailable || 0)}</strong>
        <span>Tracked total</span>
        <strong>{formatUsd(balance?.grandTotal || 0)}</strong>
        <span>Treasury source</span>
        <strong>{capitalPlane?.treasury?.funding_mode || balance?.treasuryFundingMode || 'unknown'}</strong>
        <span>Legacy Circle</span>
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
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Submitting…' : scope === 'treasury' ? 'Send from treasury rail' : 'Send from trading wallet'}</ActionButton>
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
        This is the Sendero Gateway rail adapted for Miroshark: treasury funding is Polygon-first, while the sponsor settlement hook still lives on Arbitrum Sepolia.
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
        <label>Destination recipient on Polygon</label>
        <input className="msk-input" value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="optional 0x recipient override" />
      </div>
      {error ? <ResultBanner tone="err">{error}</ResultBanner> : null}
      {result ? (
        <ResultBanner tone="ok">
          Bridge submitted. {Array.isArray(result.steps) ? `${result.steps.length} step${result.steps.length === 1 ? '' : 's'}.` : ''}
        </ResultBanner>
      ) : null}
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Bridging…' : 'Bridge into trading rail'}</ActionButton>
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
        Sendero’s swap UX lives here now. In Miroshark, treasury swaps rebalance the Polygon-side reserve and trading swaps stay under deployable-budget discipline.
      </p>
      <div className="msk-balance-grid">
        <span>Funding mode</span>
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
      <ActionButton disabled={busy} onClick={submit}>{busy ? 'Preparing…' : scope === 'treasury' ? 'Swap treasury reserve' : 'Swap trading inventory'}</ActionButton>
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
    }).catch((err) => {
      if (!cancelled) setError(err instanceof Error ? err.message : String(err))
    })
    return () => {
      cancelled = true
    }
  }, [open])

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
    if (config?.circle?.modularChain === 'Polygon') {
      const proceed = typeof window === 'undefined'
        ? false
        : window.confirm('Mainnet provisioning is enabled for the Polygon treasury. Continue to create the production treasury signer and smart account on mainnet?')
      if (!proceed) return
    }
    setPasskeyBusy(true)
    setError('')
    setMessage('')
    try {
      const recoveryAddress = typeof window !== 'undefined'
        ? window.prompt('Optional recovery address for the treasury smart account', '') || ''
        : ''

      const wallet = await createTreasurySmartAccount({
        label: 'Miroshark Treasury',
        recoveryAddress: recoveryAddress.trim() || undefined,
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
        : window.confirm('Mainnet provisioning is enabled for the Polygon treasury. Reconnect this production treasury passkey session on mainnet?')
      if (!proceed) return
    }

    setSessionBusy(true)
    setError('')
    setMessage('')
    try {
      const credential = await loginTreasuryCredential({ label: 'Miroshark Treasury' })
      const wallet = await connectTreasurySmartAccount({
        credential,
        walletAddress: config.wallet.walletAddress,
        label: 'Miroshark Treasury',
        agentWalletAddress: config?.agentWalletAddress || undefined,
      })

      const sessionResponse = await fetch('/api/treasury/modular/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...wallet,
          credentialId: credential.id,
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

  const passkeyCount = config?.credentials?.length || 0
  const walletState = config?.wallet
  const sessionState = config?.session
  const isMainnetProvisioning = config?.circle?.mainnetProvisioning || config?.circle?.modularChain === 'Polygon'
  const plannedAgentWallet = walletState?.registeredRecipients?.[0] || config?.agentWalletAddress || null
  const signers = plan?.signers || []

  const content = (
    <>
      <p className="msk-copy">
        This ceremony now follows the actual desk-v1 private-multisig pattern: bootstrap yourself as the personal signer, invite the other humans by email, then provision the treasury MSCA and expand the passkey set after deployment.
      </p>
      <div className="msk-balance-grid">
        <span>Circle client key</span>
        <strong>{config?.circle?.clientKeyReady ? 'ready' : 'missing'}</strong>
        <span>Circle client URL</span>
        <strong>{config?.circle?.clientUrlReady ? 'ready' : 'missing'}</strong>
        <span>Passkey domain</span>
        <strong>{config?.rpId || 'pending'}</strong>
        <span>Registered passkeys</span>
        <strong>{passkeyCount}</strong>
      </div>
      {isMainnetProvisioning ? (
        <ResultBanner tone="info">
          Mainnet provisioning is active. This ceremony provisions the Polygon treasury signer and smart account for production treasury control.
        </ResultBanner>
      ) : null}
      {config?.circle?.downgradedToTestnet ? (
        <ResultBanner tone="info">
          The configured Circle key is a test client key, so this ceremony is using Polygon Amoy testnet. Use a `LIVE_CLIENT_KEY` to provision a Polygon mainnet treasury.
        </ResultBanner>
      ) : null}
      <div className="msk-note-block">
        <div className="msk-note-title">Circle smart treasury</div>
        <div className="msk-balance-grid">
          <span>Wallet address</span>
          <strong>{walletState?.walletAddress ? `${walletState.walletAddress.slice(0, 10)}…${walletState.walletAddress.slice(-6)}` : 'pending'}</strong>
          <span>Active chain</span>
          <strong>{walletState?.chain || config?.circle?.modularChain || 'pending'}</strong>
          <span>Recovery</span>
          <strong>{walletState?.recoveryRegistered ? 'registered' : 'optional'}</strong>
          <span>Passkey session</span>
          <strong>{sessionState?.connectedAt ? 'connected' : 'idle'}</strong>
          <span>Registry plugin</span>
          <strong>{walletState?.addressBookInstalled ? 'installed' : 'pending'}</strong>
          <span>Agent wallet</span>
          <strong>{plannedAgentWallet ? `${plannedAgentWallet.slice(0, 10)}…${plannedAgentWallet.slice(-6)}` : 'missing'}</strong>
        </div>
        {plannedAgentWallet ? (
          <div className="msk-mini-copy">
            Initial registered recipients: {walletState?.registeredRecipients?.length ? walletState.registeredRecipients.join(', ') : plannedAgentWallet}
          </div>
        ) : null}
      </div>
      <div className="msk-note-block">
        <div className="msk-note-title">Signer plan</div>
        <div className="msk-weight-stack">
          {signers.map((signer) => (
            <label key={signer.id} className="msk-weight-row">
              <div className="msk-weight-head">
                <span>{signer.label}</span>
                <span>{weightToPct(plan?.weights?.[signer.id] || 0)}%</span>
              </div>
              <div className="msk-dual-grid">
                <input
                  className="msk-input"
                  value={signer.label}
                  onChange={(event) => updateSigner(signer.id, { label: event.target.value })}
                  disabled={signer.isBootstrap}
                  placeholder="Signer label"
                />
                <input
                  className="msk-input"
                  value={signer.email || ''}
                  onChange={(event) => updateSigner(signer.id, { email: event.target.value.trim().toLowerCase(), status: 'draft' })}
                  disabled={signer.isBootstrap}
                  placeholder="name@example.com"
                />
              </div>
              <div className="msk-dual-grid">
                <select
                  className="msk-input"
                  value={signer.role}
                  disabled={signer.isBootstrap}
                  onChange={(event) => updateSigner(signer.id, { role: event.target.value, status: signer.status === 'accepted' ? 'accepted' : 'draft' })}
                >
                  {SIGNER_ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <input
                  className="msk-input"
                  value={
                    signer.isBootstrap
                      ? 'Bootstrap owner'
                      : signer.status === 'accepted'
                        ? 'Accepted'
                        : signer.status === 'invited'
                          ? 'Invitation sent'
                          : signer.role === 'recovery'
                            ? 'Recovery signer'
                            : 'Pending invite'
                  }
                  readOnly
                />
              </div>
              <input
                type="range"
                min="0"
                max="1000"
                step="50"
                value={plan?.weights?.[signer.id] || 0}
                onChange={(event) => updateWeight(signer.id, event.target.value)}
                disabled={signer.role === 'member'}
              />
              <span className="msk-mini-copy">
                {signer.role} · {signer.email || 'email required'}{signer.invitedAt ? ` · invited ${new Date(signer.invitedAt).toLocaleDateString()}` : ''}
              </span>
              <div className="msk-btn-row">
                {!signer.isBootstrap ? (
                  <>
                    <SecondaryButton
                      disabled={inviteBusyId === signer.id || !signer.email}
                      onClick={() => sendInvite(signer.id)}
                    >
                      {inviteBusyId === signer.id ? 'Inviting…' : signer.status === 'invited' ? 'Re-send invite' : 'Send invite'}
                    </SecondaryButton>
                    <SecondaryButton onClick={() => removeSigner(signer.id)}>
                      Remove
                    </SecondaryButton>
                  </>
                ) : (
                  <span className="msk-mini-copy">This signer is you. It becomes the bootstrap passkey on this device.</span>
                )}
              </div>
            </label>
          ))}
        </div>
        <div className="msk-threshold-row">
          <span>Threshold</span>
          <strong>{plan?.thresholdPct || 0}% · {plan?.threshold || 0}/{plan?.totalWeight || 0}</strong>
        </div>
        <div className="msk-btn-row">
          <SecondaryButton onClick={() => addSigner('admin')}>Add signer</SecondaryButton>
          <SecondaryButton onClick={() => addSigner('recovery')}>Add recovery</SecondaryButton>
          <SecondaryButton onClick={rebalance}>Rebalance equally</SecondaryButton>
          <SecondaryButton disabled={busy} onClick={savePlan}>{busy ? 'Saving…' : 'Save signer plan'}</SecondaryButton>
        </div>
      </div>
      <div className="msk-note-block">
        <div className="msk-note-title">Passkey ceremony</div>
        <ul className="msk-list">
          <li>Save the signer plan, then send the email invites for each non-bootstrap signer.</li>
          <li>Create the Circle smart treasury with your bootstrap passkey on this device.</li>
          <li>Recovery signers join later through their invite and can be weighted before funds move.</li>
          <li>Reconnect with WebAuthn login later instead of registering a new owner.</li>
        </ul>
        <div className="msk-btn-row">
          <ActionButton disabled={passkeyBusy} onClick={createPasskey}>
            {passkeyBusy
              ? 'Creating…'
              : isMainnetProvisioning
                ? 'Provision Polygon mainnet treasury'
                : 'Create Circle passkey + smart account'}
          </ActionButton>
          <SecondaryButton disabled={sessionBusy || !walletState?.walletAddress} onClick={reconnectPasskey}>
            {sessionBusy ? 'Reconnecting…' : isMainnetProvisioning ? 'Reconnect mainnet treasury passkey' : 'Reconnect existing passkey'}
          </SecondaryButton>
          <SecondaryButton disabled={sessionBusy || !sessionState?.connectedAt} onClick={clearSession}>
            Clear session
          </SecondaryButton>
        </div>
        {sessionState?.connectedAt ? (
          <div className="msk-mini-copy">
            Active session since {new Date(sessionState.connectedAt).toLocaleString()}.
          </div>
        ) : null}
        {config?.credentials?.length ? (
          <div className="msk-credential-list">
            {config.credentials.map((credential) => (
              <div key={credential.id} className="msk-credential-item">
                <span>{credential.id}</span>
                <span>{credential.createdAt ? new Date(credential.createdAt).toLocaleString() : 'saved'}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {error ? <ResultBanner tone="err">{error}</ResultBanner> : null}
      {message ? <ResultBanner tone="ok">{message}</ResultBanner> : null}
    </>
  )

  if (embedded) {
    return content
  }

  return (
    <DialogShell open={open} onClose={onClose} title="Treasury Setup" subtitle="Passkey + weighted multisig">
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
