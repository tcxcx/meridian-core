'use client'

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'

import AddFundDialog from '@/components/miroshark/add-fund-dialog'
import AgentPanel from '@/components/miroshark/agent-panel'
import EnsName from '@/components/miroshark/ens-name'
import GraphPanel from '@/components/miroshark/graph-panel'
import PnlBento from '@/components/miroshark/pnl-bento'
import WalletActionModals from '@/components/miroshark/wallet-action-modals'
import WalletPopover, { WalletAction, WalletActionRow, WalletDivider, WalletRow } from '@/components/miroshark/wallet-popover'
import { buildOpportunityGraph, scoreOpportunity } from '@/lib/opportunity-graph'

const SIGNAL_BASE = '/signal'
const EXECUTION_BASE = '/execution'

const scenarioVariables = [
  { key: 'geopoliticalStress', label: 'Geopolitics' },
  { key: 'diplomaticBreakthrough', label: 'Diplomacy' },
  { key: 'energyDislocation', label: 'Energy' },
  { key: 'cryptoMomentum', label: 'Crypto' },
  { key: 'electionTurbulence', label: 'Elections' },
]

function defaultTicker() {
  return { headlines: [], prices: [], events: [], tape: [], updated_at: null }
}

function formatUsd(value) {
  return `$${Number(value || 0).toFixed(2)}`
}

function formatMoney(value, digits = 2) {
  return Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: 6,
  })
}

function formatFloat(value) {
  return Number(value || 0).toFixed(2)
}

function formatPp(value) {
  const n = Number(value || 0)
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}pp`
}

function formatTickerPrice(value) {
  const n = Number(value || 0)
  if (n >= 1000) return `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(4)}`
}

function formatSignedPercent(value) {
  const n = Number(value || 0)
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function formatPolicyPct(value) {
  return `${(Number(value || 0) * 100).toFixed(0)}%`
}

function shorten(value, limit = 16) {
  const raw = String(value || '')
  return raw.length <= limit ? raw : `${raw.slice(0, limit)}…`
}

function summarizeId(value, limit = 14) {
  return value ? shorten(value, limit) : '—'
}

function isActivePosition(position) {
  return !['settled', 'failed'].includes(position?.status)
}

// E4: stage detector for the trade-in-flight pill. Each return value
// describes what the system is doing right now, what the operator is
// waiting on, and the rough ETA. Order of branches matters — earlier
// branches match earlier lifecycle states.
function inflightStage(position) {
  if (!position) return null
  const status = position.status
  if (status === 'settled' || status === 'failed') return null
  // /resolve phase
  if (status === 'resolving') {
    if (!position.gateway_deposit_tx) {
      return { label: 'Depositing payout into Polygon Amoy GatewayWallet', eta: '~10s' }
    }
    if (!position.bridge_recv_mint_tx) {
      return { label: 'Bridging proceeds Amoy → Arb Sepolia via Circle Forwarder', eta: '~60-120s' }
    }
    if (!position.settle_tx) {
      return { label: 'Settling on Arb Sepolia (markResolved + settle)', eta: '~10s' }
    }
    return { label: 'Finalizing settlement', eta: '~5s' }
  }
  // /open phase
  if (!position.fund_tx) {
    return { label: 'Funding burner on Arb Sepolia (encrypted size)', eta: '~10s' }
  }
  if (!position.bridge_send_mint_tx) {
    return { label: 'Bridging USDC Arb Sepolia → Polygon Amoy via Circle Forwarder', eta: '~60-120s' }
  }
  if (!position.clob_order_id) {
    return { label: 'Submitting Polymarket order on Polygon Amoy', eta: '~5s' }
  }
  if (status === 'open') return { label: 'Live position — Polymarket CLOB filled', eta: null }
  return { label: 'Working…', eta: null }
}

function formatElapsed(seconds) {
  const s = Math.max(0, Math.floor(seconds))
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

// Settled positions surface as ✓ rows in the Positions list — the standalone
// hero card was cut in the lean redesign. Tx hashes for settled rows render
// inline via explorerUrlFor() helpers further down.
function explorerUrlFor(hash) {
  if (!hash || typeof hash !== 'string' || !hash.startsWith('0x')) return null
  // Heuristic: settle tx is on Arb Sepolia, gateway/clob is on Polygon Amoy.
  // We can't tell from hash alone — default to Arb Sepolia explorer; users
  // who care about chain attribution open the position card.
  return `https://sepolia.arbiscan.io/tx/${hash}`
}


// ── Swarm-quality sub-card ────────────────────────────────────────────────
// Reads agreement_score, raw_confidence vs confidence, dissent_summary,
// minority_report from the /api/signal/run response. Visualises:
//  - agreement bar: green ≥0.85, amber 0.65-0.85, red <0.65
//  - confidence delta: explicit gap between raw and disagreement-penalised
//  - minority_report (when present): collapsed expander w/ dissenter details
function SwarmQualityPanel({ signal }) {
  if (!signal) return null
  const raw = Number(signal.raw_confidence ?? signal.confidence ?? 0)
  const conf = Number(signal.confidence ?? 0)
  const agree = signal.agreement_score
  const minority = signal.minority_report
  const dissent = signal.signals_diagnostic?.dissent_summary || null
  const hasAxlSignals = signal.agreement_score != null || signal.minority_report

  if (!hasAxlSignals) return null  // swarm-lite path — nothing to show

  const agreePct = agree != null ? Math.max(0, Math.min(1, Number(agree))) : 0
  const agreeTone = agreePct >= 0.85 ? 'ok' : agreePct >= 0.65 ? 'warn' : 'alert'
  const confDelta = raw - conf
  const confDeltaPct = raw > 0 ? confDelta / raw : 0

  return (
    <div className="swarm-quality">
      <div className="swarm-quality-head">
        <span className="card-eyebrow">Swarm quality (AXL)</span>
        <span className="swarm-quality-phase">{signal.phase || ''}</span>
      </div>
      <div className="swarm-quality-row">
        <div className="swarm-quality-cell">
          <div className="swarm-quality-label">Agreement</div>
          <div className={`swarm-quality-bar tone-${agreeTone}`}>
            <div className="swarm-quality-bar-fill" style={{ width: `${agreePct * 100}%` }} />
          </div>
          <div className="swarm-quality-value">{agree != null ? agree.toFixed(3) : '—'}</div>
        </div>
        <div className="swarm-quality-cell">
          <div className="swarm-quality-label">Confidence</div>
          <div className="swarm-quality-conf">
            <span className="swarm-quality-conf-main">{conf.toFixed(3)}</span>
            {confDelta > 0.001 ? (
              <span className="swarm-quality-conf-raw">
                raw {raw.toFixed(3)} · disagreement penalty {(confDeltaPct * 100).toFixed(1)}%
              </span>
            ) : (
              <span className="swarm-quality-conf-raw">no disagreement penalty applied</span>
            )}
          </div>
        </div>
      </div>
      {dissent ? (
        <div className="swarm-quality-dissent">{dissent}</div>
      ) : null}
      {minority ? (
        <details className="swarm-quality-minority">
          <summary>
            <span className="swarm-quality-minority-tag">⚠ Minority report</span>
            <span className="swarm-quality-minority-meta">
              {shorten(minority.agent_id || '?', 18)} · conf {Number(minority.confidence || 0).toFixed(2)} ·
              dist {Number(minority.distance_from_consensus || 0).toFixed(2)}
            </span>
          </summary>
          <div className="swarm-quality-minority-body">
            <div className="swarm-quality-minority-probs">
              {Object.entries(minority.probabilities || {}).map(([o, p]) => (
                <span key={o} className="swarm-quality-minority-prob">
                  <strong>{o}</strong> {(Number(p) * 100).toFixed(0)}%
                </span>
              ))}
            </div>
            <p className="swarm-quality-minority-reasoning">{minority.reasoning || ''}</p>
          </div>
        </details>
      ) : null}
    </div>
  )
}

