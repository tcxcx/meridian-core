'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { SetupProgress as SharedSetupProgress } from '@miroshark/ui/setup-progress'
import { SummaryGrid as SharedSummaryGrid } from '@miroshark/ui/summary-grid'
import { MirosharkUnicornScene } from '../../../../packages/ui/src/components/unicorn-scene.jsx'
import { TreasurySetupPanel } from '@/components/miroshark/wallet-action-modals'
import AddFundDialog from '@/components/miroshark/add-fund-dialog'

const STEP_ORDER = ['workspace', 'treasury', 'trading', 'openclaw', 'launch']

const STEP_META = {
  workspace: {
    label: 'Workspace',
    eyebrow: 'Step 1',
    title: 'Workspace',
    description: 'Create the operator room.',
  },
  treasury: {
    label: 'Treasury',
    eyebrow: 'Step 2',
    title: 'Treasury',
    description: 'Create the passkey wallet.',
  },
  trading: {
    label: 'Trading',
    eyebrow: 'Step 3',
    title: 'Trading',
    description: 'Confirm the agent wallet.',
  },
  openclaw: {
    label: 'OpenClaw',
    eyebrow: 'Step 4',
    title: 'OpenClaw',
    description: 'Connect automation.',
  },
  launch: {
    label: 'Launch',
    eyebrow: 'Step 5',
    title: 'Launch',
    description: 'Open the terminal.',
  },
}

function shorten(value) {
  const raw = String(value || '')
  return raw.length > 18 ? `${raw.slice(0, 10)}…${raw.slice(-6)}` : raw
}

function percentForStep(step) {
  const index = STEP_ORDER.indexOf(step)
  if (index === -1) return 0
  return Math.round(((index + 1) / STEP_ORDER.length) * 100)
}

function StepShell({ title, description, children, bare = false }) {
  return (
    <section className="stage-card setup-stage-card">
      {bare ? null : (
        <>
          <div className="card-title">{title}</div>
          <p className="card-copy">{description}</p>
        </>
      )}
      <div className="setup-stage-body">{children}</div>
    </section>
  )
}

function InfoPanel({ children, tone = 'default' }) {
  return <div className={`setup-note${tone === 'success' ? ' is-success' : tone === 'error' ? ' is-error' : ''}`}>{children}</div>
}

function FieldLabel({ children }) {
  return <span className="field-label">{children}</span>
}

function ActionButton({ children, onClick, href, disabled = false, tone = 'primary' }) {
  const className = tone === 'primary' ? 'primary-btn setup-btn' : 'secondary-btn setup-btn'
  if (href) {
    return <a href={href} className={className}>{children}</a>
  }
  return <button type="button" onClick={onClick} disabled={disabled} className={className}>{children}</button>
}

