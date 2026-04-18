# swarm_runner — Phase 2 AXL multi-agent swarm

Spins up a local **3-node Gensyn AXL mesh**, runs N agents per node (each
agent = one OpenAI call + persona), and gossips beliefs peer-to-peer over
Yggdrasil. The aggregate belief is what `meridian_signal/swarm.py` returns
when `SWARM_BACKEND=axl`.

## Files

```
swarm_runner/
├── axl_client.py     stdlib wrapper for /topology, /send, /recv
├── agent.py          per-agent loop: forecast → broadcast → drain → refine
├── orchestrator.py   spawns N×3 agents in a thread pool, aggregates
├── nodes.py          supervisor for 3 axl/node processes
└── .runtime/         keys + node configs + logs (gitignored, regenerated each boot)
```

## Prereqs

1. **Build the AXL binary** at `external/axl/node`:
   ```bash
   cd external/axl  # cloned from gensyn-ai/axl
   make build
   ```
2. **Homebrew openssl** (LibreSSL ships on macOS and doesn't support `genpkey -algorithm ed25519`):
   ```bash
   brew install openssl
   ```
3. `LLM_API_KEY` in `meridian-core/.env`.

## Toggle the AXL backend

```bash
export SWARM_BACKEND=axl
export SWARM_AGENTS_PER_NODE=4   # default 5 — 3 nodes × 5 = 15 agents
export SWARM_ROUNDS=2            # default 2

cd meridian-core/services
uv run python -m meridian_signal.api  # gateway on :5002
```

Then `POST /api/signal/run { market_id }` returns the same shape as Phase 1
but with `phase: "2-axl-mesh (3-node, N beliefs)"` and `contributing_agents`
populated by `node-{a,b,c}/agent-{i}` IDs.

`SWARM_BACKEND=lite` (default) keeps Phase 1 single-LLM behavior.

## Smoke test the mesh alone

```bash
uv run python -m swarm_runner.nodes
# prints public keys for nodes a/b/c, runs until ctrl-c
```

## Smoke test a swarm against a synthetic market

```bash
uv run python -c "
from swarm_runner.orchestrator import run_axl_swarm
r = run_axl_swarm(
    seed_doc='Test market about X.',
    market_id='test',
    outcomes=['Yes','No'],
    agents_per_node=3, rounds=2,
)
print(r.consensus, r.confidence, len(r.contributing_agents))
"
```

## Network layout

| node | api  | listen | peers              | tcp_port |
|------|------|--------|--------------------|----------|
| a    | 9002 | 7100   | (hub)              | 7200     |
| b    | 9012 | —      | tls://127.0.0.1:7100 | 7200    |
| c    | 9022 | —      | tls://127.0.0.1:7100 | 7200    |

All nodes share `tcp_port=7200` — this is a **gvisor protocol port**, NOT a
per-node listener. Mismatched values cause `502: connect tcp [...]:N:
connection was refused` on cross-node `/send`. See `.context/meridian/sponsor-docs/axl.md`
for the full gotcha note.

## Belief schema (v1)

```json
{
  "proto": 1,
  "type": "belief",
  "market_id": "0x...",
  "outcomes": ["Yes", "No"],
  "probabilities": {"Yes": 0.1, "No": 0.9},
  "confidence": 0.8,
  "reasoning": "...",
  "agent_id": "node-a/agent-3",
  "node_id": "<axl-public-key-of-this-node>",
  "round": 2,
  "timestamp": 1.7e9
}
```

Sent as raw JSON bytes via `POST /send`. Received via `GET /recv`. Aggregation is
confidence-weighted average across all final-round beliefs from every agent.

## Demo evidence (Gensyn prize)

The bar Gensyn judges is "demonstrate communication across separate AXL nodes".
Two artefacts you can show live:

1. **Per-node logs** — `services/swarm_runner/.runtime/{a,b,c}/node.log` show
   `Connection from peer <key>` for each cross-node connection.
2. **Per-agent logs** — `meridian.swarm.agent` lines like
   `node-a/agent-0 round=2 ... peers_seen=8` prove the agent received beliefs
   from agents on other nodes (peers_seen counts non-self beliefs received).
3. **API response** — `contributing_agents` enumerates every `node-{a,b,c}/agent-{i}`
   that broadcast a final belief.

## Known caveats

- Each agent makes one OpenAI call per round, so 3 nodes × 5 agents × 2 rounds
  = 30 LLM calls per `/api/signal/run`. Budget accordingly.
- The Yggdrasil spanning tree takes ~3s after node start to fully converge;
  spokes may briefly see only the hub. Cross-node delivery still works because
  the hub forwards via the tree.
- The mesh is started + torn down on every `/api/signal/run` invocation (each
  request gets a fresh mesh). Phase 5 will keep it warm.