// ── Signal-diagnostic strip ───────────────────────────────────────────────
// Per-selected-market signal status. Reads signals_diagnostic + signals.*
// from /signal/run. Three chips (E-01, T-03, C-02) plus per-outcome
// entropy chips (one per outcome). Each chip carries a hover tooltip
// explaining presence/absence verbatim from signals_diagnostic.note.
function SignalDiagnosticStrip({ signal, outcomes }) {
  if (!signal) return null
  const diag = signal.signals_diagnostic || {}
  const sigs = signal.signals || {}
  const entropyDiag = diag.entropy || {}
  const corrDiag = diag.correlations || {}
  const cryoDiag = diag.cryo || {}

  const entropyPerOutcome = sigs.entropy_per_outcome || {}
  const correlations = sigs.correlations || []
  const cryo = sigs.cryo

  const tierTone = (tier) => tier === 0 ? 'ok' : tier === 1 ? 'warn' : tier === 2 ? 'alert' : 'idle'

  return (
    <div className="signal-diagnostic">
      <div className="signal-diagnostic-head">
        <span className="card-eyebrow">Signal diagnostic (per market)</span>
        <span className="signal-diagnostic-sub">live from /signal/run</span>
      </div>
      <div className="signal-diagnostic-row">
        <div className="signal-diagnostic-group">
          <div className="signal-diagnostic-label">E-01 entropy per outcome</div>
          <div className="signal-diagnostic-chips">
            {(outcomes.length ? outcomes : Object.keys(entropyPerOutcome)).map((outcome) => {
              const r = entropyPerOutcome[outcome]
              if (!r) {
                return (
                  <span key={outcome} className="diag-chip diag-chip-idle"
                        title={`${outcome}: order book unavailable`}>
                    {outcome}: —
                  </span>
                )
              }
              const tone = tierTone(r.tier)
              const label = r.frozen ? `tier ${r.tier} frozen` : `tier ${r.tier}`
              const tip = `${outcome}: tier ${r.tier} (H=${(r.h_bits ?? 0).toFixed(2)}) · ` +
                          `mid=${r.mid != null ? `$${r.mid.toFixed(3)}` : 'n/a'} · ` +
                          `spread=${r.spread_bps != null ? `${Math.round(r.spread_bps)}bps` : 'n/a'} · ` +
                          `bid-depth=${(r.bid_depth ?? 0).toFixed(0)} / ask-depth=${(r.ask_depth ?? 0).toFixed(0)}`
              return (
                <span key={outcome} className={`diag-chip diag-chip-${tone}`} title={tip}>
                  <strong>{outcome}</strong> {label}
                </span>
              )
            })}
          </div>
        </div>
        <div className="signal-diagnostic-group">
          <div className="signal-diagnostic-label">T-03 correlations</div>
          <span
            className={`diag-chip ${correlations.length ? 'diag-chip-warn' : 'diag-chip-idle'}`}
            title={corrDiag.note || `${correlations.length} markets above |r|=0.70`}
          >
            {correlations.length ? `${correlations.length} correlated` : 'none above r=0.70'}
          </span>
          {correlations.slice(0, 3).map((c, i) => (
            <span key={i} className="diag-chip diag-chip-info"
                  title={`r=${(c.r ?? 0).toFixed(2)}`}>
              {(c.slug || c.token_id || '?').slice(0, 18)}{(c.slug || '').length > 18 ? '…' : ''} ({(c.r ?? 0).toFixed(2)})
            </span>
          ))}
        </div>
        <div className="signal-diagnostic-group">
          <div className="signal-diagnostic-label">C-02 cryo</div>
          <span
            className={`diag-chip ${cryo ? 'diag-chip-alert' : 'diag-chip-ok'}`}
            title={cryoDiag.note || (cryo ? `z-score ${(cryo.z_score ?? 0).toFixed(2)} — abnormally frozen` : 'normal range')}
          >
            {cryo ? `⚠ anomaly (z ${(cryo.z_score ?? 0).toFixed(2)})` : 'normal'}
          </span>
        </div>
      </div>
      {entropyDiag.outcomes_without_book && entropyDiag.outcomes_without_book.length > 0 ? (
        <div className="signal-diagnostic-foot">
          Order book unavailable for: {entropyDiag.outcomes_without_book.join(', ')}
        </div>
      ) : null}
    </div>
  )
}

function lookupTokenId(market, outcome) {
  const outcomes = market?.outcomes || []
  const tokenIds = market?.token_ids || []
  const index = outcomes.indexOf(outcome)
  return index >= 0 ? tokenIds[index] : tokenIds[0]
}

function loopTickerItems(items) {
  if (!items.length) return []
  const loops = items.length < 4 ? 4 : 2
  return Array.from({ length: loops }, (_, loopIndex) => items.map((item, itemIndex) => ({
    ...item,
    _tickerKey: `${item.kind || 'item'}-${item.symbol || item.source || 'x'}-${loopIndex}-${itemIndex}`,
  }))).flat()
}

async function readJson(url, options) {
  const response = await fetch(url, options)
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(json.error || `HTTP ${response.status}`)
  }
  return json
}

