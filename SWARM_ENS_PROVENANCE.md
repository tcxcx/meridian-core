# Swarm × ENS provenance — should each agent get a subname?

> Honest analysis of "should each of the 21 swarm agents get its own ENS
> subname?" Recommendation: **per-RUN subnames, not per-agent.** Reasoning,
> tradeoffs, and a concrete cost model below.

## The question

We currently mint subnames at the *fund* level (`pinata-fund.miroshark.eth`
→ trading wallet). For each market the swarm runs (3 nodes × 7 agents × 2
gossip rounds = 21 agents producing belief tuples). Should each agent get
its own subname? Each run? Both?

The phrasing matters because the goalposts are different:
- **Performance** (faster swarm reasoning at hot path) — does ENS help?
- **Provenance** (auditors can verify what the swarm did) — does ENS help?
- **Composability** (other swarms / agents can reference ours) — does ENS help?
- **Discoverability** (third parties find our agents) — does ENS help?

## TL;DR

| Granularity | Helps performance | Helps provenance | Helps composability | Cost / 100 markets |
|---|---|---|---|---|
| Per-agent (`a-001.swarm.miroshark.eth`) | ❌ Slower (RPC hop) | ✓ But noisy | ✓ But unclear use | ~21 × 100 × 5 = 10,500 txs |
| Per-run (`run-{id}.swarm.miroshark.eth`) | ❌ Neutral | ✓ Strong (1 anchor per run, full data via 0G root) | ✓ Other swarms can resolve our run record | ~100 × 3 = 300 txs |
| Per-fund (current) | ❌ Neutral | ✓ Tenant identity only | ✓ Multi-tenant routing | one-time mint per fund |

**Verdict:** add per-RUN subnames (Phase 2 post-hackathon). Skip per-agent.

## Why per-agent is the wrong granularity

### Hot-path latency

Every swarm RUN today does:
- 21 agents × 1 LLM completion each = 21 inference calls
- 2 gossip rounds × 21 agents × peer endpoint POSTs = 42 mesh round-trips
- 1 aggregation step

Total wall-clock: ~8-15s on Sepolia (LLM-bound, not network-bound).

Adding per-agent ENS resolution would mean either:
- 21 × `getEnsAddress()` lookups per run = ~420ms additional latency at default mainnet RPC, ~3s at public Sepolia RPC under cold cache. **3% to 25% latency tax for zero swarm-quality benefit.**
- OR cache per-agent identity statically — at which point the ENS layer adds no information vs. an in-memory map (`AGENTS = { 'a-001': { persona, lens, runtime } }` — already exists in `services/swarm_runner/agent.py:_PERSONAS_CORE`).

### Storage / cost

Per-agent text records would carry `agent.persona`, `agent.lens`,
`agent.runtime`, `agent.score_history` (?). 5 records × 21 agents = 105
text-record txs **per swarm composition**. If we run 100 markets and the
agent pool is stable, that's a one-time setup cost — but if we evolve the
pool (new persona experiments), every retune means re-minting.

### Real auditability gain: marginal

An auditor doesn't ask "what's `a-001`?". They ask "what did the swarm
say about Will Fed Cut in March on 2026-05-03?" The answer lives at
*run* granularity, not agent granularity. Per-agent subnames dilute the
audit story.

## Why per-run IS the right granularity

### The pitch

After every swarm run, mint `run-{shortid}.swarm.miroshark.eth` pointing
to the consensus address (a sentinel, e.g. the agent that produced the
final result), with text records:

