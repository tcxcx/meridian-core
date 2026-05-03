# MIROSHARK — agent context

Confidential autonomous prediction-market hedge fund. Forked from `666ghj/MiroFish`, now shipped as a single Miroshark app.
Hackathon scope (~36h) targeting four sponsor prizes: 0G, Gensyn AXL,
Uniswap Foundation (v4 + Fhenix CoFHE hook), KeeperHub.

Build phases (see `.context/meridian/BUILD_PLAN.md`):

| Phase | Status | Surface |
|---|---|---|
| 0 — fork + skeleton | done | `services/` scaffold, docker baseline |
| 1 — signal gateway | done | `services/meridian_signal/` (Polymarket + swarm-lite) |
| 2 — Gensyn AXL mesh | done | `services/swarm_runner/` (3 nodes, N agents/node) |
| 3 — 0G Storage + Compute | done* | `services/cogito/` (Hono+Bun sidecar) |
| 4a — v4 Fhenix CoFHE hook | done | `contracts/src/PrivateSettlementHook.sol` (+ tests) |
| 4b — execution-router | done | `services/execution_router/` (Flask :5004; burner + KeeperHub + CLOB) |
| 5 — autonomous loop + terminal | done | `services/orchestrator/` (CLI daemon) + unified Next.js operator terminal |
| 5b — Circle Gateway crosschain settlement | done | `services/cogito/src/bridge.ts` (+ `gatewayChains.ts`) + `services/execution_router/bridge_client.py` |
| 5c — cogito `/fhe/encrypt` (real `InEuint128`) | done | `services/cogito/src/fhe.ts` (cofhejs wrapper); Python `CogitoEncryptor` posts here |
| 6a — swarm intelligence overhaul | done | `services/swarm_runner/agent.py` (Tetlock superforecaster + category-aware personas) + `services/meridian_signal/seed.py` (rich seed_doc) + `orchestrator.py` (disagreement-aware aggregation + minority report) |
| 6b — Pinata-hosted operator (closes OpenClaw gap) | done | `apps/app/scripts/pinata-agent-overlay/` + `services/execution_router/api.py` (DEMO_REQUIRE_REAL gate + bearer auth) + `apps/app/app/api/pinata/*` |
| 6c — submission polish (final) | next | docs, demo video, scoring rubric notes |

## Chain topology

MERIDIAN runs on two testnets simultaneously. Keep them straight:

| Role | Chain | Domain | Why |
|---|---|---|---|
| **Settlement** (fhUSDC + `PrivateSettlementHook` + treasury custody) | Arbitrum Sepolia (chainId `421614`) | CCTP `3` | Fhenix CoFHE testnet coverage; cheaper/faster than Eth Sepolia. |
| **Trading** (Polymarket CLOB + burner EOAs) | Polygon PoS Amoy (chainId `80002`) | CCTP `7` | Polymarket has always been Polygon-native — EOA flow, no deploy. |

Cross-chain bridge = **Circle Gateway** (unified balance + EIP-712 BurnIntent
+ Forwarding Service). Testnet covers both Arb Sepolia (domain 3) and Polygon
Amoy (domain 7). Treasury holds a pre-deposited unified balance on Arb Sepolia
GatewayWallet (one-time setup); per-position the burner approves+deposits its
payout into Polygon Amoy GatewayWallet on `/resolve` before signing the
BurnIntent. Circle's Forwarder mints USDC on the destination chain so cogito
never holds destination-chain gas. Implementation lives in cogito (TS,
`src/bridge.ts` + `src/gatewayChains.ts`) and is invoked from execution-router
over localhost via `POST /bridge` and `POST /bridge/deposit`.

`done*` = code complete, smoke test blocked on funded testnet wallet (see Tech Debt).

## Service layout