export default function SetupPageClient({ routeStep, initialStatus = null }) {
  const router = useRouter()
  const [status, setStatus] = useState(initialStatus)
  const [openClawManifest, setOpenClawManifest] = useState(null)
  const [busy, setBusy] = useState(false)
  const [openClawBusy, setOpenClawBusy] = useState(false)
  const [error, setError] = useState('')
  // First-fund creation during onboarding (treasury step). When the user
  // provisions their first fund here, the AddFundDialog handles slug + ENS
  // mint inline; we just track that one was created so the trading step can
  // skip the prompt and the user advances naturally.
  const [addFundOpen, setAddFundOpen] = useState(false)
  const [firstFund, setFirstFund] = useState(null)
  // Pinata Cloud is the recommended hosted-agent option for the OpenClaw step.
  // We poll /api/pinata/status to detect a paired agent and pre-fill the form.
  const [pinataConnector, setPinataConnector] = useState(null)
  const [pinataPingedAt, setPinataPingedAt] = useState(null)
  const [message, setMessage] = useState('')
  const [title, setTitle] = useState(initialStatus?.workspace?.title || 'MiroShark Main Fund')
  const [currentStep, setCurrentStep] = useState(initialStatus?.setup?.currentStep || 'workspace')
  const [openClawForm, setOpenClawForm] = useState({
    endpoint: '',
    apiKey: '',
    operatorName: 'MiroShark Operator',
    model: 'claude-opus',
    manageAgentWallet: true,
    allowTreasuryProvisioning: true,
    notes: 'Manage the agent wallet under policy.',
  })

  const load = async () => {
    const [statusResponse, openClawResponse, pinataResponse] = await Promise.all([
      fetch('/api/setup/status', { cache: 'no-store' }),
      fetch('/api/openclaw/status', { cache: 'no-store' }).catch(() => null),
      fetch('/api/pinata/status', { cache: 'no-store' }).catch(() => null),
    ])
    const payload = await statusResponse.json().catch(() => ({}))
    if (statusResponse.status === 401) {
      router.replace('/sign-in?redirect_url=/setup')
      return
    }
    if (!statusResponse.ok) throw new Error(payload?.error || `HTTP ${statusResponse.status}`)
    setStatus(payload)
    setTitle(payload?.workspace?.title || 'MiroShark Main Fund')
    setCurrentStep(payload?.setup?.currentStep || 'workspace')

    const connector = payload?.automation?.openclaw
    if (connector) {
      setOpenClawForm((current) => ({
        ...current,
        endpoint: connector.endpoint || current.endpoint,
        operatorName: connector.operatorName || current.operatorName,
        model: connector.model || current.model,
        manageAgentWallet: connector.manageAgentWallet ?? current.manageAgentWallet,
        allowTreasuryProvisioning: connector.allowTreasuryProvisioning ?? current.allowTreasuryProvisioning,
        notes: connector.notes || current.notes,
      }))
    }

    if (openClawResponse) {
      const openClawPayload = await openClawResponse.json().catch(() => null)
      setOpenClawManifest(openClawPayload?.manifest || null)
    }

    if (pinataResponse) {
      const pinataPayload = await pinataResponse.json().catch(() => null)
      setPinataConnector(pinataPayload?.connector || null)
      setPinataPingedAt(Date.now())
    }
  }

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }, [])

  const persistStep = async (step, nextPath = null) => {
    const response = await fetch('/api/setup/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
    }
    await load()
    if (nextPath) {
      router.push(nextPath)
    }
  }

  const bootstrap = async () => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/setup/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      await load()
      setMessage('Ready.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const connectOpenClaw = async () => {
    setOpenClawBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/openclaw/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(openClawForm),
      })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      await load()
      setOpenClawForm((current) => ({ ...current, apiKey: '' }))
      setMessage('Connected.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpenClawBusy(false)
    }
  }

  const disconnectOpenClaw = async () => {
    setOpenClawBusy(true)
    setError('')
    setMessage('')
    try {
      const response = await fetch('/api/openclaw/disconnect', { method: 'POST' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`)
      await load()
      setMessage('Removed.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOpenClawBusy(false)
    }
  }

  const setup = status?.setup || {}
  const actor = status?.actor || {}
  const treasury = status?.wallets?.treasury || {}
  const trading = status?.wallets?.trading || {}
  const openclaw = status?.automation?.openclaw || {}
  const persistence = status?.persistence || {}

  const completedSteps = useMemo(() => ({
    workspace: Boolean(setup.workspaceBootstrapped),
    treasury: Boolean(setup.treasuryProvisioned),
    trading: Boolean(setup.tradingWalletReady),
    openclaw: Boolean(setup.openclawReady),
    launch: Boolean(setup.completed),
  }), [setup])

  const workflowStep = setup.recommendedStep || currentStep || 'workspace'
  const displayedStep = STEP_META[routeStep] ? routeStep : workflowStep
  const currentMeta = STEP_META[displayedStep] || STEP_META.workspace
  const progress = percentForStep(workflowStep)

  const activeStep = (() => {
    if (displayedStep === 'workspace') {
      return (
        <StepShell {...currentMeta} routeStep={displayedStep} bare>
          <div className="field-stack">
            <label className="setup-field">
              <FieldLabel>Workspace title</FieldLabel>
              <input
                className="field-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <SharedSummaryGrid items={[
              ['Operator', actor.displayName || 'Unknown operator'],
              ['Persistence', persistence.mode || 'unknown'],
              ['Auth', actor.authEnabled ? 'Clerk' : 'local'],
              ['Room', status?.workspace?.liveblocksRoom || 'Pending'],
            ]} />
            <InfoPanel>
              Creates the room and moves to treasury.
            </InfoPanel>
            <div className="setup-actions">
              <ActionButton onClick={bootstrap} disabled={busy}>
                  {busy ? 'Bootstrapping…' : 'Bootstrap'}
              </ActionButton>
              {setup.workspaceBootstrapped ? (
                <ActionButton tone="secondary" onClick={() => persistStep('treasury', '/setup/treasury').catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  Continue to treasury
                </ActionButton>
              ) : null}
            </div>
          </div>
        </StepShell>
      )
    }

    if (displayedStep === 'treasury') {
      return (
        <div className="treasury-focus-stack">
          <TreasurySetupPanel embedded onProvisioned={load} />
          {setup.treasuryProvisioned ? (
            <>
              <div className="setup-fund-callout">
                <div className="setup-fund-callout-head">
                  <span className="setup-fund-callout-eyebrow">Optional · name your first fund</span>
                  <h3 className="setup-fund-callout-title">
                    {firstFund ? `${firstFund.display_name} provisioned` : 'Give the agent a fund to operate'}
                  </h3>
                </div>
                <p className="setup-fund-callout-copy">
                  Each fund gets its own trading wallet + an ENS subname under{' '}
                  <code>{process.env.NEXT_PUBLIC_MIROSHARK_PARENT_ENS_NAME || 'miroshark.eth'}</code>{' '}
                  (e.g. <code>pinata-fund.miroshark.eth</code>). You can also add more from the operator
                  terminal Agent ▾ popover later.
                </p>
                {firstFund ? (
                  <div className="setup-fund-callout-result">
                    Tenant <strong>{firstFund.tenant_id}</strong> · ENS{' '}
                    <strong>{firstFund.ens_name || '(pending)'}</strong>
                  </div>
                ) : (
                  <ActionButton tone="primary" onClick={() => setAddFundOpen(true)}>
                    + Provision first fund
                  </ActionButton>
                )}
              </div>
              <div className="treasury-focus-next">
                <ActionButton tone="secondary" onClick={() => persistStep('trading', '/setup/trading').catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  Continue
                </ActionButton>
              </div>
            </>
          ) : null}
        </div>
      )
    }

    if (displayedStep === 'trading') {
      return (
        <StepShell {...currentMeta} routeStep={displayedStep}>
          <div className="field-stack">
            <SharedSummaryGrid items={[
              ['Wallet', trading.address ? shorten(trading.address) : 'Pending'],
              ['Ready', setup.tradingWalletReady ? 'yes' : 'not yet'],
              ['Collaboration', setup.collaborationReady ? 'room ready' : 'pending'],
              ['Custody', treasury.sharedWithTrading ? 'funded signer' : 'split wallets'],
            ]} />
            <InfoPanel>
              Confirm the wallet that trades.
            </InfoPanel>
            <div className="setup-actions">
              <ActionButton href="/?onboarding=1">Open operator terminal</ActionButton>
              {setup.tradingWalletReady ? (
                <ActionButton tone="secondary" onClick={() => persistStep('openclaw', '/setup/openclaw').catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  Continue to OpenClaw
                </ActionButton>
              ) : null}
            </div>
          </div>
        </StepShell>
      )
    }

    if (displayedStep === 'openclaw') {
      const pinataConnected = Boolean(pinataConnector?.connected)
      const pinataAgentId = pinataConnector?.agentId || ''
      const pinataTelegram = pinataConnector?.telegramHandle || '@miro_shark_bot'
      const pinataChat = pinataConnector?.agentChatUrl || ''
      const pinataRunState = pinataConnector?.runState || (pinataConnected ? 'idle' : 'offline')

      return (
        <StepShell {...currentMeta} routeStep={displayedStep}>
          <div className="field-stack">

            {/* Pinata-recommended callout — shown above the manual form */}
            <div className={`setup-pinata-callout ${pinataConnected ? 'is-ready' : ''}`}>
              <div className="setup-pinata-callout-head">
                <span className="setup-pinata-callout-eyebrow">Recommended · hosted operator agent</span>
                <h3 className="setup-pinata-callout-title">
                  {pinataConnected
                    ? `Pinata Cloud · ${pinataAgentId} · ${pinataRunState}`
                    : 'Run the operator agent on Pinata Cloud'}
                </h3>
              </div>
              <p className="setup-pinata-callout-copy">
                MiroShark ships with a "Polymarket Trader" workspace overlay (skills,
                tools, agent personality) that drops cleanly into a Pinata-Cloud-hosted
                agent. The agent reaches MiroShark through a Cloudflare Tunnel +
                bearer-auth so it can call <code>probe · swarm · open · settle</code>
                on your behalf and report back through Telegram (<code>{pinataTelegram}</code>).
              </p>

              <ol className="setup-pinata-steps">
                <li className={pinataConnected ? 'is-done' : ''}>
                  <span className="setup-pinata-step-num">1</span>
                  <div className="setup-pinata-step-body">
                    <strong>Create the agent on Pinata Cloud</strong>
                    <span>Pick the "Polymarket Prediction Market Trader" template and pair
                    it with a Telegram bot you own. <a href="https://app.pinata.cloud/agents" target="_blank" rel="noreferrer">Open Pinata ↗</a></span>
                  </div>
                </li>
                <li className={pinataConnected ? 'is-done' : ''}>
                  <span className="setup-pinata-step-num">2</span>
                  <div className="setup-pinata-step-body">
                    <strong>Apply the MiroShark workspace overlay</strong>
                    <span>Run the idempotent overlay script — it pushes
                    <code>MIROSHARK.md</code>, <code>skills/miroshark.md</code>,
                    and edits <code>SOUL.md</code> + <code>TOOLS.md</code> + <code>USER.md</code>
                    into the agent's git repo so it speaks fluent MiroShark verbs.</span>
                    <code className="setup-pinata-cmd">bash apps/app/scripts/redeploy-pinata-agent.sh</code>
                  </div>
                </li>
                <li className={pinataConnected ? 'is-done' : ''}>
                  <span className="setup-pinata-step-num">3</span>
                  <div className="setup-pinata-step-body">
                    <strong>Set <code>MIROSHARK_AGENT_TOKEN</code> + expose the tunnel</strong>
                    <span>Generate a strong token, set it on both the agent (Pinata env) and
                    your local execution-router + signal-gateway. Use a Cloudflare Tunnel on
                    a domain you own (the platform demo uses <code>miro-shark.com</code> with
                    three subdomains: <code>execution.</code>, <code>signal.</code>, <code>cogito.</code>).</span>
                  </div>
                </li>
                <li className={pinataConnected ? 'is-done' : ''}>
                  <span className="setup-pinata-step-num">4</span>
                  <div className="setup-pinata-step-body">
                    <strong>Verify reach-back</strong>
                    <span>Telegram <code>{pinataTelegram}</code> with <code>/status</code> —
                    the agent calls <code>GET /api/execution/operator/status</code> over the
                    bearer-authed tunnel and replies with the operator state.</span>
                    {pinataChat ? (
                      <a className="setup-pinata-chat-link" href={pinataChat} target="_blank" rel="noreferrer">
                        Open the agent chat ↗
                      </a>
                    ) : null}
                  </div>
                </li>
              </ol>

              <div className="setup-pinata-status-row">
                <span className={`setup-pinata-status-dot s-${pinataRunState}`} aria-hidden="true" />
                <span className="setup-pinata-status-label">
                  {pinataConnected
                    ? `Connector live · ${pinataAgentId} · last polled ${pinataPingedAt ? new Date(pinataPingedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}`
                    : 'No Pinata agent paired yet — once steps 1-3 are done, refresh this page.'}
                </span>
                <button
                  type="button"
                  className="setup-pinata-refresh"
                  onClick={() => load().catch(() => null)}
                >Refresh</button>
              </div>
            </div>

            <details className="setup-fallback-details">
              <summary>Or wire a self-hosted OpenClaw / custom HTTP agent</summary>
              <p className="setup-pinata-callout-copy" style={{ marginTop: 8 }}>
                Use this path if you're running OpenClaw on your own infrastructure
                instead of Pinata Cloud. Same execution-router endpoints; you just bring
                your own host + key.
              </p>
            <div className="setup-form-grid">
              <label className="setup-field">
                <FieldLabel>OpenClaw endpoint</FieldLabel>
                <input
                  className="field-input"
                  value={openClawForm.endpoint}
                  onChange={(event) => setOpenClawForm((current) => ({ ...current, endpoint: event.target.value }))}
                  placeholder="https://your-openclaw-host"
                />
              </label>
              <label className="setup-field">
                <FieldLabel>API key</FieldLabel>
                <input
                  className="field-input"
                  value={openClawForm.apiKey}
                  onChange={(event) => setOpenClawForm((current) => ({ ...current, apiKey: event.target.value }))}
                  placeholder={openclaw.apiKeyPreview || 'sk_...'}
                />
              </label>
              <label className="setup-field">
                <FieldLabel>Operator name</FieldLabel>
                <input
                  className="field-input"
                  value={openClawForm.operatorName}
                  onChange={(event) => setOpenClawForm((current) => ({ ...current, operatorName: event.target.value }))}
                />
              </label>
              <label className="setup-field">
                <FieldLabel>Agent model</FieldLabel>
                <input
                  className="field-input"
                  value={openClawForm.model}
                  onChange={(event) => setOpenClawForm((current) => ({ ...current, model: event.target.value }))}
                />
              </label>
              <label className="setup-field setup-field-wide">
                <FieldLabel>Policy notes</FieldLabel>
                <textarea
                  className="field-input setup-textarea"
                  value={openClawForm.notes}
                  onChange={(event) => setOpenClawForm((current) => ({ ...current, notes: event.target.value }))}
                />
              </label>
            </div>
            <SharedSummaryGrid items={[
              ['Status', openclaw.connected ? 'connected' : 'not connected'],
              ['Trading', trading.address ? shorten(trading.address) : 'Pending'],
              ['Treasury', treasury.address ? shorten(treasury.address) : 'Pending'],
              ['Mode', treasury.fundingMode || 'unconfigured'],
            ]} />
            {openClawManifest ? (
              <InfoPanel>
                <pre className="setup-manifest">
                  {JSON.stringify(openClawManifest, null, 2)}
                </pre>
              </InfoPanel>
            ) : null}
            <div className="setup-actions">
              <ActionButton onClick={connectOpenClaw} disabled={openClawBusy}>
                {openClawBusy ? 'Connecting…' : openclaw.connected ? 'Update OpenClaw' : 'Connect OpenClaw'}
              </ActionButton>
              <ActionButton tone="secondary" onClick={disconnectOpenClaw} disabled={openClawBusy || !openclaw.connected}>
                Disconnect
              </ActionButton>
              {openclaw.connected ? (
                <ActionButton tone="secondary" onClick={() => persistStep('launch', '/setup/launch').catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  Continue to launch
                </ActionButton>
              ) : null}
            </div>
            </details>

            {/* If Pinata is connected, the OpenClaw step itself is satisfied — show a
                Continue button up here so users don't feel like they need to also
                fill the manual form. */}
            {pinataConnected ? (
              <div className="setup-actions">
                <ActionButton tone="primary" onClick={() => persistStep('launch', '/setup/launch').catch((err) => setError(err instanceof Error ? err.message : String(err)))}>
                  Continue to launch (Pinata agent paired)
                </ActionButton>
              </div>
            ) : null}
          </div>
        </StepShell>
      )
    }

    return (
      <StepShell {...currentMeta} routeStep={displayedStep}>
        <div className="field-stack">
          <SharedSummaryGrid items={[
            ['Workspace', setup.workspaceBootstrapped ? 'ready' : 'pending'],
            ['Treasury', setup.treasuryProvisioned ? 'ready' : 'pending'],
            ['Trading', setup.tradingWalletReady ? 'ready' : 'pending'],
            ['OpenClaw', setup.openclawReady ? 'ready' : 'optional / pending'],
          ]} />
          <InfoPanel tone={setup.completed ? 'success' : 'default'}>
            {setup.completed
              ? 'Ready. Open terminal.'
              : 'Finish the pending steps.'}
          </InfoPanel>
          <div className="setup-actions">
            <ActionButton href="/?onboarding=1">Open operator terminal</ActionButton>
            <ActionButton tone="secondary" href="/">Open root</ActionButton>
          </div>
        </div>
      </StepShell>
    )
  })()

  if (displayedStep === 'treasury') {
    return (
      <MirosharkUnicornScene variant="setup">
        <main className="treasury-page-shell">
          <div className="treasury-page-top">
            <a className="treasury-page-brand" href="/">MiroShark</a>
            <span className="treasury-page-step">Treasury setup</span>
          </div>
          <section className="treasury-page-frame">
            {activeStep}
          </section>
        </main>
      </MirosharkUnicornScene>
    )
  }

  return (
    <MirosharkUnicornScene variant="setup">
      <div className="setup-scene-shell">
        <div className="terminal-shell setup-shell">
          <header className="terminal-header">
            <div className="brand-block">
              <div className="brand-mark">MIROSHARK</div>
              <div className="brand-sub">setup</div>
            </div>
            <div className="status-strip">
              <span className="status-pill">{currentMeta.label}</span>
              <span className="status-pill">{actor.authEnabled ? 'clerk auth' : 'local auth'}</span>
              <span className="status-pill">{persistence.mode || 'storage?'}</span>
                <span className={`status-pill ${setup.completed ? '' : 'warn'}`}>{setup.completed ? 'ready' : 'in progress'}</span>
            </div>
          </header>

          <main className={`terminal-grid setup-grid${displayedStep === 'treasury' ? ' is-focus' : ''}`}>
            {displayedStep === 'treasury' ? null : (
            <aside className="terminal-rail setup-rail">
          <SharedSetupProgress
            steps={STEP_ORDER.map((step) => ({
              key: step,
              label: STEP_META[step].label,
              description: STEP_META[step].description,
              href: `/setup/${step}`,
            }))}
            activeStep={displayedStep}
            complete={completedSteps}
            progress={progress}
          />

          <section className="rail-card">
            <dl className="metric-list compact">
              <div className="metric-row"><dt>User</dt><dd>{actor.displayName || 'Unknown operator'}</dd></div>
              <div className="metric-row"><dt>Email</dt><dd>{actor.email || 'local mode'}</dd></div>
              <div className="metric-row"><dt>Persistence</dt><dd>{persistence.mode || 'unknown'}</dd></div>
              <div className="metric-row"><dt>Workspace</dt><dd>{status?.workspace?.title || 'pending'}</dd></div>
              <div className="metric-row"><dt>Room</dt><dd>{status?.workspace?.liveblocksRoom || 'pending'}</dd></div>
            </dl>
          </section>

          {error ? (
            <section className="rail-card">
              <InfoPanel tone="error">{error}</InfoPanel>
            </section>
          ) : null}

          {message ? (
            <section className="rail-card">
              <InfoPanel tone="success">{message}</InfoPanel>
            </section>
          ) : null}
            </aside>
            )}

            <section className="terminal-stage setup-stage">
              {activeStep}
            </section>
          </main>
        </div>
      </div>

      <AddFundDialog
        open={addFundOpen}
        onClose={() => setAddFundOpen(false)}
        onCreated={(fund) => { setFirstFund(fund); load().catch(() => null) }}
      />
    </MirosharkUnicornScene>
  )
}
