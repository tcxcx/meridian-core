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

## Sponsor tracks (all four wired)

| Track | Surface |
|---|---|
| **Uniswap Foundation** | Custom v4 hook `PrivateSettlementHook` + `HybridFHERC20` (fhUSDC). 38/38 Foundry tests pass. Implements Fhenix's published *Private Prediction Market* case study end-to-end. |
| **Fhenix CoFHE** | `euint128` treasury → burner → treasury deltas. Real `InEuint128` sealed inputs minted via cofhejs server-side (`cogito /fhe/encrypt`). |
| **0G** | `cogito` sidecar wraps **0G Storage** (pins seed + simulation envelopes by merkle root) AND **0G Compute** (TeeML-verifiable LLM inference; `LLM_PROVIDER=0g` toggles it). |
| **KeeperHub** | Every hook tx (`fundBurner`, `markResolved`, `settle`) routes through KeeperHub Direct Execution API when `KEEPERHUB_API_KEY` is set. |
| **Gensyn AXL** *(bonus)* | 3-node Yggdrasil-routed multi-agent mesh; agents gossip beliefs over `/recv` per-node before consensus. `SWARM_BACKEND=axl` toggles it. |

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