- `backend/` — analysis backend powering graph, simulation, and report APIs.
- `services/meridian_signal/` — Flask gateway on `:5002`. `/api/signal/{markets/scan,run,runs/<hash>}`.
- `services/swarm_runner/` — AXL mesh orchestrator (`SWARM_BACKEND=axl`).
- `services/cogito/` — Hono+Bun sidecar on `127.0.0.1:5003`. Wraps TS/WASM-only SDKs for the Python services: 0G Storage + 0G Compute, Circle Gateway (`POST /bridge` and `POST /bridge/deposit` — Arb Sepolia ↔ Polygon Amoy via EIP-712 BurnIntent + Forwarder), and cofhejs (`POST /fhe/encrypt` — mints real `InEuint128` sealed inputs for `PrivateSettlementHook`). Bearer-token auth, bound localhost only.
- `contracts/` — Foundry project. v4 CoFHE `PrivateSettlementHook` + `HybridFHERC20` (fhUSDC). `forge test --via-ir`. Deploy script: `script/DeployPrivateSettlement.s.sol`.
- `services/execution_router/` — Flask gateway on `:5004`. `/api/execution/{open,resolve,positions,audit,audit/<id>}`. Per position: derive burner EOA (`keccak(BURNER_SEED‖id)`) → `fundBurner` encrypted on Arb Sepolia → Circle Gateway treasury→burner via cogito `/bridge` (Arb Sepolia → Polygon Amoy, Forwarder mints on destination) → submit Polymarket CLOB order. On `/resolve`: burner approves+deposits payout into Polygon Amoy GatewayWallet via cogito `/bridge/deposit`, then bridges back (Polygon Amoy → Arb Sepolia, Forwarder mints to treasury), then `markResolved`+`settle`. KeeperHub-wrapped when `KEEPERHUB_API_KEY` set. Dry-run fallbacks when sidecars are missing. Append-only SQLite audit log at `var/audit.db` records every state-changing op (`open.received`, `fund_burner.{ok,err}`, `bridge_send.{ok,err}`, `clob_submit.{ok,err}`, `gateway_deposit.{ok,err}`, `bridge_recv.{ok,err}`, `mark_resolved.ok`, `settle.ok`, `settled.ok`, `resolve.err`) with secrets redacted; readable via `GET /api/execution/audit?position_id=<id>&limit=<n>`. Live position deltas stream from `GET /api/execution/positions/stream` (text/event-stream — `snapshot` event on connect, then one `position` event per `store.upsert`). Root `/` now redirects to the unified app instead of serving a separate dashboard.
- `services/orchestrator/` — autonomous loop. `python -m orchestrator [once|dry|loop]`. Polls signal-gateway, ranks by `|edge_pp|` × confidence, opens up to N positions per tick via the execution-router. Hydrates from `/api/execution/positions` on boot so restarts don't re-trade.

## Cross-cutting conventions

- Graceful degradation > hard failure during hackathon. cogito unreachable → `*_hash_0g: null`. AXL mesh down → fall back to `SWARM_BACKEND=lite`.
- All sidecar wallets are testnet-only and `.env`-gitignored.
- Don't expose any sidecar publicly — they're symmetric-bearer-auth between localhost processes. EXCEPTION: when the Pinata agent is wired (see Phase 6b), execution-router + signal-gateway are exposed via Cloudflare Tunnel + protected by `MIROSHARK_AGENT_TOKEN` (env-gated, additive — local dev unchanged when unset). Cogito stays loopback-only with its own `COGITO_TOKEN`.

## Swarm intelligence (Phase 6a)

Each agent in the AXL swarm runs the **Tetlock superforecaster methodology** silently
before forecasting (decompose → base-rate → inside view → update on signals →
probabilistic). The system prompt is `_SUPERFORECASTER_SYS` in `agent.py:152`.

Per-market context fed to every agent (`seed.py:build_seed_document`):

