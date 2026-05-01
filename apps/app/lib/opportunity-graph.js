function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function round(value, places = 2) {
  const factor = 10 ** places
  return Math.round((Number(value) || 0) * factor) / factor
}

function marketNarrativeWeights(question = '') {
  const text = String(question || '').toLowerCase()
  const has = (patterns) => patterns.some((pattern) => pattern.test(text))

  return {
    geopoliticalStress: has([/iran/, /hezbollah/, /strait of hormuz/, /war/, /regime/, /hostilit/]) ? 1 : 0,
    diplomaticBreakthrough: has([/ceasefire/, /peace/, /deal/, /agreement/, /diplomat/]) ? 1 : 0,
    energyDislocation: has([/oil/, /energy/, /gas/, /strait of hormuz/, /shipping/, /tariff/]) ? 1 : 0,
    cryptoMomentum: has([/bitcoin/, /\bbtc\b/, /ethereum/, /\beth\b/, /solana/, /crypto/, /token/]) ? 1 : 0,
    electionTurbulence: has([/election/, /vote/, /senate/, /assembly/, /president/, /congress/]) ? 1 : 0,
  }
}

function scenarioBiasForMarket(market, scenario = {}) {
  if (!market) return 0

  const weights = marketNarrativeWeights(market.question)
  const bias = Object.entries(weights).reduce((sum, [key, weight]) => {
    const shifted = (Number(scenario?.[key] ?? 50) - 50) / 50
    return sum + shifted * weight
  }, 0)

  return round(bias * 9, 2)
}

export function scoreOpportunity({ market, signal, entropy, scenario }) {
  if (!market) return 0

  const edge = Math.abs(signal?.edge?.edge_pp || 0)
  const confidence = Number(signal?.confidence || 0)
  const liquidity = Number(market.liquidity_usd || 0)
  const volume = Number(market.volume_usd || 0)

  const liquidityScore = clamp(Math.log10(liquidity + 1) / 7, 0, 1)
  const volumeScore = clamp(Math.log10(volume + 1) / 8, 0, 1)
  const entropyBias = entropy?.tier === 3 ? 1.15 : entropy?.tier === 2 ? 1.05 : entropy?.tier === 1 ? 0.95 : 1
  const scenarioBias = scenarioBiasForMarket(market, scenario)

  const raw = (((edge * 12) + (confidence * 55) + (liquidityScore * 18) + (volumeScore * 10)) * entropyBias) + scenarioBias
  return round(raw, 1)
}

