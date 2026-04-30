export const demoGraphData = {
  nodes: [
    {
      uuid: 'tenant-a-burner',
      name: 'Tenant A Burner',
      labels: ['Entity', 'Wallet'],
      summary: 'Tenant-scoped burner wallet used for isolated position settlement.',
      attributes: { tenant: 'fund-a', chain: 'Arbitrum Sepolia', role: 'burner' },
      created_at: '2026-04-30T10:00:00Z'
    },
    {
      uuid: 'tenant-b-burner',
      name: 'Tenant B Burner',
      labels: ['Entity', 'Wallet'],
      summary: 'Second tenant burner proving query isolation and separate treasury flow.',
      attributes: { tenant: 'fund-b', chain: 'Arbitrum Sepolia', role: 'burner' },
      created_at: '2026-04-30T10:00:00Z'
    },
    {
      uuid: 'polymarket-scanner',
      name: 'Polymarket Scanner',
      labels: ['Entity', 'Signal'],
      summary: 'Ingests live Polygon market metadata and candidate opportunities.',
      attributes: { service: 'meridian_signal', mode: 'live markets' },
      created_at: '2026-04-30T10:01:00Z'
    },
    {
      uuid: 'belief-swarm',
      name: 'AXL Belief Swarm',
      labels: ['Entity', 'AgentSwarm'],
      summary: 'Multi-agent belief formation layer producing structured conviction.',
      attributes: { backend: 'axl|lite', agents: '3', output: 'belief deltas' },
      created_at: '2026-04-30T10:02:00Z'
    },
    {
      uuid: 'execution-router',
      name: 'Execution Router',
      labels: ['Entity', 'Execution'],
      summary: 'Coordinates burner derivation, bridge, CLOB submit, and settlement sidecars.',
      attributes: { service: 'execution_router', port: '5004' },
      created_at: '2026-04-30T10:03:00Z'
    },
    {
      uuid: 'cogito-sidecar',
      name: 'Cogito Sidecar',
      labels: ['Entity', 'Privacy'],
      summary: 'Wraps 0G compute, 0G storage, bridge kit, and FHE encryption utilities.',
      attributes: { service: 'cogito', port: '5003' },
      created_at: '2026-04-30T10:04:00Z'
    },
    {
      uuid: 'circle-gateway',
      name: 'Circle Gateway',
      labels: ['Entity', 'Bridge'],
      summary: 'Cross-chain treasury bridge for USDC movement into the settlement path.',
      attributes: { bridge: 'gateway', status: 'keyed-by-env' },
      created_at: '2026-04-30T10:05:00Z'
    },
    {
      uuid: 'settlement-hook',
      name: 'Private Settlement Hook',
      labels: ['Entity', 'Contract'],
      summary: 'Arbitrum Sepolia settlement contract enforcing the final private fill.',
      attributes: { network: 'Arbitrum Sepolia', type: 'Foundry deployable' },
      created_at: '2026-04-30T10:06:00Z'
    },
    {
      uuid: 'ops-dashboard',
      name: 'Operator Dashboard',
      labels: ['Entity', 'Dashboard'],
      summary: 'Live audit and SSE position surface exposed through the terminal tab.',
      attributes: { transport: 'SSE', audience: 'ops' },
      created_at: '2026-04-30T10:07:00Z'
    },
    {
      uuid: 'qa-lane',
      name: 'QA Lane',
      labels: ['Entity', 'Workflow'],
      summary: 'Synthetic QA flow used to verify graceful degradation and tenant filtering.',
      attributes: { mode: 'dry-run', purpose: 'hackathon QA' },
      created_at: '2026-04-30T10:08:00Z'
    }
  ],
  edges: [
    {
      uuid: 'e1',
      source_node_uuid: 'polymarket-scanner',
      target_node_uuid: 'belief-swarm',
      name: 'feeds',
      fact_type: 'SIGNAL_INPUT',
      fact: 'Market scan results become swarm prompts.'
    },
    {
      uuid: 'e2',
      source_node_uuid: 'belief-swarm',
      target_node_uuid: 'execution-router',
      name: 'emits conviction',
      fact_type: 'BELIEF_OUTPUT',
      fact: 'Structured beliefs are handed to execution.'
    },
    {
      uuid: 'e3',
      source_node_uuid: 'execution-router',
      target_node_uuid: 'tenant-a-burner',
      name: 'derives',
      fact_type: 'TENANT_WALLET',
      fact: 'Router deterministically derives Tenant A burner.'
    },
    {
      uuid: 'e4',
      source_node_uuid: 'execution-router',
      target_node_uuid: 'tenant-b-burner',
      name: 'derives',
      fact_type: 'TENANT_WALLET',
      fact: 'Router deterministically derives Tenant B burner.'
    },
    {
      uuid: 'e5',
      source_node_uuid: 'execution-router',
      target_node_uuid: 'cogito-sidecar',
      name: 'calls sidecar',
      fact_type: 'SIDECAR_RPC',
      fact: 'Execution requests encryption and auxiliary bridge helpers.'
    },
    {
      uuid: 'e6',
      source_node_uuid: 'execution-router',
      target_node_uuid: 'circle-gateway',
      name: 'bridges via',
      fact_type: 'TREASURY_BRIDGE',
      fact: 'Treasury bridge path for real testnet flow.'
    },
    {
      uuid: 'e7',
      source_node_uuid: 'circle-gateway',
      target_node_uuid: 'settlement-hook',
      name: 'funds',
      fact_type: 'SETTLEMENT_FUNDING',
      fact: 'Gateway-funded capital reaches the settlement hook.'
    },
    {
      uuid: 'e8',
      source_node_uuid: 'settlement-hook',
      target_node_uuid: 'tenant-a-burner',
      name: 'settles',
      fact_type: 'PRIVATE_FILL',
      fact: 'Private settlement finalizes Tenant A position.'
    },
    {
      uuid: 'e9',
      source_node_uuid: 'settlement-hook',
      target_node_uuid: 'tenant-b-burner',
      name: 'settles',
      fact_type: 'PRIVATE_FILL',
      fact: 'Private settlement finalizes Tenant B position.'
    },
    {
      uuid: 'e10',
      source_node_uuid: 'execution-router',
      target_node_uuid: 'ops-dashboard',
      name: 'streams',
      fact_type: 'SSE_STREAM',
      fact: 'Position deltas stream to the operator dashboard.'
    },
    {
      uuid: 'e11',
      source_node_uuid: 'qa-lane',
      target_node_uuid: 'execution-router',
      name: 'verifies',
      fact_type: 'QA_ASSERTION',
      fact: 'QA harness drives graceful-degradation checks.'
    },
    {
      uuid: 'e12',
      source_node_uuid: 'belief-swarm',
      target_node_uuid: 'qa-lane',
      name: 'replays',
      fact_type: 'QA_BELIEF_REPLAY',
      fact: 'Synthetic beliefs are replayed for QA scenarios.'
    }
  ]
}