- **Order-book microstructure** (E-01 entropy): per-outcome spread, depth, tier (0=active, 1=frozen, 2=deep-freeze), H bits. Trader's note baked in: tier 2 → discount edge ≥50%, spread > 100bps → slippage warning.
- **Correlated markets** (T-03 topology): list of markets with `|Pearson r| ≥ 0.70` over rolling mid-prices. Trader's note: duplicate-bet risk if fund holds correlated positions.
- **Cryo anomaly flag** (C-02): when this market's entropy z-score < -1.5 (abnormally frozen), flagged with "small size + fast exit" trader's note.

**Persona pool is category-aware.** `_detect_market_category` runs cheap keyword
classification (politics / finance / crypto / general) on the seed_doc; agents are
spread across a category-appropriate pool (e.g. politics markets get
`geopolitical-analyst`, `political-historian`, `policy-wonk` lenses; crypto markets
get `on-chain` + `narrative` lenses).

**Aggregation is disagreement-aware.** `_aggregate_beliefs` returns
`(consensus, adjusted_conf, raw_conf)` — `adjusted_conf` is `raw_conf *
max(0.5, 1 - 0.5 * normalised_disagreement)` when mean pairwise L1 distance
between agent probability vectors exceeds 0.30. `_summarise_reasoning` also
returns a `minority_report` for the strongest confident dissenter when the
swarm splits. Both ship in `/api/signal/run` as `confidence`,
`raw_confidence`, `agreement_score`, `minority_report`.

## Pinata-hosted operator (Phase 6b)

The "OpenClaw gap" (24/7 autonomous operator) is closed by deploying the
`polymarket/agents` derivative template `MoonPay Prediction Market Trader` on
Pinata Cloud and routing its execution calls back into MiroShark's privacy
rail.

- **Live agent:** `xt1sgi73.agents.pinata.cloud` paired with Telegram bot
  `@miro_shark_bot`. Same backend, two surfaces.
- **Custom workspace overlay:** `apps/app/scripts/pinata-agent-overlay/`
  contains the canonical edits we apply to the upstream template. `MIROSHARK.md`
  briefs the agent on the privacy rail; `skills/miroshark.md` is the endpoint
  cookbook with curl examples + the Phase 6 swarm response shape; `SOUL.md` /
  `TOOLS.md` mark `mp prediction-market position buy/sell/redeem` as
  DEPRECATED in favour of `POST $MIROSHARK_EXECUTION_URL/api/execution/open`.
- **Reach-back:** agent calls MiroShark via Cloudflare Tunnel (`miro-shark.com`
  zone, three subdomains: `execution.`, `signal.`, `cogito.`). Bearer-auth via
  `MIROSHARK_AGENT_TOKEN` shared between the operator's `.env` and Pinata
  agent secrets.
- **Redeploy:** when the trial expires or you fork to a new template, run
  `apps/app/scripts/redeploy-pinata-agent.sh <AGENT_ID> <GIT_TOKEN>` — clones
  fresh agent, overlays our 7 source files, pushes. Idempotent.
- **Demo gate:** `DEMO_REQUIRE_REAL=1` in `.env` forces `/open` and `/resolve`
  to return 503 with structured `blockers` if any sponsor leg would silently
  degrade to dry-run (e.g. CLOB credentials missing, bridge unreachable, FHE
  encryptor not configured). The agent never falls back to `mp position buy`
  on 503 — that's exactly the masquerade the flag prevents.

## Tech debt

See `LESSONS.md` for a running log. Active items:

- **0G Galileo testnet faucet (`https://faucet.0g.ai`) is currently down.**
  Phase 3 cogito Storage + Compute paths typecheck and route correctly,
  but end-to-end smoke test (upload → root_hash → download verify, plus
  `/compute/account/setup` → `/compute/inference`) requires funded
  `ZG_PRIVATE_KEY` (min 3 OG ledger + 1 OG per provider). Re-test when
  faucet recovers. Until then, `seed_hash_0g` / `simulation_hash_0g` will
  surface as `null` (graceful path is exercised).