| Key | Value |
|---|---|
| `description` | `"Swarm run on Will Fed Cut in March · 21 agents · agreement 0.91 · NO 79% YES 21%"` |
| `miroshark.market` | `0x123…abc` (Polymarket condition_id) |
| `miroshark.consensus` | `NO:0.79` |
| `miroshark.zg_root` | `0xdef…789` (the 0G storage root that pins the full envelope) |
| `miroshark.agreement` | `0.91` |
| `miroshark.minority` | `null` (or the dissenter's reasoning hash) |
| `url` | `https://miro-shark.com/runs/{shortid}` |

**Anyone with the run subname** can resolve it, get the 0G root, fetch the
full simulation envelope (per-agent beliefs, reasoning, gossip log) from
0G Storage by merkle root, and verify the consensus matches what we
claimed. The ENS subname is the *root of provenance* — the 0G root is
the *body of provenance*. Together they're verifiable.

### Cost

- 100 markets/day × 4 text records each = ~400 txs/day on Sepolia
- At 0.0001 ETH/tx = 0.04 ETH/day
- Mainnet: ~$2/day at average gas

Reasonable for a serious public swarm; expensive for noise. **Mitigation: only
mint subnames for runs above a quality threshold** (e.g.,
`agreement_score ≥ 0.7 AND market_liquidity_usd ≥ $10k`). That cuts 100/day
to ~10/day.

### Performance impact at hot path

Mint happens AFTER consensus, off the swarm critical path. Zero added
latency to the swarm itself. Background worker handles the mint.

### Composability win

Another agent (e.g. our own Pinata trader, or a different platform) can:
1. Subscribe to `*.swarm.miroshark.eth` events on Sepolia (CCIP-Read or subgraph)
2. For each new run, resolve the text records → pull 0G envelope → consume the consensus
3. Trade based on it without ever calling our private API

That IS composability. ENS provides the discoverable, permissionless interface.

## The performance dimension nobody asked about

Could ENS subnames **make swarm reasoning more performant**?

Honest read: **no.** Swarm performance is a function of:
1. LLM inference latency (gpt-4o, ~2-4s per agent)
2. Gossip round-trip latency (mesh, ~50-200ms per peer hop)
3. Aggregation + diagnostic compute (~10ms)

ENS lookups touch none of those. Per-agent subnames would add latency,
not remove it. The "performance" framing in the prompt is a wrong-question
trap — the right question is "does ENS make the swarm more *useful*?"
And there: per-run yes, per-agent no.

## What about hybrid (per-agent for stable persona pool, per-run for outputs)?

Plausible. Concrete shape:

- **Static persona pool** (one-time mint, 13 personas across politics/finance/crypto/general/news): `geopolitical-analyst.swarm.miroshark.eth`, `vol-trader.swarm.miroshark.eth`, etc. Each carries `agent.persona`, `agent.runtime`, `agent.skills` text records.
- **Per-run output**: `run-{id}.swarm.miroshark.eth` text record `miroshark.composition` lists which personas participated (their ENS names, comma-separated).

Total cost: 13 persona subnames × 4 records = 52 setup txs (one-time, ~$1
on Sepolia), plus ~400 run-mint txs/day. Audit story: "this run was
produced by `geopolitical-analyst + macro + base-rate + …` per the
composition record."

This is the cleanest design. Persona stability is a feature (auditors learn
"vol-trader's track record"); per-run output gives the actual provenance
anchor.

## Recommendation

| Phase | Action | Why |
|---|---|---|
| Now (hackathon) | Skip swarm-ENS entirely | Per-fund subnames already cover the demo's ENS story |
| Post-hackathon Phase A | Mint static persona subnames (~13 names × 4 records, one-time) | Cheap; gives auditors per-persona track record |
| Post-hackathon Phase B | Background worker mints per-RUN subname when `agreement >= 0.7 && liquidity >= $10k` | Right granularity for provenance + composability |
| Never | Per-agent-instance subnames (`a-001`, `a-002`, …) | Wrong granularity; identity at the persona/role layer is more useful |

## Risks / open questions

1. **Subgraph cost.** Anyone wanting to subscribe to `*.swarm.miroshark.eth` needs a Sepolia ENS subgraph or to poll the registry. Minor friction.
2. **Subname ownership.** If the user-platform owns the parent (`miroshark.eth`), we control all subnames. Decentralization purists may object — could move to a contract that lets agents claim their own subnames trustlessly. Probably overkill for now.
3. **Mainnet vs Sepolia.** The whole discussion assumes Sepolia for cost reasons. Mainnet ENS for swarm-run provenance would cost real money — only makes sense if we're operating a real fund (~$2/day for 100 runs/day at base case).
4. **Privacy.** Encrypted size on Polymarket is a core MiroShark wedge. Per-run public ENS means the consensus + 0G root are public. That's *intentional* — the consensus is meant to be auditable; the *position size* is what stays private. No conflict, but worth being explicit.

## What this means for the lean canvas

If we ship Phase A (static persona subnames), the AGENT panel can show
each agent's persona link inline:
```
a-007  YES 32  NO 68   labor strong   ↗ vol-trader.swarm.miroshark.eth
```
That's a credible "Most Creative Use of ENS" wedge: per-persona track-record
provenance, where any third party can verify a persona's historical
calibration by walking its run subnames. Doesn't ship in the hackathon
window but is the right roadmap.
