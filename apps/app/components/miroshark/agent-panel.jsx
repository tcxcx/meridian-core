'use client'

import { useMemo } from 'react'

import EnsName from '@/components/miroshark/ens-name'

function shorten(value, limit = 14) {
  const raw = String(value || '')
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`
}

function formatPp(value) {
  const n = Number(value || 0)
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`
}

function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// AGENT panel — surfaces the autonomous operator (Pinata agent xt1sgi73)
// as a co-operator inside the selected-market region. Shares the swarm output,
// the audit trail, and the wallet — only the panel header + skills strip are
// agent-specific. Cohesion principle: don't bolt on a separate widget; show
// the agent's reasoning in the same room as the human operator's.
export default function AgentPanel({ pinataConnector, signal, thresholds, recentEvents, telegramUrl }) {
  const runState = pinataConnector?.runState || (pinataConnector?.connected ? 'idle' : 'offline')
  const agentId = pinataConnector?.agentId || ''
  const agentTemplate = pinataConnector?.agentTemplate || 'Polymarket Trader'
  const inboxUrl = telegramUrl
    || pinataConnector?.telegramUrl
    || (pinataConnector?.telegramHandle ? `https://t.me/${String(pinataConnector.telegramHandle).replace(/^@/, '')}` : 'https://t.me/miro_shark_bot')

  // Agent decision logic — mirrors the same edge × confidence threshold the
  // agent itself uses (see services/execution_router/operator/policy). When
  // the signal clears both bars, agent would open per playbook; when it
  // doesn't, agent skips with the reason. Surfacing this makes it obvious
  // whether the human operator and the autonomous agent agree on this market.
  const decision = useMemo(() => {
    if (!signal?.edge) return { kind: 'wait', copy: 'no signal yet — run swarm' }
    const edgePp = Number(signal.edge.edge_pp || 0)
    const conf = Number(signal.confidence || 0)
    const minEdge = Number(thresholds?.edge || 0)
    const minConf = Number(thresholds?.confidence || 0)
    const edgeOk = Math.abs(edgePp) >= minEdge
    const confOk = conf >= minConf
    if (edgeOk && confOk) {
      return {
        kind: 'open',
        copy: `open ${signal.edge.outcome} · per playbook (edge ${formatPp(edgePp)} ≥ ${formatPp(minEdge)} · conf ${conf.toFixed(2)} ≥ ${minConf.toFixed(2)})`,
      }
    }
    if (!edgeOk && !confOk) {
      return { kind: 'skip', copy: `skip · edge ${formatPp(edgePp)} below ${formatPp(minEdge)} · conf ${conf.toFixed(2)} below ${minConf.toFixed(2)}` }
    }
    if (!edgeOk) {
      return { kind: 'skip', copy: `skip · edge ${formatPp(edgePp)} below ${formatPp(minEdge)} threshold` }
    }
    return { kind: 'skip', copy: `skip · conf ${conf.toFixed(2)} below ${minConf.toFixed(2)} threshold` }
  }, [signal, thresholds])

  // Agent ENS — wallet address may carry a registered ENS name (e.g.
  // xt1sgi73.miroshark.eth). Resolution happens client-side via /api/ens/resolve
  // and is cached. If no ENS name exists, EnsName falls back to short address.
  const agentWalletAddress = pinataConnector?.agentWalletAddress
    || pinataConnector?.agent?.walletAddress
    || null

  return (
    <div className="agent-panel">
      <div className="agent-panel-head">
        <span className="agent-panel-title">
          AGENT · {agentWalletAddress
            ? <EnsName address={agentWalletAddress} className="agent-panel-ens" />
            : shorten(agentId || agentTemplate, 16)}
        </span>
        <span className={`agent-panel-state s-${runState}`}>
          <span className={`agent-panel-pulse s-${runState}`} aria-hidden="true" />
          {runState}
        </span>
      </div>

      <dl className="agent-panel-rows">
        <div className="agent-panel-row">
          <dt>decision</dt>
          <dd className={`agent-panel-decision is-${decision.kind}`}>{decision.copy}</dd>
        </div>
        <div className="agent-panel-row">
          <dt>skills</dt>
          <dd className="agent-panel-skills">
            <span>probe</span><i>·</i>
            <span>swarm</span><i>·</i>
            <span>open</span><i>·</i>
            <span>settle</span>
          </dd>
        </div>
        <div className="agent-panel-row agent-panel-row-log">
          <dt>last</dt>
          <dd>
            {recentEvents.length ? (
              <ul className="agent-panel-log">
                {recentEvents.slice(0, 2).map((ev, i) => (
                  <li key={`${ev.ts}-${ev.event}-${i}`}>
                    <span className="agent-panel-log-time">{formatTime(ev.ts)}</span>
                    <span className="agent-panel-log-event">{ev.event}</span>
                    {ev.payload?.position_id ? (
                      <span className="agent-panel-log-meta">pos {shorten(ev.payload.position_id, 10)}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <span className="agent-panel-empty">no recent activity</span>
            )}
          </dd>
        </div>
        <div className="agent-panel-row">
          <dt>inbox</dt>
          <dd>
            <a className="agent-panel-inbox" href={inboxUrl} target="_blank" rel="noreferrer">
              ↗ {pinataConnector?.telegramHandle || '@miro_shark_bot'}
            </a>
          </dd>
        </div>
      </dl>
    </div>
  )
}
