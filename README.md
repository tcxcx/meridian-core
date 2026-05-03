# MIROSHARK

> **Confidential autonomous prediction-market hedge fund.** Multi-agent LLM swarm scans Polymarket, ranks markets by edge × confidence, and trades through per-position burner EOAs whose treasury funding flow is encrypted with FHE on a Uniswap v4 hook.

Forked from [`666ghj/MiroFish`](https://github.com/666ghj/MiroFish). The original graph-analysis engine has been absorbed into `Miroshark`; the only app surface in this repo is the unified Next.js operator terminal.

---

## Pitch

Polymarket trades are public. Position sizes leak. Copy-traders front-run. A serious desk that believes in a market for non-trivial size cannot trade it without telegraphing exactly how much they believe. Miroshark fixes that: encrypted sizing on a Fhenix CoFHE Uniswap v4 hook, fresh per-position burner EOAs, Circle Gateway crosschain settlement, Polymarket CLOB execution, all coordinated by a Gensyn AXL swarm and pinned to 0G Storage with a daily verifiable PnL pack anyone can audit. **Multi-tenant out of the box** — fork the kit and run your own confidential fund on the same rails.

Full pitch: [`docs/PITCH.md`](./docs/PITCH.md). 3-minute demo script: [`docs/demo-script.md`](./docs/demo-script.md).

## Architecture

See [`docs/arch.svg`](./docs/arch.svg) (rendered) or [`docs/arch.html`](./docs/arch.html) (interactive). Swimlanes: Off-chain (Python) · cogito sidecar (TS/Bun) · On-chain (Arb Sepolia + Polygon Amoy).

---

## Quick start (judge mode — boots the demo in 4 commands)

```bash
# 1. install + provision env
bun install
cp .env.example .env.local        # then fill DATABASE_URL + TREASURY_PRIVATE_KEY + KEEPERHUB_API_KEY
cd services && uv sync && cd ..   # python deps incl. psycopg

# 2. boot all sidecars (separate terminals or use the Makefile target)
bun run dev --filter app          # Next.js operator terminal :3000
make services                     # signal-gateway :5002 + execution-router :5004 + cogito :5003

# 3. open the lean canvas
open http://localhost:3000

# 4. run a demo trade
#    Click any market in the MARKETS list → swarm auto-fires.
#    Click "Open ▸" → position lands, audit trail streams via SSE.
#    Refresh the page → state persists from Neon Postgres (positions + audit).
```

**Verifying sponsor integrations live:** see the *Verifiable demo* table in
[`SPONSORS.md`](./SPONSORS.md) — one row per sponsor with the exact command
to confirm it's wired and not stubbed.

## What persists where

The lean console is dual-source: real-time **SSE** for in-flight position
updates + **Neon Postgres** for boot/refresh state. Python services
dual-write through `services/_shared/db.py` on every state change, so the
operator terminal renders the full position history + audit trail + swarm
runs even after a service restart. Schema lives in `packages/database/index.js`
(`ensureTables`); read APIs at `apps/app/app/api/db/*`.

| Data | Real-time | Persisted |
|---|---|---|
| Positions | SSE `/execution/positions/stream` | `miroshark_position` |
| Audit timeline | SSE on each `position` event | `miroshark_audit_event` |
| Swarm runs | SSE `/signal/runs/stream` | `miroshark_swarm_run` |
| Treasury transfers (multisig) | header polls every 5s | `miroshark_treasury_transfer` |

---

## Sponsor tracks — direct links for judging

One block per sponsor. Each block has the **angle** (what's interesting),
the **code** (every file that does real work), the **UI** (where to see it
live in the operator terminal), and a **verify** command (one shell command
that proves the integration is real, not stubbed). Full depth-of-integration
breakdown in [`SPONSORS.md`](./SPONSORS.md).

### 🦄 Uniswap Foundation — Best Uniswap API integration

**Angle.** Position size on Polymarket leaks. A serious desk that takes
real size telegraphs exactly how much they believe. Uniswap v4's hook
extensibility is the privacy primitive: `PrivateSettlementHook` accepts
FHE-encrypted `InEuint128` inputs, mints `fhUSDC` (`HybridFHERC20`) for
per-position burner EOAs, and the hook operator never sees the size.

- **Hook contract:** [`contracts/src/PrivateSettlementHook.sol`](./contracts/src/PrivateSettlementHook.sol)
- **fhUSDC token:** [`contracts/src/HybridFHERC20.sol`](./contracts/src/HybridFHERC20.sol)
- **Tests (Foundry):** [`contracts/test/PrivateSettlementHook.t.sol`](./contracts/test/PrivateSettlementHook.t.sol) + [`contracts/test/HybridFHERC20.t.sol`](./contracts/test/HybridFHERC20.t.sol)
- **Python caller:** [`services/execution_router/hook_client.py`](./services/execution_router/hook_client.py) — `fundBurner`, `markResolved`, `settle`
- **UI:** Treasury popover (chain breakdown row showing Arb Sepolia hook deployment), Position card timeline events `fund_burner.ok` / `settle.ok`
- **Verify:** `cd contracts && forge test -vvv` → 38/38 hook tests pass

### 🔐 Fhenix CoFHE — encrypted size on the v4 hook

**Angle.** Fhenix CoFHE is the *primitive* under the Uniswap surface. The
Solidity hook accepts `InEuint128` sealed inputs; cofhejs server-side
mints them; the chain stores `euint128` deltas. The treasury knows the
size, the agent knows the size, the hook operator sees only ciphertext.

- **cogito FHE endpoint:** [`services/cogito/src/fhe.ts`](./services/cogito/src/fhe.ts) — POST `/fhe/encrypt`
- **Python sealed-input parser:** [`services/execution_router/encryptor.py`](./services/execution_router/encryptor.py) — `SealedInput` maps cogito JSON → Solidity `InEuint128` tuple
- **Hook consumer:** `PrivateSettlementHook.fundBurner(InEuint128 sealed)` (linked above)
- **Honest demo gate:** `DEMO_REQUIRE_REAL=1` blocks `DryRunEncryptor` so demo failures surface instead of silently passing — see [`services/execution_router/api.py`](./services/execution_router/api.py) `_check_demo_real_blockers()`
- **UI:** Position card timeline shows `fund_burner.ok` with `tx_hash`; the size in the DB is the post-decryption recorded amount (operator sees plaintext, chain sees ciphertext)
- **Verify:** with `COGITO_BASE_URL` + `COGITO_TOKEN` set, `curl localhost:5003/fhe/encrypt -X POST -d '{"value":"100000000"}'` returns a valid `InEuint128` JSON envelope

### 🤖 0G — Best Agent Framework + Best Autonomous Agents/Swarms

**Angle.** Two surfaces: 0G **Storage** pins every swarm artifact (seed
doc + simulation envelope) by merkle root so a third party can resolve
the run after the fact; 0G **Compute** runs TeeML-verifiable LLM inference
that the swarm consumes when `LLM_PROVIDER=0g`. Plus the swarm itself
(21 agents, 3 nodes, 2 gossip rounds, disagreement-aware aggregation,
Tetlock superforecaster prompt) is the framework-level work.

- **Storage client:** [`services/cogito/src/zg.ts`](./services/cogito/src/zg.ts) — Indexer.upload + MerkleTree, root-tx-anchored on Galileo
- **Compute client:** [`services/cogito/src/compute.ts`](./services/cogito/src/compute.ts) — TeeML inference adapter
- **Chain config + helpers:** [`packages/zero-g/index.js`](./packages/zero-g/index.js)
- **Swarm runner (framework-level):** [`services/swarm_runner/orchestrator.py`](./services/swarm_runner/orchestrator.py) + [`services/swarm_runner/agent.py`](./services/swarm_runner/agent.py) (Tetlock prompt at `_SUPERFORECASTER_SYS`)
- **Multi-node mesh:** [`services/swarm_runner/nodes.py`](./services/swarm_runner/nodes.py) + [`services/swarm_runner/axl_client.py`](./services/swarm_runner/axl_client.py)
- **DB persistence (every run pinned):** column `zg_root` in [`miroshark_swarm_run`](./packages/database/index.js)
- **UI:** Header `● 0G` health dot (turns amber when signer balance < 0.01 OG); SELECTED MARKET region's swarm graph + DEBATE feed are live SSE from this runner
- **Verify (storage):** `psql $DATABASE_URL -c "SELECT zg_root, market_id, ts FROM miroshark_swarm_run WHERE zg_root IS NOT NULL ORDER BY ts DESC LIMIT 1"` → resolve the root via [Galileo explorer](https://chainscan-galileo.0g.ai)
- **Verify (swarm):** `SWARM_BACKEND=axl python -m services.swarm_runner.test_cross_node` → 3-node spawn + gossip log

### 💚 KeeperHub — Best Use of KeeperHub

**Angle.** Every on-chain tx the router sends (hook funding, hook resolve,
hook settle, treasury bridge sends) routes through KeeperHub Direct
Execution when `KEEPERHUB_API_KEY` is set — managed gas, retries, nonce
coordination, `executionId` per tx. Falls back to direct web3 sends in
dev / dry-run.

- **Client:** [`services/execution_router/keeperhub.py`](./services/execution_router/keeperhub.py) (~200 LoC)
- **Wired into:** [`services/execution_router/hook_client.py`](./services/execution_router/hook_client.py) (3 hook txs) + [`services/execution_router/capital.py`](./services/execution_router/capital.py) (treasury bridge sends)
- **Smoke tests:** [`services/execution_router/scripts/smoke_keeperhub.py`](./services/execution_router/scripts/smoke_keeperhub.py) + [`sponsor_smoke_full.py`](./services/execution_router/scripts/sponsor_smoke_full.py)
- **Audit:** every successful KeeperHub call writes `execution_id` into the audit payload — surfaces in DB column `miroshark_audit_event.payload->>'execution_id'`
- **UI:** Position card timeline rows show `keeper {execution_id}` for every routed tx
- **Builder feedback ([`FEEDBACK.md`](./FEEDBACK.md)):** 11 specific items across docs gaps, reproducible bugs, feature requests, and UX friction — eligible for the KeeperHub Builder Feedback Bounty
- **Verify:** `KEEPERHUB_API_KEY=… python services/execution_router/scripts/smoke_keeperhub.py` → returns `executionId` + tx hash

### 🌐 ENS — Best ENS Integration for AI Agents · Most Creative Use

**Angle.** Autonomous agents need persistent, human-readable identity. The
Pinata trader (`xt1sgi73`) signs every position with the same EOA — without
ENS that's an opaque address in the audit log. With ENS it's
`xt1sgi73.miroshark.eth` whose text records carry `agent.skills` (mirrors
the AGENT panel: probe · swarm · open · settle), `agent.template`, `org.telegram`,
`description`. Tenant subnames route too: `fund-a.miroshark.eth` →
FUND-A trading wallet. **Most-creative angle:** ENS as multi-tenant
routing key + per-position audit trail (subnames per settled position
carry market_id, outcome, payout, settle_tx in text records).

- **Resolver package:** [`packages/ens/index.js`](./packages/ens/index.js) — viem-based `resolveEnsAddress`, `reverseResolve`, `getTextRecords`, `resolveIdentity`, plus convention helpers `agentEnsName(id)` and `tenantEnsName(id)`
- **API route (cached):** [`apps/app/app/api/ens/resolve/route.js`](./apps/app/app/api/ens/resolve/route.js) — 5-min in-memory TTL
- **UI component:** [`apps/app/components/miroshark/ens-name.jsx`](./apps/app/components/miroshark/ens-name.jsx) — client-cached, hover tooltip shows full address + text records
- **Wired into:** [`apps/app/components/miroshark/agent-panel.jsx`](./apps/app/components/miroshark/agent-panel.jsx) (AGENT panel header) + [`operator-terminal.jsx`](./apps/app/components/miroshark/operator-terminal.jsx) (Treasury + Agent wallet popover Address rows)
- **Sepolia subname registration scripts:** [`apps/app/scripts/ens/check.mjs`](./apps/app/scripts/ens/check.mjs) (read-only preflight) + [`apps/app/scripts/ens/register.mjs`](./apps/app/scripts/ens/register.mjs) (idempotent mint of `xt1sgi73`, `fund-a`, `fund-b` subnames + text records under the configured parent)
- **UI:** open the lean canvas → click Treasury ▾ or Agent ▾ → the Address row resolves any registered `.eth` to its name; hover for tooltip
- **Env:** `ENS_NETWORK=mainnet|sepolia`, `MAINNET_RPC_URL`, `SEPOLIA_RPC_URL`, `MIROSHARK_AGENT_ENS`, `MIROSHARK_TENANT_ENS_<TENANT_UPPER>`, `MIROSHARK_PARENT_ENS_NAME`, `ENS_REGISTRAR_PRIVATE_KEY` (or fallback to `TREASURY_PRIVATE_KEY`)
- **Verify (mainnet, no setup):** `curl 'http://localhost:3000/api/ens/resolve?name=vitalik.eth'` → returns address + text records — proves the resolver is real, not stubbed
- **Verify (sepolia, after registration):** `node apps/app/scripts/ens/check.mjs` → prints owner of `<parent>` + state of each subname

**Dynamic fund creation (the headline demo path) — `+ Add fund` button:**

The operator terminal has a `+ Add fund` button inside the **Agent ▾**
popover. Click it, give the fund a name (e.g. *"Pinata Macro Fund"*), and
optionally an ENS alias. The dialog atomically:

1. Inserts a `miroshark_fund` row in Neon (status: provisioning)
2. Derives a deterministic trading-wallet address from `BURNER_SEED`
3. Mints the ENS subname `<slug>.miroshark.eth` on Sepolia (setSubnodeRecord)
4. Sets the address record on the resolver (setAddr)
5. Sets text records: `miroshark.tenant`, `miroshark.role`, `agent.skills`, `org.telegram`, `description`
6. Marks the fund row active

The dialog streams each step's tx hash live so judges can click into Etherscan
mid-provisioning. Idempotent — failures are recoverable; re-clicking the
same fund name resumes from where it left off.

The same flow runs during onboarding: at the **Treasury** setup step, after
the treasury wallet is provisioned, an inline "Provision first fund" callout
opens the same dialog — so a brand-new user reaches the operator terminal
with their first fund (and its ENS subname) already minted.

**Power-user Sepolia subname runbook (CLI fallback, mostly for redeploys):**

```bash
# 1. Faucet Sepolia ETH for the registrar signer (TREASURY_PRIVATE_KEY by default).
node apps/app/scripts/ens/check.mjs
#    → faucet at https://sepoliafaucet.com or https://www.alchemy.com/faucets/ethereum-sepolia

# 2. Register the parent name on Sepolia (one-time, automated commit-reveal).
node apps/app/scripts/ens/register-parent.mjs --dry-run   # preview
node apps/app/scripts/ens/register-parent.mjs             # ~90s, ~0.003 ETH

# 3. Mint the static MiroShark subnames (xt1sgi73, fund-a, fund-b).
node apps/app/scripts/ens/register.mjs --dry-run
node apps/app/scripts/ens/register.mjs
# Each subname costs ~0.0001 ETH in gas; idempotent across runs.

# 4. Surface in the operator terminal:
#    Add to apps/app/.env.local:
#      ENS_NETWORK=sepolia
#      MIROSHARK_AGENT_ENS=xt1sgi73.miroshark.eth
#      MIROSHARK_TENANT_ENS_FUND_A=fund-a.miroshark.eth
```

### 🧠 Gensyn AXL — Best Autonomous Agents (bonus track)

**Angle.** 3-node Yggdrasil-routed mesh, 7 agents per node, 2 gossip
rounds. Each agent runs the same Tetlock superforecaster prompt with a
persona lens routed by market category (politics / finance / crypto /
news / general). After round 1 agents gossip beliefs over `/recv` peer
endpoints; round 2 re-grounds with the consensus context. Aggregation
uses pairwise L1 distance for `agreement_score` + soft-cap on confidence
when the swarm splits.

- **Orchestrator:** [`services/swarm_runner/orchestrator.py`](./services/swarm_runner/orchestrator.py) — `run_axl_swarm()` + `stream_axl_swarm()`
- **Agent (prompt + persona pool):** [`services/swarm_runner/agent.py`](./services/swarm_runner/agent.py)
- **Mesh wiring:** [`services/swarm_runner/nodes.py`](./services/swarm_runner/nodes.py) + [`services/swarm_runner/axl_client.py`](./services/swarm_runner/axl_client.py)
- **Cross-node test:** [`services/swarm_runner/test_cross_node.py`](./services/swarm_runner/test_cross_node.py)
- **Toggle:** `SWARM_BACKEND=axl` (vs `single` for one-shot fallback)
- **UI:** SELECTED MARKET region's DEBATE feed shows the live SSE per-agent belief stream; `agreement_score` + `minority_report` render in the verdict row + dissent panel
- **Verify:** `SWARM_BACKEND=axl python -m services.swarm_runner.test_cross_node`

### 🍍 Pinata Cloud — autonomous AI operator

**Angle.** Pinata Cloud hosts the autonomous agent (`xt1sgi73`,
"Polymarket Trader" template) paired with `@miro_shark_bot` Telegram. The
agent reaches back over a Cloudflare Tunnel + `MIROSHARK_AGENT_TOKEN`
bearer auth, calls the same MiroShark verbs the human operator uses
(probe · swarm · open · settle), and the AGENT panel inside the operator
terminal shows the agent's live `runState` + decision + skills + last 2
audit events.

- **Workspace overlay (the agent's brain):** [`apps/app/scripts/pinata-agent-overlay/`](./apps/app/scripts/pinata-agent-overlay/) — MIROSHARK.md, skills/miroshark.md, AGENTS.md, SOUL.md, TOOLS.md, USER.md, manifest.json
- **Idempotent redeploy script:** [`apps/app/scripts/redeploy-pinata-agent.sh`](./apps/app/scripts/redeploy-pinata-agent.sh)
- **Connector status API (Next.js):** [`apps/app/app/api/pinata/status/route.js`](./apps/app/app/api/pinata/status/route.js)
- **AGENT panel (cohesion surface):** [`apps/app/components/miroshark/agent-panel.jsx`](./apps/app/components/miroshark/agent-panel.jsx) — derives the agent's *would-do* decision from the same `edge × confidence` thresholds the agent itself uses
- **UI:** Top-right Agent ▾ popover → `Autonomous ● running [Pause]` toggle + `Chat` + `Telegram` quick links; AGENT panel inside selected-market region
- **Verify:** Telegram `@miro_shark_bot` → `/status` → response from xt1sgi73 calling `GET /api/execution/operator/status` over the bearer-authed tunnel

## Chain topology

| Role | Chain | Why |
|---|---|---|
| **Settlement** — fhUSDC + `PrivateSettlementHook` + treasury custody | Arbitrum Sepolia (chainId `421614`, CCTP domain `3`) | Fhenix CoFHE testnet coverage; cheaper/faster than Eth Sepolia. |
| **Trading** — Polymarket CLOB + per-position burner EOAs | Polygon PoS Amoy (chainId `80002`, CCTP domain `7`) | Polymarket has always been Polygon-native (EOA flow, no deploy). |
| **Cross-chain** | Circle **Bridge Kit** (CCTP V2) — NOT Gateway. Gateway testnet doesn't cover either chain. | See [`LESSONS.md`](./LESSONS.md). |

## Position lifecycle

**`/open`:**
1. Derive burner EOA: `keccak(BURNER_SEED ‖ position_id)`.
2. `fundBurner(InEuint128 amount, address burner)` on Arb Sepolia hook (real cofhejs sealed input via `cogito /fhe/encrypt`).
3. Bridge USDC treasury (Arb Sepolia) → burner (Polygon Amoy) via Bridge Kit forwarder.
4. Submit Polymarket CLOB order signed by the burner key.

**`/resolve`:**
1. Bridge proceeds burner (Polygon Amoy) → treasury (Arb Sepolia).
2. `markResolved(position_id, payout)` encrypted on the hook.
3. `settle(position_id)` — encrypted credit to treasury.

The privacy property: an on-chain observer sees one anonymous burner EOA per position, no link back to the treasury, and the funding amount as an `euint128` handle. **The fund's positions are public; its capital allocation is private.**

---

## Swarm intelligence

Each market goes through a Gensyn AXL multi-agent mesh — by default 21 agents
across 3 nodes, gossiping beliefs over 2 rounds. Phase 6 rebuilt the
intelligence stack on top of patterns from the official `polymarket/agents`
framework. The result: agents that reason ABOUT Polymarket microstructure
instead of forecasting blind on prices alone.

### Tetlock superforecaster methodology

Every agent runs this **silently** before producing its probability output —
borrowed verbatim from Phil Tetlock's [Superforecasting](https://en.wikipedia.org/wiki/Superforecasting)
research and adapted from the `polymarket/agents` framework
(`prompts.py:112-144`). It's the system prompt for every agent in the swarm:

> 1. **Decompose**: break the question into 2-3 sub-questions whose joint
>    probability gives the answer.
>
> 2. **Base-rate**: anchor on the historical frequency of similar events.
>    Reference class > intuition.
>
> 3. **Inside view**: list 2-3 case-specific factors that move probability
>    up or down. Quantify each.
>
> 4. **Update on signals**: read the order-book microstructure section in
>    the seed_doc.
>    - Spread > 100 bps OR entropy tier 2 (deep freeze) → discount your edge
>      by ≥50%; the price is probably stale or whale-parked, not consensus.
>    - Tier 1 (frozen) → soft penalty (−0.1 confidence). Tier 0 (active) →
>      no adjustment.
>    - Cryo anomaly (sudden freeze) → either someone knows something (small
>      size, fast exit) or manipulation (pass). Either way, lower confidence.
>    - Correlated markets section → if you see correlated markets you don't
>      already hold, your trade is uncrowded; if the fund holds correlated
>      positions, treat as duplicate-bet (lower confidence).
>
> 5. **Probabilistic output**: express probabilities, never certainties.
>    Calibration matters more than directional accuracy.

This isn't a marketing claim — it's the actual prompt at
`services/swarm_runner/agent.py:152` (`_SUPERFORECASTER_SYS`). The decomposition
+ base-rate + signal-driven adjustments structure is what separates
"21 LLMs guessing" from "21 disciplined forecasters."

### Polymarket-specific signal injection

Pre-Phase-6, agents saw `{question, outcomes, market_prices, description}`.
Phase 6 bakes in every Polymarket signal MiroShark already computes:

| Section in `seed_doc` | Source | What the agent does with it |
|---|---|---|
| **Order-book microstructure (E-01)** | `entropy.read(token_id)` per outcome — spread, depth, tier 0/1/2, H bits | Adjusts confidence per the rules above; e.g. tier 2 → halve the edge before recommending |
| **Correlated markets (T-03)** | `topology.correlated_with(token_id)` — Pearson r ≥ 0.70 | Flags duplicate-bet risk; sizes down if fund already holds correlated positions |
| **Cryo anomaly (C-02)** | `cryo.scan()` — entropy z-score < -1.5 | Treats as small-size + fast-exit territory (insider news or manipulation, either way risky) |
| **Resolution criteria** | `market.description` (verbatim) | Required reading; loophole-finding personas trigger here |

### Persona specialization by market category

`agent.py:_detect_market_category` runs cheap keyword classification
(politics / finance / crypto / general) on the seed_doc. The persona pool
adapts:

| Category | Specialist personas added on top of the 5 core lenses |
|---|---|
| Politics | `geopolitical-analyst`, `political-historian`, `policy-wonk` |
| Finance  | `momentum`, `vol-trader`, `macro` |
| Crypto   | `on-chain`, `narrative` |
| General  | (core lenses only — contrarian-quant, base-rate, microstructure, bayesian, value, news-driven) |

Each agent gets a distinct lens until the pool wraps. A politics market sees
~9 distinct frames; 3 of them are genuinely specialised vs the generic flat
rotation that pre-Phase-6 had.

### Disagreement-aware aggregation

Naive confidence-weighted averaging makes a 50-50 split swarm look as
confident as a unanimous one. Phase 6 fixes this:

- **`agreement_score`** (0..1): `1.0` unanimous → `0.0` maximum spread.
  Computed as `1 - mean_pairwise_L1_distance / 2`.
- **`confidence`** = `raw_confidence * max(0.5, 1 - 0.5 * (disagreement -
  0.30) / 0.70)` when disagreement > 0.30. Split swarms cap at half their raw
  confidence.
- **`raw_confidence`** also exposed so callers can see what the penalty cost.
- **`minority_report`** — the strongest confident dissenter when L1 distance
  from consensus ≥ 0.20 AND their stated confidence ≥ 0.5. Returned as
  `{agent_id, confidence, probabilities, distance_from_consensus, reasoning}`
  so the operator (or the Pinata agent) can see "even though we say YES,
  agent X bet NO with confidence 0.72 — here's why" without scrolling raw
  beliefs.

All four fields ship in the `/api/signal/run` response.

### Roadmap (next swarm enhancements)

In ROI order, what bumps the swarm from "much better" to "true alpha":

1. **News + social signal injection** — sub-agent fetches last 24h headlines for the market's named entities, summarizes into a "what changed" block. Largest single-step quality lift.
2. **Whale position tracking** — Polymarket positions are public on-chain; pull top-20 holders + 24h deltas, surface in seed_doc as W-04 section.
3. **Calibration tracking** — log every belief vs eventual market resolution; re-weight aggregation by per-persona Brier score after N markets. Compounding edge.
4. **Multi-LLM diversity** — currently all 21 agents call the same model. Half on Claude, half on GPT, sprinkle Gemini. Different priors → better consensus when they agree.
5. **Tool use (function calling)** — let agents call `fetch_news`, `lookup_resolved_markets`, `compare_to_kalshi` mid-reasoning instead of working from a static seed_doc.
6. **Adversarial / red-team agent** — dedicated devil's advocate that always populates `minority_report` even when the swarm is naturally aligned.
7. **Cross-platform arbitrage agent** — Kalshi runs the same political markets; spread between Kalshi and Polymarket on the literal same question is alpha.

---

## Autonomous operator (Pinata Cloud)

The 24/7 operator surface — the thing OpenClaw was meant to be — runs as a
hosted Pinata Cloud agent customised against MiroShark.

| Layer | Where it lives |
|---|---|
| Agent runtime | `xt1sgi73.agents.pinata.cloud` (Pinata Cloud, hosted OpenClaw container) |
| Agent template | Forked from `polymarket/agents` — "MoonPay Prediction Market Trader" |
| Operator chat | Two surfaces, same backend: Telegram bot `@miro_shark_bot` + embedded chat panel in the operator terminal |
| MiroShark workspace overlay | `apps/app/scripts/pinata-agent-overlay/` — the canonical edits we layer on top of any fresh deploy |
| Reach-back | Cloudflare Tunnel on `miro-shark.com` — `execution.`, `signal.`, `cogito.` subdomains route to the local services |
| Auth | `MIROSHARK_AGENT_TOKEN` (env-gated, additive — local dev unchanged when unset) |

The agent's workspace contains a custom briefing (`MIROSHARK.md`) explaining
the privacy rail, the chain topology, and the position lifecycle. A custom
skill (`skills/miroshark.md`) is its endpoint cookbook with curl examples for
every MiroShark API + the Phase 6 swarm response shape (agreement_score,
minority_report). `SOUL.md` and `TOOLS.md` mark
`mp prediction-market position buy/sell/redeem` as **deprecated** for this
workspace — execution always routes through `POST
$MIROSHARK_EXECUTION_URL/api/execution/open` so the privacy rail (encrypted
size + per-position burner + Circle Gateway bridge) actually fires.

**Why this beats building OpenClaw ourselves**: zero ops burden, paired
Telegram channel comes free from Pinata's channels system, marketplace listing
post-hackathon. Trade-off is paid Pinata plan + hosting lock-in.

**Demo-mode gate** (`DEMO_REQUIRE_REAL=1`): `/open` and `/resolve` return
`503` with a structured `blockers` list if any sponsor leg would silently
degrade to dry-run. The agent never falls back to `mp position buy` on
`503` — that's exactly the masquerade the flag prevents. Strong "the
privacy gate refuses to lie" demo signal.

**Redeploy script** (`apps/app/scripts/redeploy-pinata-agent.sh
<AGENT_ID> <GIT_TOKEN>`): clones a fresh agent, overlays our 7 source
files, pushes. Idempotent. ~3 minutes from "trial expired" to "agent back
online with our customisation."

---

## Quickstart

### Prereqs

- macOS or Linux.
- [`uv`](https://docs.astral.sh/uv/) (Python services) — `brew install uv`.
- [`bun`](https://bun.sh/) ≥ 1.3 (cogito sidecar) — `brew install oven-sh/bun/bun`.
- [`foundry`](https://book.getfoundry.sh/) (contracts) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- A funded **Arbitrum Sepolia** EOA (treasury) and an **Arbitrum Sepolia 0G Galileo** wallet (cogito signer). Faucets: [arb-sepolia](https://www.alchemy.com/faucets/arbitrum-sepolia), [0g](https://faucet.0g.ai) *(intermittent — see [LESSONS.md](./LESSONS.md))*, [polygon-amoy](https://faucet.polygon.technology/).

### One-shot demo

```bash
cp .env.example .env       # fill in keys + RPC URLs
make install               # uv sync + bun install + forge install
make demo                  # boots the integrated app + sidecars + one orchestrator tick
```

Then open the unified operator terminal at **http://127.0.0.1:3000/** and watch positions flow through `funding → bridged → open → resolving → settled`.

### Manual control

```bash
make app                   # Miroshark terminal (Next.js, :3000)
make cogito                # cogito sidecar (Bun, :5003)
make signal                # signal-gateway (Flask, :5002)
make execution             # execution-router (Flask, :5004)
make orchestrator-once     # single tick: scan → rank → open up to N positions
make orchestrator-loop     # daemon loop (interval = $ORCHESTRATOR_INTERVAL_S)
make orchestrator-dry      # daemon, log-only, never hits /open
make contracts-test        # forge test --via-ir (38/38)
make stop                  # kill any service started by `make demo`
```

### Graceful degradation

Every sidecar is optional and the upstream caller falls back:

| Missing | Fallback |
|---|---|
| `BURNER_SEED` | execution-router /open returns 500 (hard-required) |
| `MERIDIAN_HOOK_ADDRESS` / `ARB_SEPOLIA_RPC_URL` | offline mode — synthetic tx hashes, dashboard still walks the state machine |
| `COGITO_URL` | `DryRunEncryptor` + `DryRunBridgeClient` (chain submission would revert; useful for wiring tests) |
| `KEEPERHUB_API_KEY` | tx submitted directly by treasury EOA |
| `LLM_PROVIDER!=0g` | direct OpenAI; `seed_hash_0g` / `simulation_hash_0g` populate as `null` |
| AXL down | `SWARM_BACKEND=lite` → single-LLM stand-in |

This is a hackathon — graceful is the point. Demos still run when sponsors' testnets blip.

---

## Repo layout

```
meridian-core/
├── contracts/                Foundry. PrivateSettlementHook + HybridFHERC20 (fhUSDC).
│   └── script/               Deploy + pool-create + swap scripts.
├── app/                      Next.js app router shell for the unified operator terminal.
├── components/miroshark/     React/D3 terminal + graph components.
├── lib/                      Opportunity graph + terminal helpers.
├── services/
│   ├── meridian_signal/      Flask :5002 — Polymarket scanner + swarm gateway.
│   ├── swarm_runner/         3-node Gensyn AXL mesh (SWARM_BACKEND=axl).
│   ├── cogito/               Hono+Bun :5003 — wraps 0G Storage, 0G Compute, Bridge Kit, cofhejs.
│   ├── execution_router/     Flask :5004 — burner EOAs + bridge + CLOB + KeeperHub APIs.
│   ├── orchestrator/         Autonomous CLI loop (`python -m orchestrator [once|dry|loop]`).
│   └── README.md             Full env table + per-service docs.
├── backend/                  Analysis backend powering graph, simulation, and report APIs.
├── .context/meridian/        Spec, build plan, sponsor docs (LLM context dir).
├── CLAUDE.md                 Agent-facing context (phase table, conventions).
├── LESSONS.md                Append-only running log of gotchas + rationale.
├── Makefile                  see Quickstart above.
└── .env.example              all required + optional env vars with safe placeholders.
```

Sponsor docs live at [`.context/meridian/sponsor-docs/`](./.context/meridian/sponsor-docs/) — one markdown per sponsor with the actual API/SDK we used.

---

## Tech debt

See [`LESSONS.md`](./LESSONS.md) for the running log. Active items:

- **0G Galileo testnet faucet outage** blocks the live `seed_hash_0g` demo bar. Code path is exercised via the graceful-`null` fallback. Re-test when faucet recovers.
- **`BASE_SEPOLIA_RPC_URL` soft-deprecation** — `hook_client` honors it as a fallback so old `.env`s don't silently go offline. Hard-rename in Phase 6.
- **cofhejs init cost** — first `/fhe/encrypt` call downloads FHE public keys + TFHE WASM. Cached after that.

## License

Forked from [666ghj/MiroFish](https://github.com/666ghj/MiroFish). Miroshark-specific code is MIT (see [`LICENSE`](./LICENSE)).
