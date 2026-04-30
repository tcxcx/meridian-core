'use client'

import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'

import GraphPanel from '@/components/miroshark/graph-panel'
import PortfolioPerformance from '@/components/miroshark/portfolio-performance'
import WalletActionModals from '@/components/miroshark/wallet-action-modals'
import { demoGraphData } from '@/lib/demo-graph'
import { buildOpportunityGraph, scoreOpportunity } from '@/lib/opportunity-graph'

const BACKEND_BASE = '/backend'
const SIGNAL_BASE = '/signal'
const EXECUTION_BASE = '/execution'

const scenarioVariables = [
  { key: 'geopoliticalStress', label: 'Geopolitical Stress' },
  { key: 'diplomaticBreakthrough', label: 'Diplomatic Breakthrough' },
  { key: 'energyDislocation', label: 'Energy Dislocation' },
  { key: 'cryptoMomentum', label: 'Crypto Momentum' },
  { key: 'electionTurbulence', label: 'Election Turbulence' },
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

async function getProject(projectId) {
  return readJson(`${BACKEND_BASE}/api/graph/project/${projectId}`)
}

async function getGraphData(graphId) {
  return readJson(`${BACKEND_BASE}/api/graph/data/${graphId}`)
}

async function getSimulation(simulationId) {
  return readJson(`${BACKEND_BASE}/api/simulation/${simulationId}`)
}

export default function OperatorTerminal() {
  const [markets, setMarkets] = useState([])
  const [marketLoading, setMarketLoading] = useState(false)
  const [classifyLoading, setClassifyLoading] = useState(false)
  const [signalLoading, setSignalLoading] = useState(false)
  const [streamLoading, setStreamLoading] = useState(false)

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

  const [graphMode, setGraphMode] = useState('live')
  const [graphSourceValue, setGraphSourceValue] = useState('')
  const [contextGraphData, setContextGraphData] = useState(null)
  const [graphLoading, setGraphLoading] = useState(false)
  const [graphError, setGraphError] = useState('')
  const [graphResolvedLabel, setGraphResolvedLabel] = useState('')

  const positionsEventSourceRef = useRef(null)
  const swarmEventSourceRef = useRef(null)
  const refreshTimerRef = useRef(null)
  const bootedRef = useRef(false)

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
    return [...new Set(['default', ...ids])]
  }, [tenants])
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
    const classified = Math.max(Object.keys(signalCache || {}).length, 1)
    const scale = Math.max(1000000, classified * 250000)
    return `up to ${(scale / 1000000).toFixed(1)}M agents`
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
  const chainLabel = `${routerHealth?.chains?.settlement || 'settlement?'} ⇄ ${routerHealth?.chains?.trading || 'trading?'}`
  const executionOnline = routerHealth?.status === 'ok'
  const signalOnline = signalHealth?.status === 'ok'
  const openclawEnabled = Boolean(operatorStatus?.automation?.openclaw_enabled || operatorStatus?.automation?.openclaw_session)
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
  const capitalSourceLabel = capitalPlane?.source || ''
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
  const activeGraphData = graphMode === 'live' ? liveGraphData : (contextGraphData || demoGraphData)
  const graphSourcePlaceholder = graphMode === 'project' ? 'proj_…' : graphMode === 'simulation' ? 'simulation id' : 'graph id'
  const graphStatusText = useMemo(() => {
    if (graphMode === 'live') {
      const nodes = activeGraphData?.nodes?.length || 0
      const edges = activeGraphData?.edges?.length || 0
      return `Live opportunity graph · ${nodes} nodes · ${edges} edges · selected tenant ${selectedTenant.toUpperCase()}`
    }
    if (graphLoading) return 'Loading analysis context graph…'
    if (graphError) return graphError
    if (graphResolvedLabel) return `Loaded ${graphResolvedLabel}`
    return 'Load a project, simulation, or graph id to layer richer context over the terminal.'
  }, [graphMode, activeGraphData, selectedTenant, graphLoading, graphError, graphResolvedLabel])

  const headlineItems = useMemo(() => {
    if (terminalTicker.headlines?.length) return terminalTicker.headlines
    return [{ kind: 'headline', source: 'Miroshark', anchor: 'Newswire is syncing Reuters and Bloomberg market coverage', published_label: null }]
  }, [terminalTicker])
  const tapeItems = useMemo(() => {
    if (terminalTicker.tape?.length) return terminalTicker.tape
    return [{ kind: 'event', label: 'Market tape is warming up · waiting for live macro prices and operator events' }]
  }, [terminalTicker])
  const duplicatedHeadlineItems = useMemo(() => loopTickerItems(headlineItems), [headlineItems])
  const duplicatedTapeItems = useMemo(() => loopTickerItems(tapeItems), [tapeItems])

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
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/audit/${positionId}`)
      setAuditByPosition((current) => ({ ...current, [positionId]: payload.events || [] }))
      if (selectedPositionId === positionId) {
        setAuditEvents(payload.events || [])
      }
    } catch (error) {
      if (selectedPositionId === positionId) {
        setAuditEvents([])
      }
      if (!silent) addAlert(`audit fetch failed: ${error.message}`, 'warn')
    }
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

  const loadTenants = async () => {
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/tenants`)
      setTenants(payload.tenants || [])
    } catch (error) {
      addAlert(`tenant registry failed: ${error.message}`, 'warn')
    }
  }

  const fetchPositions = async () => {
    try {
      const payload = await readJson(`${EXECUTION_BASE}/api/execution/positions`)
      const nextPositions = payload.positions || []
      setPositions(nextPositions)
      if (!selectedPositionId && nextPositions.length) {
        setSelectedPositionId(nextPositions[0].position_id)
      }
      nextPositions.forEach((position) => {
        if (!auditByPosition[position.position_id]) {
          fetchAudit(position.position_id, { silent: true })
        }
      })
    } catch (error) {
      addAlert(`positions fetch failed: ${error.message}`, 'warn')
    }
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
        addAlert(`signal ${payload.edge?.outcome || '—'} ${formatPp(payload.edge?.edge_pp || 0)} · conf ${formatFloat(payload.confidence || 0)}`, 'success')
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
      addAlert(`classified ${targets.length} top markets into the alpha board`, 'success')
    } finally {
      setClassifyLoading(false)
    }
  }

  const openSelectedPosition = async () => {
    if (!selectedMarket || !selectedSignal?.edge) return
    const tokenId = lookupTokenId(selectedMarket, selectedSignal.edge.outcome)
    const positionId = crypto.randomUUID ? crypto.randomUUID() : `pos-${Date.now()}`

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
    }
  }

  const resetSwarmStream = () => {
    if (swarmEventSourceRef.current) {
      swarmEventSourceRef.current.close()
      swarmEventSourceRef.current = null
    }
  }

  const appendSwarmFeed = (kind, agent, message) => {
    setSwarmFeed((current) => [{
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      kind,
      agent,
      message,
    }, ...current].slice(0, 40))
  }

  const streamSelectedSignal = () => {
    if (!selectedMarket) return
    resetSwarmStream()
    setSwarmFeed([])
    setStreamLoading(true)
    setStreamStatus('connecting')

    const source = new EventSource(`${SIGNAL_BASE}/api/signal/runs/stream?market_id=${encodeURIComponent(selectedMarket.market_id)}`)
    swarmEventSourceRef.current = source

    source.addEventListener('run', (event) => {
      const payload = JSON.parse(event.data)
      setStreamStatus('live')
      appendSwarmFeed('run', 'run', payload.question || selectedMarket.question)
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
      await runSignalForMarket(selectedMarket.market_id, { quiet: true })
      await fetchEntropy()
    })
    source.onerror = () => {
      setStreamStatus('offline')
      setStreamLoading(false)
      addAlert('swarm stream disconnected', 'warn')
      resetSwarmStream()
    }
  }

  const startPositionsStream = useEffectEvent(() => {
    if (positionsEventSourceRef.current) {
      positionsEventSourceRef.current.close()
    }
    const source = new EventSource(`${EXECUTION_BASE}/api/execution/positions/stream`)
    positionsEventSourceRef.current = source

    source.addEventListener('snapshot', (event) => {
      const payload = JSON.parse(event.data)
      const nextPositions = payload.positions || []
      setPositions(nextPositions)
      nextPositions.forEach((position) => fetchAudit(position.position_id, { silent: true }))
    })

    source.addEventListener('position', (event) => {
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
      addAlert('positions stream disconnected', 'warn')
      if (positionsEventSourceRef.current) {
        positionsEventSourceRef.current.close()
        positionsEventSourceRef.current = null
      }
    }
  })

  const resolveContextGraphId = async () => {
    if (graphMode === 'graph') {
      setGraphResolvedLabel(`graph ${graphSourceValue}`)
      return graphSourceValue
    }
    if (graphMode === 'project') {
      const project = await getProject(graphSourceValue)
      const graphId = project?.data?.graph_id
      if (!graphId) throw new Error('project has no graph id')
      setGraphResolvedLabel(`project ${graphSourceValue} → ${graphId}`)
      return graphId
    }

    const simulation = await getSimulation(graphSourceValue)
    const simulationData = simulation?.data
    if (!simulationData) throw new Error('simulation not found')
    if (simulationData.graph_id) {
      setGraphResolvedLabel(`simulation ${graphSourceValue} → ${simulationData.graph_id}`)
      return simulationData.graph_id
    }
    if (simulationData.project_id) {
      const project = await getProject(simulationData.project_id)
      const graphId = project?.data?.graph_id
      if (!graphId) throw new Error('simulation project has no graph id')
      setGraphResolvedLabel(`simulation ${graphSourceValue} → ${graphId}`)
      return graphId
    }
    throw new Error('simulation has no graph id or project id')
  }

  const loadContextGraph = async () => {
    if (graphMode === 'live' || !graphSourceValue) return
    setGraphLoading(true)
    setGraphError('')

    try {
      const graphId = await resolveContextGraphId()
      const response = await getGraphData(graphId)
      if (!response?.data) throw new Error('graph data response was empty')
      setContextGraphData(response.data)
      addAlert(`loaded analysis graph ${shorten(graphId, 10)}`, 'success')
    } catch (error) {
      setContextGraphData(null)
      setGraphError(error.message || 'failed to load graph')
      addAlert(`graph load failed: ${error.message}`, 'warn')
    } finally {
      setGraphLoading(false)
    }
  }

  const refreshGraphSurface = async () => {
    if (graphMode === 'live') {
      await Promise.all([refreshHealth(), fetchCryo(), fetchTopology()])
      if (selectedMarket) await fetchEntropy()
      return
    }
    await loadContextGraph()
  }

  const bootTerminal = useEffectEvent(async () => {
    // Stage the boot sequence so the alpha board and terminal status hydrate
    // deterministically before lower-priority background probes begin.
    await refreshHealth()
    await fetchTerminalTicker({ silent: true })
    await loadTenants()
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
      if (positionsEventSourceRef.current) positionsEventSourceRef.current.close()
      if (swarmEventSourceRef.current) swarmEventSourceRef.current.close()
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

  return (
    <div className="terminal-shell">
      <header className="terminal-header">
        <div className="brand-block">
          <div className="brand-mark">MIROSHARK</div>
          <div className="brand-sub">single operator terminal for graph-native swarm trading</div>
        </div>
        <div className="status-strip">
          <span className="status-pill">{operatorModeLabel}</span>
          <span className="status-pill">{chainLabel}</span>
          <span className={`status-pill ${signalOnline ? '' : 'warn'}`}>signal {signalOnline ? 'online' : 'offline'}</span>
          <span className={`status-pill ${executionOnline ? '' : 'warn'}`}>router {executionOnline ? 'online' : 'offline'}</span>
          <span className={`status-pill ${openclawEnabled ? '' : 'warn'}`}>openclaw {openclawEnabled ? 'ready' : 'not wired'}</span>
        </div>
      </header>

      <div className="ticker-stack">
        <div className="ticker-bar">
          <div className="ticker-tag">NEWSWIRE</div>
          <div className="ticker-viewport">
            <div className="ticker-track newswire-track">
              {duplicatedHeadlineItems.map((item) => (
                item.url ? (
                  <a
                    key={item._tickerKey}
                    className="ticker-item headline-item headline-link"
                    href={item.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <span className="ticker-source">{item.source || 'Desk'}</span>
                    <span>{item.anchor}</span>
                    {item.published_label ? <span className="ticker-meta">{item.published_label}</span> : null}
                  </a>
                ) : (
                  <span key={item._tickerKey} className="ticker-item headline-item">
                    <span className="ticker-source">{item.source || 'Desk'}</span>
                    <span>{item.anchor}</span>
                    {item.published_label ? <span className="ticker-meta">{item.published_label}</span> : null}
                  </span>
                )
              ))}
            </div>
          </div>
        </div>

        <div className="ticker-bar">
          <div className="ticker-tag alt">MARKET TAPE</div>
          <div className="ticker-viewport">
            <div className="ticker-track market-track">
              {duplicatedTapeItems.map((item) => (
                <span key={item._tickerKey} className={`ticker-item ${tickerToneClass(item)}`}>
                  {item.kind === 'price' ? (
                    <>
                      <span className="ticker-source">{item.symbol}</span>
                      <span>{formatTickerPrice(item.price)}</span>
                      {item.change_pct != null ? <span className="ticker-change">{formatSignedPercent(item.change_pct)}</span> : null}
                      <span className="ticker-meta">{item.label}</span>
                    </>
                  ) : (
                    <>
                      <span className="ticker-source">OPS</span>
                      <span>{item.label}</span>
                    </>
                  )}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <main className="terminal-grid">
        <aside className="terminal-rail">
          <section className="rail-card accent-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 0</span>
                <span className="card-eyebrow">Automation</span>
              </div>
              <span className="card-head-r">24/7</span>
            </div>
            <div className="card-title">Human + AI operator lane</div>
            <p className="card-copy">
              Swarm intelligence and execution now live in one app. Universe classification, swarm debate, graph analysis, alerts, and settlement inventory all stay inside this terminal.
            </p>
            <dl className="metric-list">
              <div className="metric-row"><dt>Mode</dt><dd>{operatorStatus.mode || 'manual'}</dd></div>
              <div className="metric-row"><dt>Ready now</dt><dd>{actionableMarkets.length}</dd></div>
              <div className="metric-row"><dt>Loop cadence</dt><dd>{operatorStatus.interval_s ? `${operatorStatus.interval_s}s` : 'n/a'}</dd></div>
              <div className="metric-row"><dt>Strategies</dt><dd>{(operatorStatus.strategies || []).join(', ') || 'directional'}</dd></div>
              <div className="metric-row"><dt>Coverage</dt><dd>{signalCoverage}</dd></div>
              <div className="metric-row"><dt>Unified USDC</dt><dd>{formatUsd(capitalBalances.grand_total || operatorStatus.capital?.total_capital || 0)}</dd></div>
              <div className="metric-row"><dt>Per position</dt><dd>{formatUsd(capitalPolicy.per_position_max_usdc || operatorStatus.capital?.per_position_max || 0)}</dd></div>
              <div className="metric-row"><dt>Threshold</dt><dd>{readinessThresholdLabel}</dd></div>
            </dl>
          </section>

          <section className="rail-card accent-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">CAP</span>
                <span className="card-eyebrow">Gateway Capital Plane</span>
              </div>
              <span className="card-head-r">polygon-first</span>
            </div>
            <div className="card-title">Unified balance for treasury and trading</div>
            <p className="card-copy">
              Sendero’s gateway-migration logic now drives the wallet model here: treasury stays passkey-protected, the trading wallet deploys unified USDC on Polygon, KeeperHub handles agentic money movement, and OpenClaw closes the loop.
            </p>
            {capitalSourceLabel ? <div className="detail-note">Reference flow: {capitalSourceLabel}</div> : null}
            <div className="wallet-hero">
              <div className="wallet-hero-card">
                <div className="wallet-kicker">Business Balance</div>
                <div className="wallet-amount">${formatMoney(spendableBusinessBalance)}</div>
                <div className="wallet-amount-sub">spendable now · ${formatMoney(trackedBusinessBalance)} tracked</div>
                <div className="wallet-token-mark">UNIFIED USDC</div>
              </div>
              <div className="wallet-actions-grid">
                <button type="button" className="wallet-action-btn" onClick={() => setActiveCapitalModal('deposit')}>
                  <span className="wallet-action-icon">+</span>
                  <span>Deposit</span>
                </button>
                <button type="button" className="wallet-action-btn" onClick={() => setActiveCapitalModal('send')}>
                  <span className="wallet-action-icon">→</span>
                  <span>Send</span>
                </button>
                <button type="button" className="wallet-action-btn" onClick={() => setActiveCapitalModal('swap')}>
                  <span className="wallet-action-icon">⇄</span>
                  <span>Swap</span>
                </button>
                <button type="button" className="wallet-action-btn" onClick={() => setActiveCapitalModal('bridge')}>
                  <span className="wallet-action-icon">⤴</span>
                  <span>Bridge</span>
                </button>
              </div>
            </div>
            <div className="wallet-balance-grid">
              <div className="wallet-balance-cell"><span>{treasuryFundingMode.startsWith('polygon') ? 'Polygon available' : 'Gateway available'}</span><strong>${formatMoney(gatewayAvailableBalance)}</strong></div>
              <div className="wallet-balance-cell"><span>At risk</span><strong>${formatMoney(capitalBalances.deployed_at_risk || 0)}</strong></div>
              <div className="wallet-balance-cell"><span>Pending credit</span><strong>${formatMoney(pendingCreditBalance)}</strong></div>
              <div className="wallet-balance-cell"><span>Ops staging</span><strong>${formatMoney(opsStagingBalance)}</strong></div>
              <div className="wallet-balance-cell"><span>Trading target</span><strong>${formatMoney(tradingPlane.target_balance_usdc || 0)}</strong></div>
              <div className="wallet-balance-cell"><span>Sweep pending</span><strong>${formatMoney(capitalBalances.profit_sweep_pending || 0)}</strong></div>
            </div>
            {hasBalanceMotion ? (
              <div className="wallet-motion-note">
                Funds in motion: ${formatMoney(pendingCreditBalance)} finalizing and ${formatMoney(opsStagingBalance)} sitting in ops staging.
              </div>
            ) : null}
            <div className="capital-subsection">
              <div className="capital-subhead">Wallet system</div>
              <div className="wallet-system-grid">
                <article className="wallet-system-card">
                  <div className="wallet-system-head">
                    <span>Treasury Wallet</span>
                    <span className="wallet-system-tag">vault</span>
                  </div>
                  <div className="wallet-system-copy">Passkey-protected reserve and profit vault.</div>
                  <div className="capital-pill-row">
                    <span className={`capital-pill ${treasuryPlane.passkey_ready ? 'is-ready' : 'is-blocked'}`}>passkey {treasuryPlane.passkey_ready ? 'ready' : 'blocked'}</span>
                    <span className={`capital-pill ${treasuryPlane.multisig_ready ? 'is-ready' : 'is-blocked'}`}>multisig {treasuryPlane.multisig_ready ? 'ready' : 'blocked'}</span>
                  </div>
                  <dl className="metric-list compact">
                    <div className="metric-row"><dt>Reserve target</dt><dd>{formatUsd(treasuryPlane.reserve_target_usdc || 0)}</dd></div>
                    <div className="metric-row"><dt>Gateway reserve</dt><dd>{formatUsd(treasuryPlane.gateway_balance_usdc || 0)}</dd></div>
                    <div className="metric-row"><dt>Funding mode</dt><dd>{treasuryPlane.funding_mode || 'unknown'}</dd></div>
                    <div className="metric-row"><dt>Address</dt><dd>{treasuryPlane.address ? shorten(treasuryPlane.address, 12) : 'pending'}</dd></div>
                    {treasuryPlane.legacy_circle_treasury_address ? (
                      <div className="metric-row"><dt>Legacy Circle</dt><dd>{shorten(treasuryPlane.legacy_circle_treasury_address, 12)}</dd></div>
                    ) : null}
                  </dl>
                </article>
                <article className="wallet-system-card">
                  <div className="wallet-system-head">
                    <span>Trading Wallet</span>
                    <span className="wallet-system-tag">agent rail</span>
                  </div>
                  <div className="wallet-system-copy">Unified USDC budget materialized onto the prediction-market rail.</div>
                  <dl className="metric-list compact">
                    <div className="metric-row"><dt>Venue</dt><dd>{tradingPlane.venue || 'Polymarket'}</dd></div>
                    <div className="metric-row"><dt>Deployable</dt><dd>{formatUsd(tradingPlane.available_to_deploy_usdc || 0)}</dd></div>
                    <div className="metric-row"><dt>Replenish tranche</dt><dd>{formatUsd(tradingPlane.replenish_tranche_usdc || 0)}</dd></div>
                    <div className="metric-row"><dt>Needs replenish</dt><dd>{tradingPlane.replenish_needed ? 'yes' : 'no'}</dd></div>
                    <div className="metric-row"><dt>Address</dt><dd>{tradingPlane.address ? shorten(tradingPlane.address, 12) : 'pending'}</dd></div>
                  </dl>
                </article>
              </div>
              {treasuryPlane.shared_with_trading ? (
                <div className="detail-note">
                  Treasury and trading currently share the same Polygon signer. Provision the modular treasury to split custody from execution and retire the legacy Circle donor path cleanly.
                </div>
              ) : null}
              <div className="detail-note">{tradingPlane.detail || 'Gateway unified balance materializes to Polygon when the swarm decides to trade.'}</div>
            </div>
            <div className="capital-subsection">
              <div className="capital-subhead">Risk Policy</div>
              <dl className="metric-list compact">
                <div className="metric-row"><dt>Treasury provision</dt><dd>{formatPolicyPct(capitalPolicy.treasury_provision_pct)}</dd></div>
                <div className="metric-row"><dt>Per position band</dt><dd>{formatPolicyPct(capitalPolicy.per_position_min_pct)}–{formatPolicyPct(capitalPolicy.per_position_max_pct)}</dd></div>
                <div className="metric-row"><dt>Min deploy</dt><dd>{formatUsd(capitalPolicy.per_position_min_usdc || 0)}</dd></div>
                <div className="metric-row"><dt>Max deploy</dt><dd>{formatUsd(capitalPolicy.per_position_max_usdc || 0)}</dd></div>
              </dl>
            </div>
            <div className="capital-subsection">
              <div className="capital-subhead">Chain Breakdown</div>
              <div className="wallet-domain-grid">
                {(domainRows.length ? domainRows : capitalDomains).map((item) => (
                  <article key={item.key || item.chain} className="wallet-domain-card">
                    <div className="wallet-domain-head">
                      <span>{item.label}</span>
                      <span className="wallet-domain-chip">{item.domain == null ? 'direct' : `d${item.domain}`}</span>
                    </div>
                    <div className="wallet-domain-balance">${formatMoney(item.balance_usdc ?? item.balance ?? 0)}</div>
                    <div className="wallet-domain-copy">{item.role} · {item.detail || 'enabled Gateway domain'}</div>
                  </article>
                ))}
              </div>
            </div>
            {(pendingCredits.length || opsStaging.length) ? (
              <div className="capital-subsection">
                <div className="capital-subhead">In flight</div>
                <ul className="capital-list">
                  {pendingCredits.map((item) => (
                    <li key={`${item.chain}-${item.estimatedAvailableAt}`} className="capital-item">
                      <div className="capital-item-head">
                        <span>{item.chain} finalizing</span>
                        <span>${formatMoney(item.amount)}</span>
                      </div>
                      <div className="capital-item-copy">
                        {item.status === 'finalizing' ? `ETA ${item.remainingSeconds}s` : 'should be available now'}
                      </div>
                    </li>
                  ))}
                  {opsStaging.map((item) => (
                    <li key={`${item.chain}-${item.walletAddress}`} className="capital-item">
                      <div className="capital-item-head">
                        <span>{item.chain} ops staging</span>
                        <span>${formatMoney(item.usdc)}</span>
                      </div>
                      <div className="capital-item-copy">{shorten(item.walletAddress, 16)} waiting to sweep back into the unified balance.</div>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="capital-subsection">
              <div className="capital-subhead">Action rail</div>
              <div className="wallet-action-rail">
                <button type="button" className="mini-btn" onClick={() => setActiveCapitalModal('deposit')}>Deposit</button>
                <button type="button" className="mini-btn" onClick={() => setActiveCapitalModal('send')}>Send</button>
                <button type="button" className="mini-btn" onClick={() => setActiveCapitalModal('bridge')}>Bridge</button>
                <button type="button" className="mini-btn" onClick={() => setActiveCapitalModal('swap')}>Swap</button>
                <button type="button" className="mini-btn" onClick={() => setActiveCapitalModal('treasury')}>Treasury Setup</button>
              </div>
            </div>
            <div className="capital-subsection">
              <div className="capital-subhead">Action Graph</div>
              <ul className="capital-list">
                {capitalActions.map((item) => (
                  <li key={item.key} className={`capital-item capital-action ${item.state === 'ready' ? 'is-ready' : 'is-blocked'}`}>
                    <div className="capital-item-head">
                      <span>{item.label}</span>
                      <span>{item.state}</span>
                    </div>
                    <div className="capital-item-copy">{item.detail}</div>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="rail-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">OPS</span>
                <span className="card-eyebrow">Operator Context</span>
              </div>
            </div>
            <div className="field-stack">
              <label className="field-label" htmlFor="tenant-select">Tenant</label>
              <select id="tenant-select" className="field-input" value={selectedTenant} onChange={(event) => setSelectedTenant(event.target.value)}>
                {tenantOptions.map((tenant) => <option key={tenant} value={tenant}>{tenant.toUpperCase()}</option>)}
              </select>
            </div>
            <dl className="metric-list compact">
              <div className="metric-row"><dt>Open positions</dt><dd>{visiblePositions.length}</dd></div>
              <div className="metric-row"><dt>Realized payout</dt><dd>{formatUsd(realizedPayout)}</dd></div>
              <div className="metric-row"><dt>USDC at risk</dt><dd>{formatUsd(usdcAtRisk)}</dd></div>
              <div className="metric-row"><dt>Kill switch</dt><dd>{operatorStatus.automation?.kill_switch_enabled ? 'enabled' : 'off'}</dd></div>
            </dl>
          </section>

          <section className="rail-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">SPN</span>
                <span className="card-eyebrow">Sponsor Readiness</span>
              </div>
              <span className="card-head-r">{readySponsorCount}/{sponsorRows.length || 0}</span>
            </div>
            <div className="scenario-copy">
              Build path: sponsors → encrypted balances → trading tools → OpenClaw → autonomous testnet operation.
            </div>
            <ul className="sponsor-list">
              {sponsorRows.map((item) => (
                <li key={item.key} className={`sponsor-item ${item.ready ? 'is-ready' : 'is-blocked'}`}>
                  <div className="sponsor-row">
                    <span className="sponsor-name">{item.label}</span>
                    <span className="sponsor-mode">{item.mode}</span>
                  </div>
                  <div className="sponsor-detail">{item.detail}</div>
                  {item.blocker ? <div className="sponsor-blocker">{item.blocker}</div> : null}
                </li>
              ))}
            </ul>
            <dl className="metric-list compact sponsor-metrics">
              <div className="metric-row"><dt>Burner seed</dt><dd>{walletReadiness.burner_seed_ready ? 'ready' : 'missing'}</dd></div>
              <div className="metric-row"><dt>Treasury key</dt><dd>{walletReadiness.treasury_key_ready ? 'ready' : 'missing'}</dd></div>
              <div className="metric-row"><dt>Poly key</dt><dd>{walletReadiness.polymarket_key_ready ? 'ready' : 'missing'}</dd></div>
              <div className="metric-row"><dt>0G key</dt><dd>{walletReadiness.zg_key_ready ? 'ready' : 'missing'}</dd></div>
              <div className="metric-row"><dt>Gateway bal</dt><dd>{gatewayTreasuryBalance != null ? formatUsd(gatewayTreasuryBalance) : 'unknown'}</dd></div>
            </dl>
            <ul className="blocker-list">
              {nextBlockers.slice(0, 4).map((item) => (
                <li key={item} className="blocker-item">{item}</li>
              ))}
            </ul>
          </section>

          <section className="rail-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">SIM</span>
                <span className="card-eyebrow">Gods-Eye Variables</span>
              </div>
            </div>
            <div className="scenario-copy">
              Inject world-state assumptions, rehearse futures, and search for the local optimum in complex group dynamics.
            </div>
            <div className="scenario-stack">
              {scenarioVariables.map((variable) => (
                <label key={variable.key} className="scenario-control">
                  <span className="scenario-head">
                    <span>{variable.label}</span>
                    <span>{worldState[variable.key]}</span>
                  </span>
                  <input
                    className="scenario-slider"
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={worldState[variable.key]}
                    onChange={(event) => setWorldState((current) => ({ ...current, [variable.key]: Number(event.target.value) }))}
                  />
                </label>
              ))}
            </div>
            <div className="scenario-foot">
              <span>swarm scale {swarmScaleLabel}</span>
              <span>{localOptimumLabel}</span>
            </div>
          </section>

          <section className="rail-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">LOG</span>
                <span className="card-eyebrow">Alerts</span>
              </div>
            </div>
            <ul className="alert-list">
              {alerts.length ? alerts.map((item) => (
                <li key={item.id} className={`alert-item ${item.tone}`}>
                  <span className="alert-time">{item.time}</span>
                  <span className="alert-text">{item.message}</span>
                </li>
              )) : <li className="alert-empty">No alerts yet.</li>}
            </ul>
          </section>

          <section className="rail-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">AUD</span>
                <span className="card-eyebrow">Audit Trail</span>
              </div>
            </div>
            {selectedPosition ? (
              <div className="audit-block">
                <div className="audit-title">{shorten(selectedPosition.position_id, 12)}</div>
                <button className="mini-btn" onClick={() => fetchAudit(selectedPosition.position_id)}>Refresh audit</button>
              </div>
            ) : null}
            <ul className="audit-list">
              {auditEvents.length ? auditEvents.map((event) => (
                <li key={`${event.ts}-${event.event}`} className="audit-item">
                  <span className="audit-event">{event.event}</span>
                  <span className="audit-status">{event.status}</span>
                </li>
              )) : <li className="audit-empty">{selectedPosition ? 'No audit events loaded.' : 'Select a position to inspect its timeline.'}</li>}
            </ul>
          </section>
        </aside>

        <section className="terminal-stage">
          <section className="stage-card hero-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 1</span>
                <span className="card-eyebrow">Alpha Board</span>
              </div>
              <span className="card-head-r">intel</span>
            </div>
            <div className="section-head">
              <div><h2 className="section-title">Classify the best opportunities, then act</h2></div>
              <div className="action-row">
                <button className="primary-btn" disabled={marketLoading} onClick={scanMarkets}>{marketLoading ? 'Scanning…' : 'Scan Universe'}</button>
                <button className="secondary-btn" disabled={classifyLoading} onClick={classifyUniverse}>{classifyLoading ? 'Classifying…' : 'Classify Top Markets'}</button>
                <button className="secondary-btn" disabled={!selectedMarket || signalLoading} onClick={runSelectedSignal}>{signalLoading ? 'Running…' : 'Run Swarm'}</button>
                <button className="secondary-btn" disabled={!selectedMarket || streamLoading} onClick={streamSelectedSignal}>{streamLoading ? 'Streaming…' : 'Live Debate'}</button>
              </div>
            </div>
            <div className="hero-copy">
              <p>
                Miroshark is the final operator app. Its swarm rehearsal engine converts graph-native analysis into ranked prediction market opportunities.
              </p>
              {bestOpportunity ? (
                <p className="hero-highlight">
                  Best live setup: <strong>{bestOpportunity.question}</strong>
                  <span>{formatPp(bestOpportunity.signal?.edge?.edge_pp || 0)} edge</span>
                  <span>{formatFloat(bestOpportunity.signal?.confidence || 0)} confidence</span>
                  <span>{localOptimumLabel}</span>
                </p>
              ) : null}
            </div>
            <div className="opportunity-grid">
              {rankedMarkets.length ? rankedMarkets.map((row) => (
                <button
                  key={row.market_id}
                  className={`opportunity-card ${row.market_id === selectedMarketId ? 'active' : ''}`}
                  onClick={() => setSelectedMarketId(row.market_id)}
                >
                  <div className="opportunity-head">
                    <span className="opportunity-rank">#{row.rank}</span>
                    <span className="opportunity-score">{row.score.toFixed(1)}</span>
                  </div>
                  <div className="opportunity-question">{row.question}</div>
                  <div className="opportunity-meta">
                    <span>{formatUsd(row.liquidity_usd)} liq</span>
                    <span>{formatUsd(row.volume_usd)} vol</span>
                    <span>{row.signal ? `${formatPp(row.signal.edge?.edge_pp || 0)} edge` : 'unclassified'}</span>
                    <span>{formatPp(row.scenarioBias || 0)} scenario</span>
                  </div>
                </button>
              )) : <div className="empty-card">Run `Scan Universe` to populate the board.</div>}
            </div>
          </section>

          <section className="stage-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 2</span>
                <span className="card-eyebrow">Selected Opportunity</span>
              </div>
              <span className="card-head-r">deliberation</span>
            </div>
            <div className="section-head narrow">
              <div><h3 className="section-title small">{selectedMarket?.question || 'No market selected'}</h3></div>
              <div className="field-inline">
                <label className="field-label" htmlFor="open-amount">USDC</label>
                <input id="open-amount" type="number" min="1" step="1" className="field-input small-input" value={openAmount} onChange={(event) => setOpenAmount(Number(event.target.value))} />
                <button className="primary-btn" disabled={!canOpenSelected} onClick={openSelectedPosition}>Open Position</button>
              </div>
            </div>
            <div className="verdict-grid">
              <div className="verdict-card">
                <div className="verdict-label">Verdict</div>
                <div className="verdict-main">{selectedSignal?.edge?.outcome || 'No verdict yet'}</div>
                <div className="verdict-meta">
                  <span>edge {formatPp(selectedSignal?.edge?.edge_pp || 0)}</span>
                  <span>conf {formatFloat(selectedSignal?.confidence || 0)}</span>
                  <span>phase {selectedSignal?.phase || 'idle'}</span>
                </div>
                <p className="verdict-copy">
                  {selectedSignal?.reasoning || 'Run the swarm to convert the selected market into an explicit investment thesis.'}
                </p>
              </div>
              <div className="factor-card">
                <div className="verdict-label">Key Factors</div>
                <ul className="factor-list">
                  {(selectedSignal?.key_factors || []).length
                    ? selectedSignal.key_factors.map((factor) => <li key={factor}>{factor}</li>)
                    : <li className="audit-empty">No factor list yet.</li>}
                </ul>
              </div>
            </div>
          </section>

          <section className="signal-instruments">
            <article className="instrument-card">
              <div className="instrument-head"><span className="card-eyebrow">E-01 Entropy</span><span className="instrument-sub">freeze detector</span></div>
              <div className="instrument-main">{entropyReading?.tier != null ? `Tier ${entropyReading.tier}` : 'No reading'}</div>
              <div className="instrument-meta">
                <span>H {formatFloat(entropyReading?.h_bits || 0)}</span>
                <span>{entropyReading?.z_score != null ? `z ${formatFloat(entropyReading.z_score)}` : 'cold start'}</span>
              </div>
            </article>
            <article className="instrument-card">
              <div className="instrument-head"><span className="card-eyebrow">C-02 Cryo</span><span className="instrument-sub">scanner</span></div>
              <div className="instrument-main">{cryoRows.length} frozen-market leads</div>
              <div className="instrument-meta"><span>{cryoRows[0] ? cryoRows[0].question || cryoRows[0].slug || 'top row ready' : 'scan pending'}</span></div>
            </article>
            <article className="instrument-card">
              <div className="instrument-head"><span className="card-eyebrow">T-03 Topology</span><span className="instrument-sub">graph risk</span></div>
              <div className="instrument-main">{topologyStats}</div>
              <div className="instrument-meta">
                <span>{topologyData?.stats?.tracked_tokens || 0} tracked tokens</span>
                <span>threshold {topologyData?.stats?.r_latch || 'n/a'}</span>
              </div>
            </article>
          </section>

          <section className="stage-card graph-stage-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 2B</span>
                <span className="card-eyebrow">Swarm Analysis</span>
              </div>
              <span className="card-head-r">swarm</span>
            </div>
            <div className="graph-stage-toolbar">
              <div className="graph-mode-row">
                {['live', 'project', 'simulation', 'graph'].map((mode) => (
                  <button
                    key={mode}
                    className={`mode-btn ${graphMode === mode ? 'active' : ''}`}
                    onClick={() => {
                      setGraphMode(mode)
                      setGraphError('')
                      setGraphResolvedLabel('')
                      if (mode === 'live') setContextGraphData(null)
                    }}
                  >
                    {mode === 'live' ? 'Live Opportunity' : mode === 'project' ? 'Project' : mode === 'simulation' ? 'Simulation' : 'Graph ID'}
                  </button>
                ))}
              </div>
              {graphMode !== 'live' ? (
                <div className="graph-source-inline">
                  <input
                    className="field-input graph-inline-input"
                    placeholder={graphSourcePlaceholder}
                    value={graphSourceValue}
                    onChange={(event) => setGraphSourceValue(event.target.value)}
                  />
                  <button className="secondary-btn" disabled={graphLoading || !graphSourceValue} onClick={loadContextGraph}>
                    {graphLoading ? 'Loading…' : 'Load Graph'}
                  </button>
                </div>
              ) : null}
            </div>
            <div className="graph-stage-summary">
              <div className="graph-summary-text">
                <h3 className="section-title small">Million-scale swarm rehearsal engine</h3>
                <p className="graph-caption">{graphStatusText}</p>
                <p className="graph-caption emphasis">This graph is the rehearsal engine for prediction market capital allocation.</p>
              </div>
            </div>
            <section className="graph-surface graph-surface-embedded">
              <GraphPanel
                graphData={activeGraphData}
                loading={graphMode === 'live' ? classifyLoading : graphLoading}
                currentPhase={3}
                isSimulating={streamLoading}
                onRefresh={refreshGraphSurface}
              />
            </section>
          </section>

          <section className="stage-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 3</span>
                <span className="card-eyebrow">Live Swarm Feed</span>
              </div>
              <span className="card-head-r">{streamStatus}</span>
            </div>
            <div className="section-head narrow">
              <div><h3 className="section-title small">Agent debate and operator guidance</h3></div>
            </div>
            <div className="feed-panel">
              {swarmFeed.length ? swarmFeed.map((item) => (
                <div key={item.id} className={`feed-item ${item.kind}`}>
                  <div className="feed-head">
                    <span className="feed-kind">{item.kind}</span>
                    <span className="feed-agent">{item.agent}</span>
                  </div>
                  <div className="feed-copy">{item.message}</div>
                </div>
              )) : <div className="empty-card">Start `Live Debate` to watch the swarm stream beliefs into the operator loop.</div>}
            </div>
          </section>

          <PortfolioPerformance
            positions={visiblePositions}
            treasury={treasuryPlane}
            trading={tradingPlane}
            balances={capitalBalances}
            pendingCreditBalance={pendingCreditBalance}
            opsStagingBalance={opsStagingBalance}
          />

          <section className="stage-card">
            <div className="card-head">
              <div className="card-head-l">
                <span className="act-chip">ACT 4</span>
                <span className="card-eyebrow">Positions</span>
              </div>
              <span className="card-head-r">{executionSummary}</span>
            </div>
            <div className="section-head narrow">
              <div><h3 className="section-title small">Execution and settlement inventory</h3></div>
              <button className="secondary-btn" onClick={fetchPositions}>Refresh positions</button>
            </div>
            <div className="execution-stack">
              {!activeVisiblePositions.length ? <div className="empty-card">No active positions. Open one from the verdict surface to watch funding, bridge, CLOB, resolve, and settle appear here.</div> : null}

              {activeVisiblePositions.map((position) => (
                <article key={position.position_id} className={`pos-card ${selectedPosition?.position_id === position.position_id ? 'is-active' : ''}`} onClick={() => setSelectedPositionId(position.position_id)}>
                  <div className="pos-h">
                    <div>
                      <span className="pos-id">{shorten(position.position_id, 12)}</span>
                      <span className="pos-meta">· {shorten(position.market_id, 14)} · {position.side} {formatUsd(position.usdc_amount)}</span>
                    </div>
                    <div className="pos-actions">
                      <span className={`badge ${statusBadgeClass(position.status)}`}>{position.status}</span>
                    </div>
                  </div>
                  <div className="pos-card-grid">
                    <div className="pos-facts">
                      <table>
                        <tbody>
                          <tr><td>strategy</td><td>{position.strategy}</td></tr>
                          <tr><td>burner</td><td>{shorten(position.burner_address || '—', 18)}</td></tr>
                          <tr><td>fund burner</td><td>{summarizeId(position.fund_tx)}</td></tr>
                          <tr><td>bridge send</td><td>{summarizeId(position.bridge_send_burn_tx)} · {summarizeId(position.bridge_send_mint_tx)}</td></tr>
                          <tr><td>clob order</td><td>{summarizeId(position.clob_order_id)}</td></tr>
                          <tr><td>gateway deposit</td><td>{summarizeId(position.gateway_deposit_tx)}</td></tr>
                          <tr><td>bridge recv</td><td>{summarizeId(position.bridge_recv_burn_tx)} · {summarizeId(position.bridge_recv_mint_tx)}</td></tr>
                          <tr><td>resolve</td><td>{summarizeId(position.resolve_tx)}</td></tr>
                          <tr><td>settle</td><td>{summarizeId(position.settle_tx)}</td></tr>
                          <tr><td>payout</td><td>{position.payout_usdc != null ? formatUsd(position.payout_usdc) : '—'}</td></tr>
                          {position.error ? <tr><td>error</td><td className="error-text">{position.error}</td></tr> : null}
                        </tbody>
                      </table>
                    </div>
                    <div className="timeline-wrap">
                      <div className="timeline-label">Proof-Of-Execution Timeline</div>
                      <div className="timeline">
                        {orderedAuditForPosition(position.position_id).length ? orderedAuditForPosition(position.position_id).map((event) => (
                          <div key={`${position.position_id}-${event.ts}-${event.event}`} className={`tl-event ${timelineClass(event)}`}>
                            <span className="ev">{event.event}</span>
                            <span className="when">{formatEventTime(event.ts)}</span>
                            {summarizeAuditPayload(event) ? <span className="pl">{summarizeAuditPayload(event)}</span> : null}
                          </div>
                        )) : <div className="tl-empty">no audit events yet</div>}
                      </div>
                    </div>
                  </div>
                </article>
              ))}

              <div className={`pos-history-h ${showHistory ? 'open' : ''}`} onClick={() => setShowHistory((value) => !value)}>
                <span className="chev">History</span>
                <span>{historicalVisiblePositions.length}</span>
              </div>
              <div className={`pos-history-body ${showHistory ? 'open' : ''}`}>
                {historicalVisiblePositions.map((position) => (
                  <article key={position.position_id} className="pos-card" onClick={() => setSelectedPositionId(position.position_id)}>
                    <div className="pos-h">
                      <div>
                        <span className="pos-id">{shorten(position.position_id, 12)}</span>
                        <span className="pos-meta">· {shorten(position.market_id, 14)} · {position.side} {formatUsd(position.usdc_amount)}</span>
                      </div>
                      <div className="pos-actions"><span className={`badge ${statusBadgeClass(position.status)}`}>{position.status}</span></div>
                    </div>
                    <div className="pos-card-grid">
                      <div className="pos-facts">
                        <table>
                          <tbody>
                            <tr><td>strategy</td><td>{position.strategy}</td></tr>
                            <tr><td>payout</td><td>{position.payout_usdc != null ? formatUsd(position.payout_usdc) : '—'}</td></tr>
                            <tr><td>resolve</td><td>{summarizeId(position.resolve_tx)}</td></tr>
                            <tr><td>settle</td><td>{summarizeId(position.settle_tx)}</td></tr>
                            {position.error ? <tr><td>error</td><td className="error-text">{position.error}</td></tr> : null}
                          </tbody>
                        </table>
                      </div>
                      <div className="timeline-wrap">
                        <div className="timeline-label">Proof-Of-Execution Timeline</div>
                        <div className="timeline">
                          {orderedAuditForPosition(position.position_id).length ? orderedAuditForPosition(position.position_id).map((event) => (
                            <div key={`${position.position_id}-${event.ts}-${event.event}`} className={`tl-event ${timelineClass(event)}`}>
                              <span className="ev">{event.event}</span>
                              <span className="when">{formatEventTime(event.ts)}</span>
                              {summarizeAuditPayload(event) ? <span className="pl">{summarizeAuditPayload(event)}</span> : null}
                            </div>
                          )) : <div className="tl-empty">no audit events yet</div>}
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
                {!historicalVisiblePositions.length ? <div className="empty-card">No settled or failed positions yet.</div> : null}
              </div>
            </div>
          </section>
        </section>
      </main>

      <WalletActionModals
        modal={activeCapitalModal}
        onClose={() => setActiveCapitalModal('')}
        capitalPlane={capitalPlane}
      />
    </div>
  )
}