export default function OperatorTerminal() {
  const searchParams = useSearchParams()
  const [markets, setMarkets] = useState([])
  const [marketLoading, setMarketLoading] = useState(false)
  const [classifyLoading, setClassifyLoading] = useState(false)
  const [signalLoading, setSignalLoading] = useState(false)
  const [streamLoading, setStreamLoading] = useState(false)
  const [openLoading, setOpenLoading] = useState(false)
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000))
  const [pinataConnector, setPinataConnector] = useState(null)
  const [pinataLoading, setPinataLoading] = useState(false)
  const [chatPanel, setChatPanel] = useState({ open: false, url: '', title: '' })

  const [positions, setPositions] = useState([])
  const [alerts, setAlerts] = useState([])
  const [auditEvents, setAuditEvents] = useState([])
  const [auditByPosition, setAuditByPosition] = useState({})
  const [cryoRows, setCryoRows] = useState([])
  const [topologyData, setTopologyData] = useState(null)
  const [entropyReading, setEntropyReading] = useState(null)
  const [routerHealth, setRouterHealth] = useState({})
  const [signalHealth, setSignalHealth] = useState({})
  const [operatorStatus, setOperatorStatus] = useState({})
  const [gatewayBalance, setGatewayBalance] = useState(null)
  const [terminalTicker, setTerminalTicker] = useState(defaultTicker())
  const [tenants, setTenants] = useState([])
  const [worldState, setWorldState] = useState({
    geopoliticalStress: 68,
    diplomaticBreakthrough: 34,
    energyDislocation: 58,
    cryptoMomentum: 61,
    electionTurbulence: 52,
  })
  const [signalCache, setSignalCache] = useState({})
  const [selectedTenant, setSelectedTenant] = useState('default')
  const [selectedMarketId, setSelectedMarketId] = useState('')
  const [selectedPositionId, setSelectedPositionId] = useState('')
  const [openAmount, setOpenAmount] = useState(25)
  const [swarmFeed, setSwarmFeed] = useState([])
  const [streamStatus, setStreamStatus] = useState('idle')
  const [showHistory, setShowHistory] = useState(false)
  const [activeCapitalModal, setActiveCapitalModal] = useState('')
  const [pendingTransfers, setPendingTransfers] = useState([])
  const [fundAgentTransferId, setFundAgentTransferId] = useState('')
  const [funds, setFunds] = useState([])
  const [addFundOpen, setAddFundOpen] = useState(false)

  const positionsEventSourceRef = useRef(null)
  const positionsRetryTimerRef = useRef(null)
  const positionsRetryCountRef = useRef(0)
  const positionsUnmountedRef = useRef(false)
  const streamingMarketIdRef = useRef(null)
  const swarmEventSourceRef = useRef(null)
  const swarmRetryTimerRef = useRef(null)
  const swarmRetryCountRef = useRef(0)
  const refreshTimerRef = useRef(null)
  const bootedRef = useRef(false)
  const capitalModalSeededRef = useRef(false)

  const selectedMarket = useMemo(
    () => markets.find((item) => item.market_id === selectedMarketId) || null,
    [markets, selectedMarketId],
  )
  const selectedSignal = useMemo(
    () => (selectedMarketId ? signalCache[selectedMarketId] || null : null),
    [selectedMarketId, signalCache],
  )
  const tenantOptions = useMemo(() => {
    const ids = (tenants || []).map((item) => item.tenant_id).filter(Boolean)
    const fundIds = (funds || []).map((item) => item.tenant_id).filter(Boolean)
    return [...new Set(['default', ...ids, ...fundIds])]
  }, [tenants, funds])
  // Map tenant_id → fund row (when the tenant came from /api/funds). Used to
  // surface the display_name + ens_name in the Agent popover instead of the
  // raw slug.
  const fundsByTenant = useMemo(() => {
    const map = {}
    for (const f of funds || []) map[f.tenant_id] = f
    return map
  }, [funds])
  const selectedFund = fundsByTenant[selectedTenant] || null
  const visiblePositions = useMemo(
    () => positions.filter((item) => (item.tenant_id || 'default') === selectedTenant),
    [positions, selectedTenant],
  )
  const activeVisiblePositions = useMemo(
    () => visiblePositions.filter((item) => isActivePosition(item)),
    [visiblePositions],
  )
  const historicalVisiblePositions = useMemo(
    () => visiblePositions.filter((item) => !isActivePosition(item)),
    [visiblePositions],
  )
  const selectedPosition = useMemo(
    () => visiblePositions.find((item) => item.position_id === selectedPositionId) || null,
    [visiblePositions, selectedPositionId],
  )
  const rankedMarkets = useMemo(() => {
    return [...markets]
      .map((market) => {
        const signal = signalCache[market.market_id]
        const scenarioBias = scoreOpportunity({ market, signal: null, entropy: null, scenario: worldState }) -
          scoreOpportunity({ market, signal: null, entropy: null, scenario: {} })
        return {
          ...market,
          signal,
          score: scoreOpportunity({ market, signal, entropy: entropyReading, scenario: worldState }),
          scenarioBias,
        }
      })
      .sort((a, b) => b.score - a.score)
      .map((row, index) => ({ ...row, rank: index + 1 }))
  }, [markets, signalCache, worldState, entropyReading])
  const readinessThresholds = useMemo(() => ({
    edge: Number(operatorStatus?.thresholds?.directional_min_edge_pp || 0),
    confidence: Number(operatorStatus?.thresholds?.directional_min_confidence || 0),
  }), [operatorStatus])
  const actionableMarkets = useMemo(() => {
    const { edge, confidence } = readinessThresholds
    return rankedMarkets.filter((market) => {
      const signal = market.signal
      return Boolean(signal?.edge) &&
        Math.abs(Number(signal.edge.edge_pp || 0)) >= edge &&
        Number(signal.confidence || 0) >= confidence
    })
  }, [rankedMarkets, readinessThresholds])
  const bestOpportunity = useMemo(
    () => actionableMarkets[0] || rankedMarkets.find((market) => market.signal?.edge) || rankedMarkets[0] || null,
    [actionableMarkets, rankedMarkets],
  )
  const signalCoverage = useMemo(
    () => `${Object.keys(signalCache || {}).length}/${markets.length || 0}`,
    [signalCache, markets.length],
  )
  const swarmScaleLabel = useMemo(() => {
    const classified = Object.keys(signalCache || {}).length
    return classified ? `${classified} markets classified` : 'swarm idle'
  }, [signalCache])
  const localOptimumLabel = useMemo(() => {
    const lead = bestOpportunity
    if (!lead) return 'local optimum pending'
    return `local optimum ${formatPp(lead.scenarioBias || 0)} scenario tilt`
  }, [bestOpportunity])
  const readinessThresholdLabel = useMemo(
    () => `${formatPp(readinessThresholds.edge)} @ ${formatFloat(readinessThresholds.confidence)}`,
    [readinessThresholds],
  )
  const realizedPayout = useMemo(
    () => visiblePositions.reduce((sum, item) => sum + Number(item.payout_usdc || 0), 0),
    [visiblePositions],
  )
  const usdcAtRisk = useMemo(
    () => visiblePositions.filter((item) => !['settled', 'failed'].includes(item.status)).reduce((sum, item) => sum + Number(item.usdc_amount || 0), 0),
    [visiblePositions],
  )
  const executionSummary = useMemo(
    () => `${activeVisiblePositions.length} active · ${historicalVisiblePositions.length} settled`,
    [activeVisiblePositions.length, historicalVisiblePositions.length],
  )
  const operatorModeLabel = `operator ${operatorStatus?.mode || 'manual'}`
  const chainLabel = `${operatorStatus?.capital_plane?.settlement_chain?.label || routerHealth?.chains?.settlement || 'Settlement'} ⇄ ${operatorStatus?.capital_plane?.primary_trading_chain?.label || routerHealth?.chains?.trading || 'Polygon'}`
  const executionOnline = routerHealth?.status === 'ok'
  const signalOnline = signalHealth?.status === 'ok'
  const openclawEnabled = Boolean(operatorStatus?.automation?.openclaw_enabled || operatorStatus?.automation?.openclaw_session)
  // 0G storage pin pill — derived from signal-gateway /health zg_anchor.
  // The Galileo OG faucet is intermittent + the storage signer often
  // runs low; surface the balance up-front so judges see whether the
  // 0G pinning would fire on the next swarm run, not just when it fails.
  const zgAnchor = signalHealth?.zg_anchor || null
  const zgStorage = zgAnchor?.storage || null
  const zgBalanceOg = zgStorage?.balance_og != null ? Number(zgStorage.balance_og) : null
  const zgOnline = Boolean(zgStorage?.ok)
  const zgLow = zgBalanceOg != null && zgBalanceOg < 0.01
  const zgPillTone = !zgOnline ? 'warn' : (zgLow ? 'warn' : '')
  const zgPillLabel = !zgOnline
    ? '0G storage off'
    : zgBalanceOg != null
      ? `0G ${zgBalanceOg.toFixed(3)} OG${zgLow ? ' (low)' : ''}`
      : '0G ok'
  const zgPillTitle = !zgOnline
    ? 'cogito storage signer unreachable — refill at https://faucet.0g.ai'
    : zgLow
      ? `Galileo signer ${zgStorage?.signer || ''} balance is below 0.01 OG. Storage pins will fail. Refill at https://faucet.0g.ai`
      : `Galileo signer ${zgStorage?.signer || ''} healthy (${zgBalanceOg ?? '?'} OG)`

  const pinataConnected = Boolean(pinataConnector?.connected)
  const pinataRunState = pinataConnector?.runState || 'idle'
  const pinataPillTone = pinataConnected
    ? (pinataRunState === 'running' ? '' : (pinataRunState === 'error' ? 'warn' : ''))
    : 'warn'
  const pinataPillLabel = !pinataConnected
    ? 'pinata not connected'
    : `pinata ${pinataRunState}`
  const pinataAutonomousNext = pinataRunState === 'running' ? 'paused' : 'running'
  const canOpenSelected = Boolean(selectedMarket && selectedSignal?.edge && openAmount > 0)
  const topologyStats = topologyData
    ? `${topologyData?.edges?.length || 0} edges · ${topologyData?.clusters?.length || 0} clusters`
    : 'topology not loaded'
  const sponsorRows = operatorStatus?.sponsors || []
  const readySponsorCount = sponsorRows.filter((item) => item.ready).length
  const walletReadiness = operatorStatus?.wallets || {}
  const nextBlockers = operatorStatus?.next_blockers || []
  const gatewayTreasuryBalance = walletReadiness?.gateway_treasury_balance
  const capitalPlane = operatorStatus?.capital_plane || {}
  const capitalBalances = capitalPlane?.balances || {}
  const treasuryPlane = capitalPlane?.treasury || {}
  const tradingPlane = capitalPlane?.trading || {}
  const capitalPolicy = capitalPlane?.policy || {}
  const capitalDomains = capitalPlane?.per_domain || []
  const capitalActions = capitalPlane?.actions || []
  const treasuryFundingMode = treasuryPlane?.funding_mode || ''
  const gatewayBalanceView = gatewayBalance || {}
  const domainRows = gatewayBalanceView?.perDomain || []
  const pendingCredits = gatewayBalanceView?.pendingCredits || []
  const opsStaging = gatewayBalanceView?.opsStaging || []
  const spendableBusinessBalance = gatewayBalanceView?.spendableAvailable ?? capitalBalances.available_to_deploy ?? 0
  const trackedBusinessBalance = gatewayBalanceView?.grandTotal ?? capitalBalances.grand_total ?? 0
  const gatewayAvailableBalance = gatewayBalanceView?.available ?? capitalBalances.gateway_available ?? 0
  const pendingCreditBalance = gatewayBalanceView?.pendingCreditTotal ?? capitalBalances.pending_credit_total ?? 0
  const opsStagingBalance = gatewayBalanceView?.opsStagingTotal ?? capitalBalances.ops_staging_total ?? 0
  const hasBalanceMotion = Number(pendingCreditBalance || 0) > 0 || Number(opsStagingBalance || 0) > 0

  const liveGraphData = useMemo(() => buildOpportunityGraph({
    markets: rankedMarkets,
    selectedMarket,
    signals: signalCache,
    selectedSignal,
    positions: visiblePositions,
    topology: topologyData,
    cryo: cryoRows,
    operator: operatorStatus,
    tenantId: selectedTenant,
    scenario: {
      ...worldState,
      swarmScaleLabel,
    },
  }), [rankedMarkets, selectedMarket, signalCache, selectedSignal, visiblePositions, topologyData, cryoRows, operatorStatus, selectedTenant, worldState, swarmScaleLabel])
  const graphStatusText = useMemo(() => {
    const nodes = liveGraphData?.nodes?.length || 0
    const edges = liveGraphData?.edges?.length || 0
    return `${nodes} nodes · ${edges} edges`
  }, [liveGraphData])

  const headlineItems = useMemo(() => {
    if (terminalTicker.headlines?.length) return terminalTicker.headlines
    return [{ kind: 'headline', source: 'MiroShark', anchor: 'Newswire syncing', published_label: null }]
  }, [terminalTicker])
  const tapeItems = useMemo(() => {
    if (terminalTicker.tape?.length) return terminalTicker.tape
    return [{ kind: 'event', label: 'Market tape warming up' }]
  }, [terminalTicker])
  const duplicatedHeadlineItems = useMemo(() => loopTickerItems(headlineItems), [headlineItems])
  const duplicatedTapeItems = useMemo(() => loopTickerItems(tapeItems), [tapeItems])
  const onboardingMode = String(searchParams?.get('onboarding') || '').trim().toLowerCase() === '1'

  useEffect(() => {
    if (capitalModalSeededRef.current) return
    const requestedModal = String(searchParams?.get('capitalModal') || '').trim().toLowerCase()
    if (requestedModal && ['deposit', 'send', 'bridge', 'swap', 'treasury'].includes(requestedModal)) {
      setActiveCapitalModal(requestedModal)
    }
    capitalModalSeededRef.current = true
  }, [searchParams])

  const addAlert = (message, tone = 'info') => {
    setAlerts((current) => [{
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      tone,
      message,
    }, ...current].slice(0, 16))
  }

  const fetchAudit = async (positionId, { silent = false } = {}) => {
    if (!positionId) return
    // DB-first; fall back to Python /execution/audit on any failure.
    let events = null
    try {
      const payload = await readJson(`/api/db/positions/${encodeURIComponent(positionId)}/audit`)
      events = payload.events || []
    } catch (_dbError) {
      try {
        const payload = await readJson(`${EXECUTION_BASE}/api/execution/audit/${positionId}`)
        events = payload.events || []
      } catch (error) {
        if (selectedPositionId === positionId) setAuditEvents([])
        if (!silent) addAlert(`audit fetch failed: ${error.message}`, 'warn')
        return
      }
    }
    setAuditByPosition((current) => ({ ...current, [positionId]: events }))
    if (selectedPositionId === positionId) setAuditEvents(events)
  }

  const refreshHealth = async () => {
    try {
      setRouterHealth(await readJson(`${EXECUTION_BASE}/health`))
    } catch (error) {
      setRouterHealth({ status: 'down' })
      addAlert(`execution router health failed: ${error.message}`, 'warn')
    }

    try {
      setSignalHealth(await readJson(`${SIGNAL_BASE}/health`))
    } catch (error) {
      setSignalHealth({ status: 'down' })
      addAlert(`signal gateway health failed: ${error.message}`, 'warn')
    }

    try {
      setOperatorStatus(await readJson(`${EXECUTION_BASE}/api/execution/operator/status`))
    } catch (error) {
      setOperatorStatus({ status: 'degraded' })
      addAlert(`operator status unavailable: ${error.message}`, 'warn')
    }

    await fetchGatewayBalance({ silent: true })
    await fetchPinataStatus({ silent: true })
  }

  const fetchTerminalTicker = async ({ silent = false } = {}) => {
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/terminal/ticker`)
      setTerminalTicker({
        headlines: payload.headlines || [],
        prices: payload.prices || [],
        events: payload.events || [],
        tape: payload.tape || [],
        updated_at: payload.updated_at || null,
      })
    } catch (error) {
      setTerminalTicker(defaultTicker())
      if (!silent) addAlert(`terminal ticker unavailable: ${error.message}`, 'warn')
    }
  }

  const fetchGatewayBalance = async ({ silent = false } = {}) => {
    try {
      setGatewayBalance(await readJson('/api/gateway/balance'))
    } catch (error) {
      setGatewayBalance(null)
      if (!silent) addAlert(`gateway balance unavailable: ${error.message}`, 'warn')
    }
  }

  const fetchPinataStatus = async ({ silent = true } = {}) => {
    try {
      const payload = await readJson('/api/pinata/status')
      setPinataConnector(payload?.connector || null)
      return payload?.connector || null
    } catch (error) {
      setPinataConnector(null)
      if (!silent) addAlert(`pinata status unavailable: ${error.message}`, 'warn')
      return null
    }
  }

  const setPinataRunState = async (runState) => {
    setPinataLoading(true)
    try {
      const payload = await readJson('/api/pinata/activate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runState }),
      })
      setPinataConnector(payload?.connector || null)
      addAlert(`pinata agent → ${runState}`, runState === 'running' ? 'success' : 'info')
    } catch (error) {
      addAlert(`pinata activate failed: ${error.message}`, 'warn')
    } finally {
      setPinataLoading(false)
    }
  }

  const openChatPanel = (url, title) => {
    if (!url) return
    setChatPanel({ open: true, url, title: title || 'Pinata Agent' })
  }

  const closeChatPanel = () => {
    setChatPanel({ open: false, url: '', title: '' })
  }

  const loadTenants = async () => {
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/tenants`)
      setTenants(payload.tenants || [])
    } catch (error) {
      addAlert(`tenant registry failed: ${error.message}`, 'warn')
    }
  }

  // User-created funds (each = a tenant + ENS subname). The Agent popover
  // tenant switcher merges this list with the static tenant registry above so
  // the user sees all available funds + can switch + add new ones inline.
  const fetchFunds = async ({ silent = true } = {}) => {
    try {
      const payload = await readJson('/api/funds')
      setFunds(payload.funds || [])
    } catch (error) {
      if (!silent) addAlert(`funds list failed: ${error.message}`, 'warn')
    }
  }

  const fetchPositions = async () => {
    // Read from the Neon projection first — fast (no Python round-trip),
    // survives router restarts, renders persisted state on page refresh.
    // Falls back to /execution if the DB read fails (no DATABASE_URL,
    // tables not yet bootstrapped, etc.). SSE keeps live in-flight updates.
    let nextPositions = []
    try {
      const payload = await readJson(`/api/db/positions?tenant_id=${encodeURIComponent(selectedTenant)}`)
      nextPositions = payload.positions || []
    } catch (_dbError) {
      try {
        const payload = await readJson(`${EXECUTION_BASE}/api/execution/positions`)
        nextPositions = payload.positions || []
      } catch (error) {
        addAlert(`positions fetch failed: ${error.message}`, 'warn')
        return
      }
    }
    setPositions(nextPositions)
    if (!selectedPositionId && nextPositions.length) {
      setSelectedPositionId(nextPositions[0].position_id)
    }
    nextPositions.forEach((position) => {
      if (!auditByPosition[position.position_id]) {
        fetchAudit(position.position_id, { silent: true })
      }
    })
  }

  const fetchCryo = async () => {
    try {
      const payload = await readJson(`${SIGNAL_BASE}/api/signal/cryo?limit=6&min_liquidity_usd=5000`)
      setCryoRows(payload.rows || payload.markets || [])
    } catch (error) {
      setCryoRows([])
      addAlert(`cryo fetch failed: ${error.message}`, 'warn')
    }
  }

  const fetchTopology = async () => {
    try {
      setTopologyData(await readJson(`${SIGNAL_BASE}/api/signal/topology?limit=8&min_liquidity_usd=5000`))
    } catch (error) {
      setTopologyData(null)
      addAlert(`topology fetch failed: ${error.message}`, 'warn')
    }
  }

  const fetchEntropy = async () => {
    if (!selectedMarket?.token_ids?.length) {
      setEntropyReading(null)
      return
    }

    const selectedOutcome = selectedSignal?.edge?.outcome
    let tokenId = selectedMarket.token_ids[0]
    if (selectedOutcome && Array.isArray(selectedMarket.outcomes)) {
      const outcomeIndex = selectedMarket.outcomes.indexOf(selectedOutcome)
      if (outcomeIndex >= 0 && selectedMarket.token_ids[outcomeIndex]) {
        tokenId = selectedMarket.token_ids[outcomeIndex]
      }
    }

    try {
      setEntropyReading(await readJson(`${SIGNAL_BASE}/api/signal/entropy?token_id=${encodeURIComponent(tokenId)}`))
    } catch (error) {
      setEntropyReading(null)
      addAlert(`entropy fetch failed: ${error.message}`, 'warn')
    }
  }

  const scanMarkets = async () => {
    setMarketLoading(true)
    try {
      const payload = await readJson(`${SIGNAL_BASE}/api/signal/markets/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: 12, min_liquidity_usd: 5000 }),
      })
      const nextMarkets = payload.markets || []
      setMarkets(nextMarkets)
      setSelectedMarketId((current) => {
        if (!current && nextMarkets.length) return nextMarkets[0].market_id
        if (current && nextMarkets.some((item) => item.market_id === current)) return current
        return nextMarkets[0]?.market_id || ''
      })
      addAlert(`scanned ${nextMarkets.length} markets`, 'info')
      return nextMarkets
    } catch (error) {
      setMarkets([])
      addAlert(`market scan failed: ${error.message}`, 'warn')
      return []
    } finally {
      setMarketLoading(false)
    }
  }

  const runSignalForMarket = async (marketId, { quiet = false } = {}) => {
    setSignalLoading(true)
    try {
      const payload = await readJson(`${SIGNAL_BASE}/api/signal/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ market_id: marketId }),
      })
      setSignalCache((current) => ({ ...current, [marketId]: payload }))
      if (!quiet) {
        addAlert(`signal ${payload.edge?.outcome || '—'} ${formatPp(payload.edge?.edge_pp || 0)}`, 'success')
      }
      return payload
    } catch (error) {
      addAlert(`signal run failed: ${error.message}`, 'warn')
      return null
    } finally {
      setSignalLoading(false)
    }
  }

  const runSelectedSignal = async () => {
    if (!selectedMarket) return
    await runSignalForMarket(selectedMarket.market_id)
    await fetchEntropy()
  }

  const classifyUniverse = async (seedUniverse = null) => {
    setClassifyLoading(true)
    try {
      const universe = seedUniverse?.length ? seedUniverse : (markets.length ? markets : await scanMarkets())
      const targets = universe.slice(0, 4)
      for (const market of targets) {
        await runSignalForMarket(market.market_id, { quiet: true })
      }
      if (targets.length) {
        setSelectedMarketId((current) => current || targets[0].market_id)
      }
      await fetchEntropy()
      addAlert(`classified ${targets.length} markets`, 'success')
    } finally {
      setClassifyLoading(false)
    }
  }

  const openSelectedPosition = async () => {
    if (!selectedMarket || !selectedSignal?.edge) return
    // E9: in-flight guard. Synchronous re-entry check + state-driven
    // disabled prop on the CTA. Without this, a double-click fires two
    // /open requests with different position_ids; the second usually
    // succeeds against a stale burner-derivation race and ends in a
    // PrivateSettlementHook revert, looking like a bug to the operator.
    if (openLoading) return
    const tokenId = lookupTokenId(selectedMarket, selectedSignal.edge.outcome)
    const positionId = crypto.randomUUID ? crypto.randomUUID() : `pos-${Date.now()}`

    setOpenLoading(true)
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/open`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          position_id: positionId,
          market_id: selectedMarket.market_id,
          token_id: tokenId,
          side: 'BUY',
          usdc_amount: Number(openAmount || 0),
          strategy: 'directional',
          tenant_id: selectedTenant,
        }),
      })
      if (payload.position?.position_id) {
        setSelectedPositionId(payload.position.position_id)
        await fetchAudit(payload.position.position_id)
      }
      await fetchPositions()
      addAlert(`opened ${shorten(positionId, 10)} for ${formatUsd(openAmount)}`, 'success')
    } catch (error) {
      addAlert(`open failed: ${error.message}`, 'warn')
    } finally {
      setOpenLoading(false)
    }
  }

  const resetSwarmStream = () => {
    if (swarmEventSourceRef.current) {
      swarmEventSourceRef.current.close()
      swarmEventSourceRef.current = null
    }
    if (swarmRetryTimerRef.current) {
      window.clearTimeout(swarmRetryTimerRef.current)
      swarmRetryTimerRef.current = null
    }
    swarmRetryCountRef.current = 0
    streamingMarketIdRef.current = null
  }

  const appendSwarmFeed = (kind, agent, message) => {
    setSwarmFeed((current) => [{
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      kind,
      agent,
      message,
    }, ...current].slice(0, 40))
  }

  // E2: cap swarm reconnect attempts. Swarm runs may have completed
  // server-side; retrying forever after disconnect is misleading. 3 tries
  // with exponential backoff (1s / 2s / 4s) is the cheap "wifi blip"
  // recovery; after that we mark offline and let the user re-click Debate.
  const SWARM_MAX_RETRIES = 3

  const streamSelectedSignal = () => {
    if (!selectedMarket) return
    const streamMarketId = selectedMarket.market_id
    const streamMarketQuestion = selectedMarket.question
    resetSwarmStream()
    setSwarmFeed([])
    setStreamLoading(true)
    setStreamStatus('connecting')
    streamingMarketIdRef.current = streamMarketId

    const openSource = () => {
      const source = new EventSource(`${SIGNAL_BASE}/api/signal/runs/stream?market_id=${encodeURIComponent(streamMarketId)}`)
      swarmEventSourceRef.current = source

      source.addEventListener('run', (event) => {
        const payload = JSON.parse(event.data)
        setStreamStatus('live')
        // Reset backoff on first server message — the stream is healthy.
        swarmRetryCountRef.current = 0
        appendSwarmFeed('run', 'run', payload.question || streamMarketQuestion)
      })
      source.addEventListener('start', (event) => {
        const payload = JSON.parse(event.data)
        appendSwarmFeed('start', 'swarm', `${payload.specs} agents · ${payload.nodes.length} nodes · ${payload.rounds} rounds`)
      })
      source.addEventListener('belief', (event) => {
        const payload = JSON.parse(event.data)
        const probs = Object.entries(payload.probabilities || {})
          .map(([key, value]) => `${key} ${(Number(value) * 100).toFixed(0)}%`)
          .join(' · ')
        appendSwarmFeed('belief', payload.agent_id, `${probs}${payload.reasoning ? ` · ${payload.reasoning}` : ''}`)
      })
      source.addEventListener('agent_error', (event) => {
        const payload = JSON.parse(event.data)
        appendSwarmFeed('error', payload.agent_id, payload.error || 'agent error')
      })
      source.addEventListener('result', async (event) => {
        const payload = JSON.parse(event.data)
        const consensus = Object.entries(payload.result?.consensus || {})
          .map(([key, value]) => `${key} ${(Number(value) * 100).toFixed(1)}%`)
          .join(' · ')
        appendSwarmFeed('result', 'consensus', consensus)
        setStreamStatus('complete')
        setStreamLoading(false)
        resetSwarmStream()
        await runSignalForMarket(streamMarketId, { quiet: true })
        if (streamMarketId === selectedMarketId) await fetchEntropy()
      })
      source.onerror = () => {
        if (source !== swarmEventSourceRef.current) return
        source.close()
        swarmEventSourceRef.current = null
        const attempt = swarmRetryCountRef.current + 1
        if (attempt > SWARM_MAX_RETRIES) {
          setStreamStatus('offline — click Debate to retry')
          setStreamLoading(false)
          addAlert(`swarm stream lost after ${SWARM_MAX_RETRIES} retries`, 'warn')
          resetSwarmStream()
          return
        }
        const delayMs = 1000 * Math.pow(2, attempt - 1)
        swarmRetryCountRef.current = attempt
        setStreamStatus(`reconnecting (${attempt}/${SWARM_MAX_RETRIES})`)
        swarmRetryTimerRef.current = window.setTimeout(() => {
          swarmRetryTimerRef.current = null
          if (streamingMarketIdRef.current === streamMarketId) openSource()
        }, delayMs)
      }
    }

    openSource()
  }

  // E2: positions stream is the demo backbone. Reconnect indefinitely with
  // exponential backoff (capped at 30s between attempts). Reset attempt
  // count on every successful event so a recovered stream behaves cleanly.
  const POSITIONS_MAX_DELAY_MS = 30000

  const startPositionsStream = useEffectEvent(() => {
    if (positionsEventSourceRef.current) {
      positionsEventSourceRef.current.close()
    }
    if (positionsRetryTimerRef.current) {
      window.clearTimeout(positionsRetryTimerRef.current)
      positionsRetryTimerRef.current = null
    }

    const openSource = () => {
      const source = new EventSource(`${EXECUTION_BASE}/api/execution/positions/stream`)
      positionsEventSourceRef.current = source

      source.addEventListener('snapshot', (event) => {
        positionsRetryCountRef.current = 0
        const payload = JSON.parse(event.data)
        const nextPositions = payload.positions || []
        setPositions(nextPositions)
        // E6: dedupe N+1 audit fetch storm. Only fetch audit for positions
        // we have not already cached. Snapshot fires on every reconnect, so
        // the un-guarded forEach used to hammer the router on flaky wifi.
        nextPositions.forEach((position) => {
          if (!auditByPosition[position.position_id]) {
            fetchAudit(position.position_id, { silent: true })
          }
        })
      })

      source.addEventListener('position', (event) => {
        positionsRetryCountRef.current = 0
        const payload = JSON.parse(event.data)
        setPositions((current) => {
          const next = current.filter((item) => item.position_id !== payload.position_id)
          next.unshift(payload)
          return next
        })
        addAlert(`position ${shorten(payload.position_id, 8)} → ${payload.status}`, payload.status === 'failed' ? 'warn' : 'info')
        fetchAudit(payload.position_id, { silent: true })
      })

      source.onerror = () => {
        if (source !== positionsEventSourceRef.current) return
        source.close()
        positionsEventSourceRef.current = null
        if (positionsUnmountedRef.current) return
        const attempt = positionsRetryCountRef.current + 1
        positionsRetryCountRef.current = attempt
        const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), POSITIONS_MAX_DELAY_MS)
        const delayLabel = delayMs >= 1000 ? `${Math.round(delayMs / 1000)}s` : `${delayMs}ms`
        addAlert(`positions stream lost — reconnecting in ${delayLabel} (attempt ${attempt})`, 'warn')
        positionsRetryTimerRef.current = window.setTimeout(() => {
          positionsRetryTimerRef.current = null
          if (!positionsUnmountedRef.current) openSource()
        }, delayMs)
      }
    }

    openSource()
  })

  const refreshGraphSurface = async () => {
    await Promise.all([refreshHealth(), fetchCryo(), fetchTopology()])
    if (selectedMarket) await fetchEntropy()
  }

  const bootTerminal = useEffectEvent(async () => {
    // Stage the boot sequence so the alpha board and terminal status hydrate
    // deterministically before lower-priority background probes begin.
    await refreshHealth()
    await fetchTerminalTicker({ silent: true })
    await loadTenants()
    await fetchFunds({ silent: true })
    await fetchPositions()

    const universe = await scanMarkets()
    if (!universe.length) return

    const seedMarketId = selectedMarketId || universe[0].market_id
    setSelectedMarketId(seedMarketId)
    await runSignalForMarket(seedMarketId, { quiet: true })
    await fetchEntropy()

    fetchCryo()
    fetchTopology()

    window.setTimeout(() => {
      classifyUniverse(universe)
    }, 150)
  })

  const refreshPulse = useEffectEvent(() => {
    refreshHealth()
    fetchTerminalTicker({ silent: true })
  })

  useEffect(() => {
    if (bootedRef.current) return
    bootedRef.current = true

    void (async () => {
      await bootTerminal()
      startPositionsStream()
    })()

    refreshTimerRef.current = window.setInterval(() => {
      refreshPulse()
    }, 30000)

    return () => {
      positionsUnmountedRef.current = true
      if (positionsEventSourceRef.current) positionsEventSourceRef.current.close()
      if (positionsRetryTimerRef.current) window.clearTimeout(positionsRetryTimerRef.current)
      if (swarmEventSourceRef.current) swarmEventSourceRef.current.close()
      if (swarmRetryTimerRef.current) window.clearTimeout(swarmRetryTimerRef.current)
      if (refreshTimerRef.current) window.clearInterval(refreshTimerRef.current)
    }
  }, [bootTerminal, startPositionsStream, refreshPulse])

  useEffect(() => {
    if (!selectedPosition) {
      setAuditEvents([])
      return
    }
    const nextEvents = auditByPosition[selectedPosition.position_id] || []
    setAuditEvents(nextEvents)
  }, [selectedPosition, auditByPosition])

  // E4: 1-second tick so the trade-in-flight elapsed counter updates
  // live during the 60-120s bridge wait. Only ticks while there's at
  // least one active position to avoid waking the renderer for nothing.
  useEffect(() => {
    if (!activeVisiblePositions.length) return
    const id = window.setInterval(() => {
      setNowSecs(Math.floor(Date.now() / 1000))
    }, 1000)
    return () => window.clearInterval(id)
  }, [activeVisiblePositions.length])

  useEffect(() => {
    if (!selectedMarket || !signalCache[selectedMarket.market_id]) return
    fetchEntropy()
  }, [selectedMarketId, selectedMarket, signalCache])

  useEffect(() => {
    if (!activeVisiblePositions.length && historicalVisiblePositions.length) {
      setShowHistory(true)
    }
  }, [activeVisiblePositions.length, historicalVisiblePositions.length])

  const orderedAuditForPosition = (positionId) => [...(auditByPosition[positionId] || [])].reverse()
  const tickerToneClass = (item) => {
    if (item?.kind !== 'price' || item?.change_pct == null) return item?.kind === 'event' ? 'tone-event' : ''
    return Number(item.change_pct) >= 0 ? 'tone-up' : 'tone-down'
  }
  const summarizeAuditPayload = (event) => {
    const payload = event?.payload || {}
    if (event?.status === 'err' && payload.error) return String(payload.error)
    if (payload.tx_hash) return `tx ${summarizeId(payload.tx_hash, 16)}`
    if (payload.fund_tx) return `tx ${summarizeId(payload.fund_tx, 16)}`
    if (payload.burn_tx_hash) return `burn ${summarizeId(payload.burn_tx_hash, 16)}`
    if (payload.mint_tx_hash) return `mint ${summarizeId(payload.mint_tx_hash, 16)}`
    if (payload.transfer_id) return `transfer ${summarizeId(payload.transfer_id, 16)}`
    if (payload.clob_order_id) return `order ${summarizeId(payload.clob_order_id, 16)}`
    if (payload.execution_id) return `keeper ${summarizeId(payload.execution_id, 16)}`
    if (payload.resolve_tx) return `resolve ${summarizeId(payload.resolve_tx, 16)}`
    if (payload.settle_tx) return `settle ${summarizeId(payload.settle_tx, 16)}`
    if (payload.payout_usdc != null) return `payout ${formatUsd(payload.payout_usdc)}`
    return ''
  }
  const statusBadgeClass = (status) => `s-${status || 'unknown'}`
  const timelineClass = (event) => event?.status === 'err' ? 'err' : event?.status === 'skip' ? 'skip' : ''
  const formatEventTime = (value) => {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return shorten(String(value), 16)
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // Recent audit events across all positions, newest first — feeds the AGENT
  // panel's `last` strip. Two events is the right density for a glance.
  const recentAuditEvents = useMemo(() => {
    const all = []
    for (const [pid, events] of Object.entries(auditByPosition || {})) {
      for (const ev of events || []) {
        all.push({ ...ev, payload: { ...(ev.payload || {}), position_id: pid } })
      }
    }
    return all.sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)).slice(0, 4)
  }, [auditByPosition])

  // Pending Fund-Agent transfers needing this signer's signature → header pill.
  // Polls every 5s. Reads from the Neon projection (DB-first), falls back to
  // the Python /execution endpoint if the DB isn't reachable.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/db/treasury/transfers/pending`)
        const json = await res.json()
        if (!cancelled && res.ok) {
          setPendingTransfers(json.transfers || [])
          return
        }
      } catch (_dbErr) { /* fall through */ }
      try {
        const res = await fetch(`${EXECUTION_BASE}/api/execution/treasury/transfers/pending`)
        const json = await res.json()
        if (!cancelled && res.ok) setPendingTransfers(json.transfers || [])
      } catch (_e) { /* swallow */ }
    }
    poll()
    const id = window.setInterval(poll, 5000)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [])

  // Lean header values — derived once, reused below.
  const treasuryBalanceDisplay = formatUsd(treasuryPlane?.gateway_balance_usdc || gatewayAvailableBalance || 0)
  const agentBalanceDisplay = formatUsd(tradingPlane?.available_to_deploy_usdc || 0)
  const activeStreamingPosition = activeVisiblePositions[0] || null
  const activeStreamElapsed = activeStreamingPosition?.created_at
    ? nowSecs - Math.floor(activeStreamingPosition.created_at)
    : null

  return (
    <div className="terminal-shell lean-shell">

      {/* HEADER BAND */}
      <header className="lean-header">
        <div className="lean-brand">
          <span className="lean-brand-mark">MIROSHARK</span>
          <a className="lean-brand-dispatch" href="https://t.me/miro_shark_bot" target="_blank" rel="noreferrer" title="Telegram dispatch">↗ dispatch</a>
        </div>

        <div className="lean-health">
          <span className={`lean-health-dot ${signalOnline ? 'is-ok' : 'is-warn'}`} title={`signal ${signalOnline ? 'online' : 'offline'}`} />
          <span className={`lean-health-dot ${executionOnline ? 'is-ok' : 'is-warn'}`} title={`router ${executionOnline ? 'online' : 'offline'}`} />
          <span className={`lean-health-dot ${zgOnline && !zgLow ? 'is-ok' : 'is-warn'}`} title={zgPillTitle} />
        </div>

        <WalletPopover label="Treasury" balance={treasuryBalanceDisplay}>
          <WalletRow label="Reserve target" value={formatUsd(treasuryPlane?.reserve_target_usdc || 0)} />
          <WalletRow label="Reserve current" value={formatUsd(treasuryPlane?.gateway_balance_usdc || 0)} />
          <WalletRow label="Signers" value={`passkey ${treasuryPlane?.passkey_ready ? '●' : '○'}  multisig ${treasuryPlane?.multisig_ready ? '●' : '○'}`} />
          <WalletRow label="Funding mode" value={treasuryPlane?.funding_mode || '—'} />
          <WalletRow label="Address" value={treasuryPlane?.address ? <EnsName address={treasuryPlane.address} /> : '—'} mono />
          <WalletDivider label="actions" />
          <WalletActionRow>
            <WalletAction label="Deposit" hint="incoming wire / bridge" glyph="↗" onClick={() => setActiveCapitalModal('deposit')} />
            <WalletAction label="Withdraw" hint="vault → external" onClick={() => setActiveCapitalModal('send')} />
            <WalletAction label="Fund Agent" hint="vault → trading wallet · multisig" onClick={() => { setFundAgentTransferId(''); setActiveCapitalModal('fund-agent') }} />
          </WalletActionRow>
        </WalletPopover>

        <WalletPopover label="Agent" balance={agentBalanceDisplay} accent>
          <WalletRow label="Deployable" value={formatUsd(tradingPlane?.available_to_deploy_usdc || 0)} />
          <WalletRow label="Replenish needed" value={tradingPlane?.replenish_needed ? 'yes' : 'no'} tone={tradingPlane?.replenish_needed ? 'warn' : ''} />
          <div className="wallet-pop-row">
            <span className="wallet-pop-row-label">Fund</span>
            <span className="wallet-pop-row-value wallet-pop-fund-cell">
              <select
                className="wallet-pop-select"
                value={selectedTenant}
                onChange={(e) => setSelectedTenant(e.target.value)}
              >
                {tenantOptions.map((t) => {
                  const fund = fundsByTenant[t]
                  const label = fund ? fund.display_name : t.toUpperCase()
                  return <option key={t} value={t}>{label}</option>
                })}
              </select>
              <button
                type="button"
                className="wallet-pop-add-fund"
                onClick={() => setAddFundOpen(true)}
                title="Provision a new fund (trading wallet + ENS subname)"
              >+ Add fund</button>
            </span>
          </div>
          {selectedFund?.ens_name ? (
            <WalletRow label="ENS" value={<EnsName name={selectedFund.ens_name} address={selectedFund.trading_address} />} mono />
          ) : null}
          <WalletRow label="Venue" value={tradingPlane?.venue || 'Polymarket'} />
          <WalletRow label="Address" value={tradingPlane?.address ? <EnsName address={tradingPlane.address} /> : '—'} mono />
          <div className="wallet-pop-row">
            <span className="wallet-pop-row-label">Autonomous</span>
            <span className="wallet-pop-row-value wallet-pop-autonomous-cell">
              {pinataConnected ? (
                <>
                  <span className={`wallet-pop-autonomous-pulse s-${pinataRunState}`} aria-hidden="true" />
                  <span>{pinataRunState}</span>
                  <button
                    type="button"
                    className="wallet-pop-autonomous-btn"
                    disabled={pinataLoading}
                    onClick={() => setPinataRunState(pinataAutonomousNext)}
                  >{pinataRunState === 'running' ? 'Pause' : 'Run'}</button>
                </>
              ) : 'not connected'}
            </span>
          </div>
          <WalletDivider label="actions" />
          <WalletActionRow>
            <WalletAction label="Bridge" hint="Arb ↔ Polygon" glyph="↗" onClick={() => setActiveCapitalModal('bridge')} />
            <WalletAction label="Swap" hint="USDC venues" glyph="↗" onClick={() => setActiveCapitalModal('swap')} />
            <WalletAction label="Request from Treasury" hint="open Fund Agent dialog · multisig" onClick={() => { setFundAgentTransferId(''); setActiveCapitalModal('fund-agent') }} />
            {pinataConnector?.onrampChatUrl ? (
              <WalletAction label="Fund via MoonPay" hint="card → wallet" glyph="↗" onClick={() => openChatPanel(pinataConnector.onrampChatUrl, 'MoonPay Onramp')} />
            ) : null}
            {pinataConnector?.agentChatUrl ? (
              <WalletAction label="Chat with agent" hint="open DM" glyph="↗" onClick={() => openChatPanel(pinataConnector.agentChatUrl, 'Trader Agent')} />
            ) : null}
          </WalletActionRow>
        </WalletPopover>

        {pendingTransfers.length > 0 ? (
          <button
            type="button"
            className="lean-pending-pill"
            onClick={() => { setFundAgentTransferId(pendingTransfers[0].transfer_id); setActiveCapitalModal('fund-agent') }}
            title={`${pendingTransfers.length} transfer${pendingTransfers.length > 1 ? 's' : ''} awaiting your signature`}
          >
            pending sig {pendingTransfers.length}
          </button>
        ) : null}

        {activeStreamingPosition ? (
          <button
            type="button"
            className="lean-active-pos"
            onClick={() => setSelectedPositionId(activeStreamingPosition.position_id)}
            title="Jump to active position"
          >
            pos {shorten(activeStreamingPosition.position_id, 10)} ▸ {formatElapsed(activeStreamElapsed || 0)}
          </button>
        ) : null}
      </header>

      {/* NEWSWIRE BAND */}
      <div className="lean-news">
        <div className="lean-news-track">
          {duplicatedHeadlineItems.map((item) => (
            item.url ? (
              <a key={item._tickerKey} className="lean-news-item" href={item.url} target="_blank" rel="noreferrer">
                <span className="lean-news-source">{item.source || 'Desk'}</span>
                <span>{item.anchor}</span>
              </a>
            ) : (
              <span key={item._tickerKey} className="lean-news-item">
                <span className="lean-news-source">{item.source || 'Desk'}</span>
                <span>{item.anchor}</span>
              </span>
            )
          ))}
        </div>
      </div>

      {onboardingMode ? (
        <div className="lean-onboarding-banner">
          Onboarding active. Finish wallets, then return to <a href="/setup">setup</a>.
        </div>
      ) : null}

      {/* MAIN CANVAS */}
      <main className="lean-canvas">

        {/* MARKETS */}
        <section className="lean-region">
          <header className="lean-region-head">
            <span className="lean-section-label">MARKETS</span>
            <div className="lean-region-head-r">
              {streamLoading || streamStatus === 'live' ? (
                <span className="lean-swarm-running">
                  <span className="lean-swarm-pulse" aria-hidden="true" />
                  swarm running
                </span>
              ) : (
                <span className="lean-swarm-idle">{swarmScaleLabel}</span>
              )}
              <button type="button" className="lean-mini-btn" disabled={marketLoading} onClick={scanMarkets}>{marketLoading ? '…' : 'Scan'}</button>
              <button type="button" className="lean-mini-btn" disabled={classifyLoading} onClick={classifyUniverse}>{classifyLoading ? '…' : 'Classify'}</button>
            </div>
          </header>

          <ol className="lean-markets">
            {rankedMarkets.length ? rankedMarkets.map((row) => {
              const edgePp = Number(row.signal?.edge?.edge_pp || 0)
              return (
                <li
                  key={row.market_id}
                  className={`lean-market-row ${row.market_id === selectedMarketId ? 'is-selected' : ''} ${streamLoading && row.market_id !== selectedMarketId ? 'is-locked' : ''}`}
                  onClick={() => {
                    if (streamLoading && row.market_id !== selectedMarketId) return
                    setSelectedMarketId(row.market_id)
                    if (!signalCache[row.market_id] && !signalLoading && !streamLoading) {
                      runSignalForMarket(row.market_id, { quiet: true })
                    }
                  }}
                >
                  <span className="lean-market-marker">{row.market_id === selectedMarketId ? '▸' : ''}</span>
                  <span className="lean-market-question">{row.question}</span>
                  <span className="lean-market-liq">{formatUsd(row.liquidity_usd)}</span>
                  <span className={`lean-market-edge ${row.signal?.edge ? (edgePp >= 0 ? 'tone-pos' : 'tone-neg') : ''}`}>
                    {row.signal?.edge ? formatPp(edgePp) : '—'}
                  </span>
                  <span className="lean-market-verdict">{row.signal?.edge?.outcome || '—'}</span>
                  <span className="lean-market-conf">{row.signal ? formatFloat(row.signal.confidence || 0) : '—'}</span>
                </li>
              )
            }) : <li className="lean-empty">Run Scan to load live markets.</li>}
          </ol>
        </section>

        {/* SELECTED MARKET — verdict + diagnostics + graph + debate + agent */}
        <section className="lean-region lean-selected">
          <header className="lean-region-head">
            <span className="lean-section-label lean-selected-q">{selectedMarket?.question || 'No market selected'}</span>
            <div className="lean-region-head-r">
              <input
                id="open-amount"
                type="number"
                min="1"
                step="1"
                className="lean-amount-input"
                value={openAmount}
                onChange={(event) => setOpenAmount(Number(event.target.value))}
              />
              <span className="lean-amount-unit">USDC</span>
              <button
                type="button"
                className="lean-open-btn"
                disabled={!canOpenSelected || openLoading}
                onClick={openSelectedPosition}
              >{openLoading ? 'Opening…' : 'Open ▸'}</button>
            </div>
          </header>

          <div className="lean-verdict-row">
            <span className={`lean-verdict-outcome ${selectedSignal?.edge?.outcome === 'YES' ? 'tone-pos' : selectedSignal?.edge?.outcome === 'NO' ? 'tone-neg' : ''}`}>
              {selectedSignal?.edge?.outcome || '—'}
            </span>
            <span className="lean-verdict-edge">{formatPp(selectedSignal?.edge?.edge_pp || 0)}</span>
            <span className="lean-verdict-conf">{formatFloat(selectedSignal?.confidence || 0)}</span>
            <span className="lean-verdict-divider">·</span>
            <span className="lean-verdict-agreement">
              Agreement {selectedSignal?.agreement_score != null ? Number(selectedSignal.agreement_score).toFixed(2) : '—'}
            </span>
          </div>

          <SwarmQualityPanel signal={selectedSignal} />
          <SignalDiagnosticStrip signal={selectedSignal} outcomes={selectedMarket?.outcomes || []} />

          <div className="lean-selected-grid">
            <div className="lean-graph-cell">
              <GraphPanel
                graphData={liveGraphData}
                loading={classifyLoading}
                currentPhase={3}
                isSimulating={streamLoading}
                onRefresh={refreshGraphSurface}
              />
            </div>

            <div className="lean-side-cell">
              <div className="lean-debate">
                <header className="lean-debate-head">
                  <span className="lean-section-label">DEBATE</span>
                  <div className="lean-debate-head-r">
                    <span className={`lean-debate-status s-${(streamStatus || 'idle').replace(/\s.*$/, '')}`}>{streamStatus}</span>
                    <button type="button" className="lean-mini-btn" disabled={!selectedMarket || streamLoading} onClick={streamSelectedSignal}>
                      {streamLoading ? 'Streaming' : 'Run'}
                    </button>
                  </div>
                </header>
                <ol className="lean-debate-feed">
                  {swarmFeed.length ? swarmFeed.slice(0, 8).map((item) => (
                    <li key={item.id} className={`lean-debate-item kind-${item.kind}`}>
                      <span className="lean-debate-agent">{item.agent}</span>
                      <span className="lean-debate-msg">{item.message}</span>
                    </li>
                  )) : <li className="lean-empty">Click Run to start the debate.</li>}
                </ol>
              </div>

              <AgentPanel
                pinataConnector={pinataConnector}
                signal={selectedSignal}
                thresholds={readinessThresholds}
                recentEvents={recentAuditEvents}
                telegramUrl="https://t.me/miro_shark_bot"
              />
            </div>
          </div>

          {selectedSignal?.reasoning ? (
            <p className="lean-reasoning">{selectedSignal.reasoning}</p>
          ) : null}
        </section>

        {/* PNL BENTO */}
        <PnlBento positions={visiblePositions} />

        {/* POSITIONS */}
        <section className="lean-region">
          <header className="lean-region-head">
            <span className="lean-section-label">POSITIONS</span>
            <div className="lean-region-head-r">
              <span className="lean-positions-summary">{executionSummary}</span>
              <button type="button" className="lean-mini-btn" onClick={fetchPositions}>Refresh</button>
            </div>
          </header>

          <ul className="lean-positions">
            {!visiblePositions.length ? <li className="lean-empty">No positions yet.</li> : null}

            {activeVisiblePositions.map((position) => {
              const stage = inflightStage(position)
              const elapsed = position.created_at ? nowSecs - Math.floor(position.created_at) : null
              const events = orderedAuditForPosition(position.position_id)
              const isOpen = selectedPositionId === position.position_id
              return (
                <li
                  key={position.position_id}
                  className={`lean-position lean-position-active ${isOpen ? 'is-open' : ''}`}
                  onClick={() => setSelectedPositionId(isOpen ? '' : position.position_id)}
                >
                  <div className="lean-position-row">
                    <span className="lean-position-marker">▸</span>
                    <span className="lean-position-id">{shorten(position.position_id, 12)}</span>
                    <span className="lean-position-side">{position.side}</span>
                    <span className="lean-position-amount">{formatUsd(position.usdc_amount)}</span>
                    <span className="lean-position-stage">{stage?.label || position.status}</span>
                    {elapsed != null ? <span className="lean-position-elapsed">{formatElapsed(elapsed)}</span> : null}
                    {stage?.eta ? <span className="lean-position-eta">{stage.eta}</span> : null}
                  </div>
                  {isOpen && events.length ? (
                    <div className="lean-position-timeline">
                      {events.slice(-6).map((event) => (
                        <span key={`${event.ts}-${event.event}`} className={`lean-tl-event ${timelineClass(event)}`}>
                          <span className="lean-tl-event-name">{event.event}</span>
                          {summarizeAuditPayload(event) ? <span className="lean-tl-event-meta">{summarizeAuditPayload(event)}</span> : null}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </li>
              )
            })}

            {historicalVisiblePositions.slice(0, showHistory ? historicalVisiblePositions.length : 3).map((position) => {
              const pnl = position.payout_usdc != null ? Number(position.payout_usdc) - Number(position.usdc_amount) : null
              const pnlTone = pnl == null ? '' : pnl > 0 ? 'tone-pos' : pnl < 0 ? 'tone-neg' : ''
              const settleHash = position.settle_tx
              const settleUrl = explorerUrlFor(settleHash)
              return (
                <li key={position.position_id} className="lean-position lean-position-settled">
                  <div className="lean-position-row">
                    <span className="lean-position-marker">{position.status === 'failed' ? '✕' : '✓'}</span>
                    <span className="lean-position-id">{shorten(position.position_id, 12)}</span>
                    <span className="lean-position-side">{position.side}</span>
                    <span className="lean-position-amount">{formatUsd(position.usdc_amount)}</span>
                    <span className="lean-position-status">{position.status}</span>
                    {position.payout_usdc != null ? (
                      <span className="lean-position-payout">→ {formatUsd(position.payout_usdc)}</span>
                    ) : null}
                    {pnl != null ? (
                      <span className={`lean-position-pnl ${pnlTone}`}>
                        {pnl >= 0 ? '+' : '-'}{formatUsd(Math.abs(pnl))}
                      </span>
                    ) : null}
                    {settleUrl ? <a className="lean-position-link" href={settleUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗</a> : null}
                  </div>
                </li>
              )
            })}

            {historicalVisiblePositions.length > 3 ? (
              <li className="lean-position-history-toggle" onClick={() => setShowHistory((v) => !v)}>
                {showHistory ? '▴ collapse history' : `▾ show ${historicalVisiblePositions.length - 3} more settled`}
              </li>
            ) : null}
          </ul>
        </section>

      </main>

      <WalletActionModals
        modal={activeCapitalModal}
        onClose={() => { setActiveCapitalModal(''); setFundAgentTransferId('') }}
        capitalPlane={capitalPlane}
        tenantId={selectedTenant}
        fundAgentTransferId={fundAgentTransferId}
      />

      <AddFundDialog
        open={addFundOpen}
        onClose={() => setAddFundOpen(false)}
        onCreated={(fund) => {
          // Refresh the funds list and switch into the newly created tenant.
          fetchFunds({ silent: true }).then(() => {
            if (fund?.tenant_id) setSelectedTenant(fund.tenant_id)
          })
        }}
      />

      {chatPanel.open ? (
        <aside className="pinata-chat-panel" role="dialog" aria-label={`${chatPanel.title} chat`}>
          <header className="pinata-chat-head">
            <div>
              <span className="pinata-chat-title">{chatPanel.title}</span>
              <span className="pinata-chat-sub">Pinata Agents</span>
            </div>
            <div className="pinata-chat-actions">
              <a className="lean-mini-btn" href={chatPanel.url} target="_blank" rel="noreferrer">Open in tab</a>
              <button type="button" className="lean-mini-btn" onClick={closeChatPanel}>Close</button>
            </div>
          </header>
          <iframe
            className="pinata-chat-iframe"
            src={chatPanel.url}
            title={chatPanel.title}
            allow="clipboard-write; clipboard-read; payment"
          />
          <footer className="pinata-chat-foot">
            If the chat does not load, the agent host blocks iframes — use "Open in tab".
          </footer>
        </aside>
      ) : null}
    </div>
  )
}