export function buildOpportunityGraph({
  markets = [],
  selectedMarket = null,
  signals = {},
  selectedSignal = null,
  positions = [],
  topology = null,
  cryo = [],
  operator = null,
  tenantId = 'default',
  scenario = null,
}) {
  const nodes = []
  const edges = []
  const seenNodes = new Set()
  const capitalPlane = operator?.capital_plane || {}
  const treasury = capitalPlane?.treasury || {}
  const trading = capitalPlane?.trading || {}
  const policy = capitalPlane?.policy || {}

  const addNode = (uuid, name, labels, attributes = {}, summary = '') => {
    if (seenNodes.has(uuid)) return
    seenNodes.add(uuid)
    nodes.push({
      uuid,
      name,
      labels,
      attributes,
      summary,
      created_at: new Date().toISOString(),
    })
  }

  const addEdge = (uuid, source, target, name, factType, fact) => {
    edges.push({
      uuid,
      source_node_uuid: source,
      target_node_uuid: target,
      name,
      fact_type: factType,
      fact,
    })
  }

  addNode(
    'operator-core',
    'Operator Core',
    ['Entity', 'Operator'],
    {
      tenant: tenantId,
      mode: operator?.mode || 'manual',
      cadence_s: operator?.interval_s || 'n/a',
    },
    'Human and AI operator lane coordinating classification, alerts, and execution.',
  )
  addNode(
    'signal-gateway',
    'Signal Gateway',
    ['Entity', 'Signal'],
    {
      strategies: (operator?.strategies || []).join(', ') || 'directional',
      classification: 'scan + swarm',
    },
    'Scans the market universe and runs the swarm thesis engine.',
  )
  addNode(
    'swarm-engine',
    'Miroshark Swarm Graph',
    ['Entity', 'AgentSwarm'],
    {
      state: selectedSignal ? selectedSignal.phase : 'idle',
      confidence: selectedSignal?.confidence ?? 'n/a',
      scale: scenario?.swarmScaleLabel || 'million-scale',
    },
    'Persistent graph-native swarm analysis engine for prediction market opportunities.',
  )
  addNode(
    'scenario-engine',
    'Gods-Eye Scenario Layer',
    ['Entity', 'Catalyst'],
    {
      geopoliticalStress: scenario?.geopoliticalStress ?? 50,
      diplomaticBreakthrough: scenario?.diplomaticBreakthrough ?? 50,
      energyDislocation: scenario?.energyDislocation ?? 50,
      cryptoMomentum: scenario?.cryptoMomentum ?? 50,
      electionTurbulence: scenario?.electionTurbulence ?? 50,
    },
    'Inject world-state variables, rehearse futures, and search for local optima in group dynamics.',
  )
  addNode(
    'execution-router',
    'Execution Router',
    ['Entity', 'Execution'],
    {
      tenant: tenantId,
      positions: positions.length,
    },
    'Routes approved ideas into Gateway, KeeperHub, Polymarket, and settlement workflows.',
  )
  addNode(
    'treasury-vault',
    'Treasury Vault',
    ['Entity', 'Wallet'],
    {
      gateway_balance_usdc: treasury?.gateway_balance_usdc ?? 'n/a',
      passkey_ready: treasury?.passkey_ready ?? false,
      multisig_ready: treasury?.multisig_ready ?? false,
    },
    'Passkey-protected treasury and profit vault based on Circle modular wallets.',
  )
  addNode(
    'trading-wallet',
    'Gateway Trading Wallet',
    ['Entity', 'Wallet'],
    {
      chain: trading?.chain || 'Polygon Amoy',
      target_balance_usdc: trading?.target_balance_usdc ?? 'n/a',
      available_to_deploy_usdc: trading?.available_to_deploy_usdc ?? 'n/a',
    },
    'Unified Gateway USDC budget materialized onto Polygon Amoy for Polymarket execution.',
  )
  addNode(
    'keeperhub-ops',
    'KeeperHub',
    ['Entity', 'Execution'],
    {
      required: policy?.keeperhub_required ?? false,
    },
    'Executes agentic nanopayments and managed on-chain transactions for the operator.',
  )
  addNode(
    'openclaw-loop',
    'OpenClaw',
    ['Entity', 'Operator'],
    {
      required: policy?.openclaw_required ?? false,
    },
    'Runs the 24/7 operator loop that replenishes, executes, and sweeps profits.',
  )

  addEdge('core-scan', 'operator-core', 'signal-gateway', 'classifies', 'OPERATOR_CLASSIFICATION', 'Operator asks the signal stack to classify the live universe.')
  addEdge('scan-swarm', 'signal-gateway', 'swarm-engine', 'feeds', 'SWARM_INPUT', 'Market candidates are turned into Miroshark swarm analysis.')
  addEdge('swarm-exec', 'swarm-engine', 'execution-router', 'approves', 'EXECUTION_HANDOFF', 'High-conviction swarm ideas become execution candidates.')
  addEdge('scenario-swarm', 'scenario-engine', 'swarm-engine', 'perturbs', 'SCENARIO_INJECTION', 'World-state variables perturb the swarm before ranking opportunities.')
  addEdge('treasury-router', 'treasury-vault', 'execution-router', 'provisions', 'TREASURY_PROVISION', 'Treasury provisions the unified Gateway balance that funds deployment.')
  addEdge('router-trading', 'execution-router', 'trading-wallet', 'materializes', 'TRADING_BUDGET', 'Execution materializes spendable Gateway USDC on Polygon Amoy.')
  addEdge('router-keeperhub', 'execution-router', 'keeperhub-ops', 'routes through', 'MANAGED_EXECUTION', 'KeeperHub executes managed transfers and contract calls.')
  addEdge('openclaw-router', 'openclaw-loop', 'execution-router', 'automates', 'OPERATOR_AUTOMATION', 'OpenClaw keeps the replenishment and execution loop running.')
  addEdge('profits-home', 'execution-router', 'treasury-vault', 'sweeps', 'PROFIT_SWEEP', 'Resolved profits sweep back into the treasury vault.')

  const rankedMarkets = [...markets]
    .map((market) => ({
      market,
      signal: signals[market.market_id],
      score: scoreOpportunity({
        market,
        signal: signals[market.market_id],
        entropy: null,
        scenario,
      }),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)

  for (const entry of rankedMarkets) {
    const market = entry.market
    const signal = entry.signal
    const marketNodeId = `market:${market.market_id}`
    addNode(
      marketNodeId,
      market.question,
      ['Entity', 'Market'],
      {
        score: entry.score,
        liquidity_usd: round(market.liquidity_usd || 0),
        volume_usd: round(market.volume_usd || 0),
        scenario_bias: scenarioBiasForMarket(market, scenario),
      },
      'Ranked prediction market opportunity inside the unified operator terminal.',
    )
    addEdge(
      `scan-${market.market_id}`,
      'signal-gateway',
      marketNodeId,
      'discovers',
      'MARKET_SCAN',
      `Liquidity ${round(market.liquidity_usd || 0)} · volume ${round(market.volume_usd || 0)}`,
    )

    if (signal?.edge) {
      const verdictId = `verdict:${market.market_id}`
      addNode(
        verdictId,
        `${signal.edge.outcome} ${signal.edge.edge_pp >= 0 ? '+' : ''}${round(signal.edge.edge_pp)}pp`,
        ['Entity', 'Verdict'],
        {
          confidence: signal.confidence,
          outcome: signal.edge.outcome,
          edge_pp: round(signal.edge.edge_pp),
        },
        signal.reasoning || 'Swarm verdict generated from Miroshark analysis.',
      )
      addEdge(
        `signal-${market.market_id}`,
        marketNodeId,
        verdictId,
        'produces',
        'SWARM_VERDICT',
        `Confidence ${round(signal.confidence || 0, 2)}`,
      )
      addEdge(
        `verdict-exec-${market.market_id}`,
        verdictId,
        'execution-router',
        'queues',
        'EXECUTION_CANDIDATE',
        'Only the strongest classified opportunities should become positions.',
      )
      addEdge(
        `scenario-market:${market.market_id}`,
        'scenario-engine',
        marketNodeId,
        'tilts',
        'SCENARIO_TILT',
        `Scenario bias ${scenarioBiasForMarket(market, scenario)}`,
      )
    }
  }

  if (selectedMarket) {
    const marketNodeId = `market:${selectedMarket.market_id}`
    addNode(
      marketNodeId,
      selectedMarket.question,
      ['Entity', 'Market'],
      {
        selected: true,
        slug: selectedMarket.slug,
      },
      'The market currently under active operator review.',
    )

    if (selectedSignal?.key_factors?.length) {
      selectedSignal.key_factors.slice(0, 6).forEach((factor, index) => {
        const factorId = `factor:${selectedMarket.market_id}:${index}`
        addNode(
          factorId,
          factor,
          ['Entity', 'Catalyst'],
          { rank: index + 1 },
          'A key factor surfaced by the swarm while building the thesis.',
        )
        addEdge(
          `factor-edge:${selectedMarket.market_id}:${index}`,
          'swarm-engine',
          factorId,
          'argues',
          'SWARM_REASONING',
          'The swarm surfaced this factor while debating the trade.',
        )
        addEdge(
          `factor-market:${selectedMarket.market_id}:${index}`,
          factorId,
          marketNodeId,
          'supports',
          'THESIS_SUPPORT',
          'The factor influences the selected market.',
        )
      })
    }
  }

  positions.slice(0, 6).forEach((position) => {
    const positionId = `position:${position.position_id}`
    addNode(
      positionId,
      `${position.side} ${round(position.usdc_amount || 0)} USDC`,
      ['Entity', 'Position'],
      {
        status: position.status,
        strategy: position.strategy,
        payout_usdc: position.payout_usdc ?? 'n/a',
      },
      'Live or historical position created by the operator lane.',
    )
    addEdge(
      `position-router:${position.position_id}`,
      'execution-router',
      positionId,
      'settles via',
      'POSITION_ROUTE',
      `${position.status} · ${position.strategy}`,
    )
  })

  cryo.slice(0, 4).forEach((row, index) => {
    const cryoId = `cryo:${index}`
    addNode(
      cryoId,
      row.question || row.slug || `Cryo Lead ${index + 1}`,
      ['Entity', 'Instrument'],
      {
        detector: 'cryo',
        liquidity_usd: round(row.liquidity_usd || 0),
      },
      'Frozen-market lead surfaced by the cryo scanner.',
    )
    addEdge(
      `cryo-edge:${index}`,
      'signal-gateway',
      cryoId,
      'latches',
      'CRYO_SIGNAL',
      'Cryo scanner surfaced this lead for review.',
    )
  })

  const trackedTokens = topology?.stats?.tracked_tokens
  if (trackedTokens) {
    addNode(
      'topology-core',
      'Topology Mesh',
      ['Entity', 'Instrument'],
      {
        tracked_tokens: trackedTokens,
        clusters: topology?.clusters?.length || 0,
      },
      'Tracks cross-market topology risk and clustering.',
    )
    addEdge(
      'topology-signal',
      'topology-core',
      'signal-gateway',
      'feeds',
      'TOPOLOGY_RISK',
      'Topology risk informs classification and execution readiness.',
    )
  }

  return { nodes, edges }
}
