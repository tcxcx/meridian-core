# MERIDIAN services

Sidecar Python services that wrap the MiroFish backend. Run alongside the docker compose stack — they are NOT part of the upstream image.

Layout:

```
services/
├── pyproject.toml          # uv workspace; package = meridian_signal
├── meridian_signal/        # Phase 1: Polymarket scanner + swarm-lite + signal API
│   ├── api.py              # Flask app on :5002, mounts /api/signal/*
│   ├── polymarket.py       # Gamma + CLOB read-path
│   ├── seed.py             # build seed document for swarm
│   ├── swarm.py            # Phase 1 single-LLM stand-in (Phase 2 → AXL multi-agent)
│   └── _dns_fallback.py    # socket.getaddrinfo monkey-patch for hosts the LAN resolver NXDOMAINs
├── swarm_runner/           # Phase 2: 3-node Gensyn AXL mesh + N agents per node
│   ├── axl_client.py
│   ├── agent.py
│   ├── nodes.py            # supervisor for 3 axl/node processes
│   └── orchestrator.py
├── cogito/                 # Phase 3 + 5b: Hono+Bun sidecar — 0G Storage pin/fetch +
│                           #               0G Compute (DeAIOS) verifiable LLM inference +
│                           #               Circle Bridge Kit (CCTP V2) crosschain USDC
│   ├── src/
│   │   ├── index.ts        # Hono app, middleware, routes
│   │   ├── zg.ts           # @0gfoundation/0g-ts-sdk wrapper (storage)
│   │   ├── compute.ts      # @0glabs/0g-serving-broker wrapper (compute)
│   │   └── bridge.ts       # @circle-fin/bridge-kit wrapper (POST /bridge, CCTP V2)
│   └── README.md
├── execution_router/       # Phase 4b + 5b: burner EOAs + Bridge Kit + CLOB + KeeperHub
│   ├── api.py              # Flask app on :5004, mounts /api/execution/*
│   ├── burner.py           # deterministic per-position EOA derivation
│   ├── store.py            # in-memory PositionStore (off-chain mirror of hook state)
│   ├── encryptor.py        # CoFHE InEuint128 builder (cogito-backed or dry-run)
│   ├── hook_client.py      # web3.py wrapper for PrivateSettlementHook
│   ├── bridge_client.py    # Python client for cogito /bridge (Arb Sepolia ↔ Polygon Amoy)
│   ├── keeperhub.py        # KeeperHub Direct Execution API client
│   └── clob_client.py      # py-clob-client wrapper with dry-run fallback
├── orchestrator/           # Phase 5: autonomous loop (scan → run → open)
│   ├── loop.py             # Orchestrator class with configurable thresholds
│   └── __main__.py         # CLI: `python -m orchestrator [once|dry|loop]`
├── signal-gateway/         # (reserved — empty)
├── market-scanner/         # (reserved — folded into orchestrator)
└── fund-state/             # (reserved — folded into execution_router.store)
```

## Quickstart

Requires `uv` (`brew install uv`).

```bash
cd meridian-core/services
uv sync                                # installs deps into .venv/
uv run python -m meridian_signal.api   # binds 0.0.0.0:5002
```

Env (read from `meridian-core/.env`, one level up):

| Var | Default | Purpose |
|---|---|---|
| `LLM_API_KEY` | — required — | OpenAI-format key (ignored when `LLM_PROVIDER=0g`) |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | |
| `LLM_MODEL_NAME` | `gpt-4o-mini` | |
| `LLM_PROVIDER` | `openai` | `openai` = direct; `0g` = route through cogito /compute/inference |
| `COGITO_LLM_MODEL` | `openai/gpt-oss-20b` | 0G DeAIOS model when `LLM_PROVIDER=0g` |
| `COGITO_URL` | `http://127.0.0.1:5003` | cogito sidecar (Phase 3) |
| `COGITO_TOKEN` | — required for 0G anchor — | shared bearer token |
| `SIGNAL_GATEWAY_PORT` | `5002` | |
| `SWARM_BACKEND` | `lite` | `lite` = single-LLM (Phase 1); `axl` = 3-node Gensyn AXL mesh (Phase 2) |
| `SWARM_AGENTS_PER_NODE` | `5` | only used when `SWARM_BACKEND=axl` |
| `SWARM_ROUNDS` | `2` | only used when `SWARM_BACKEND=axl` |
| `EXECUTION_ROUTER_PORT` | `5004` | execution-router port |
| `BURNER_SEED` | — required for execution-router — | 32-byte hex; per-position EOAs derive from `keccak(BURNER_SEED ‖ positionId)` |
| `ARB_SEPOLIA_RPC_URL` | — | RPC for the hook chain (Arbitrum Sepolia, Fhenix CoFHE). `BASE_SEPOLIA_RPC_URL` is honored as a fallback for back-compat. Without either, offline mode. |
| `MERIDIAN_HOOK_ADDRESS` | — | deployed `PrivateSettlementHook` (CREATE2-mined). Without it, offline mode. |
| `TREASURY_PRIVATE_KEY` | — | EOA that signs `fundBurner` / `markResolved` / `settle` when KeeperHub disabled, and signs Bridge Kit burns from the settlement chain. |
| `KEEPERHUB_API_KEY` | — | when set, every hook tx routes through `app.keeperhub.com/api/execute/contract-call`. |
| `KEEPERHUB_NETWORK` | `421614` | KeeperHub network id (Arbitrum Sepolia by default). |
| `COGITO_BASE_URL` / `COGITO_URL` | — | when set, `encryptor` posts to cogito's `/fhe/encrypt` (real `InEuint128` via cofhejs) and `bridge_client` posts to `/bridge`. Either name works; accepts the same bearer as `COGITO_TOKEN` (or legacy `COGITO_BEARER`). |
| `FHE_PRIVATE_KEY` | — | cogito's signer for cofhejs sealed inputs. Falls back to `TREASURY_PRIVATE_KEY`. The Python-side `sender` field MUST equal this address or the hook rejects the proof. |
| `FHE_RPC_URL` | — | Arb Sepolia RPC used by cofhejs. Falls back to `ARB_SEPOLIA_RPC_URL` → `ZG_RPC_URL`. |
| `BRIDGE_SETTLEMENT_CHAIN` | `Arbitrum_Sepolia` | Bridge Kit source chain for `/open` (also destination for `/resolve`). |
| `BRIDGE_TRADING_CHAIN` | `Polygon_Amoy_Testnet` | Bridge Kit destination chain for `/open` (Polymarket-native). |
| `SIGNAL_GATEWAY_URL` | `http://127.0.0.1:5002` | orchestrator → signal-gateway |
| `EXECUTION_ROUTER_URL` | `http://127.0.0.1:5004` | orchestrator → execution-router |
| `ORCHESTRATOR_INTERVAL_S` | `60` | loop interval |
| `ORCHESTRATOR_MAX_POSITIONS` | `1` | new positions opened per tick |
| `ORCHESTRATOR_MIN_EDGE_PP` | `3.0` | min `|edge_pp|` before a candidate becomes a trade |
| `ORCHESTRATOR_MIN_CONFIDENCE` | `0.55` | min swarm confidence to trade |
| `ORCHESTRATOR_USDC_PER_POSITION` | `5.0` | notional per position (USDC) |
| `ORCHESTRATOR_DRY_RUN` | `false` | log-only mode; never hit `/open` |

## Endpoints

`GET /health`

```json
{"service":"MERIDIAN signal-gateway","status":"ok","phase":"1"}
```

`POST /api/signal/markets/scan` — list active Polymarket markets ranked by 24h volume.

```bash
curl -sS -X POST http://localhost:5002/api/signal/markets/scan \
  -H 'Content-Type: application/json' \
  -d '{"limit":3,"min_liquidity_usd":50000}'
```

`POST /api/signal/run` — run swarm-lite, return `{ swarm_prediction, confidence, edge, reasoning, key_factors }`.

```bash
curl -sS -X POST http://localhost:5002/api/signal/run \
  -H 'Content-Type: application/json' \
  -d '{"market_id":"<conditionId-or-slug>"}'
```

Response shape (stable across phases — only the `phase` field and the populated `*_hash_0g` fields change):

```json
{
  "run_id": "uuid4",
  "market_id": "0x...",
  "slug": "...",
  "question": "...",
  "outcomes": ["Yes","No"],
  "market_prices": [0.355, 0.645],
  "swarm_prediction": {"Yes": 0.4, "No": 0.6},
  "confidence": 0.75,
  "reasoning": "...",
  "key_factors": ["...","..."],
  "contributing_agents": [],
  "edge": {
    "outcome": "Yes",
    "swarm_probability": 0.4,
    "market_probability": 0.355,
    "edge_pp": 4.5
  },
  "phase": "1-swarm-lite",
  "model": "gpt-4o-mini",
  "elapsed_s": 3.76,
  "seed_hash_0g": null,
  "seed_tx_0g": null,
  "simulation_hash_0g": null,
  "simulation_tx_0g": null
}
```

`edge.outcome` = whichever outcome the swarm disagrees with the market most strongly on (sorted by `abs(edge_pp)` desc). Positive `edge_pp` = swarm thinks the outcome is more likely than the market does (BUY signal).

## orchestrator (Phase 5)

Autonomous loop that ties the three services together.

```bash
uv run python -m orchestrator once     # single tick, prints JSON summary
uv run python -m orchestrator dry      # daemon, log-only (never hits /open)
uv run python -m orchestrator          # production daemon loop
```

Flow per tick:
1. `POST signal-gateway /api/signal/markets/scan` — ranked Polymarket markets.
2. For each market not already opened: `POST /api/signal/run` → get swarm prediction + `edge`.
3. Drop candidates below `ORCHESTRATOR_MIN_EDGE_PP` / `ORCHESTRATOR_MIN_CONFIDENCE` or with negative edge.
4. Sort remaining by edge desc; take up to `ORCHESTRATOR_MAX_POSITIONS` per tick.
5. `POST execution-router /api/execution/open` for each pick.

On boot, the orchestrator hydrates from `GET /api/execution/positions` so a restart doesn't re-trade markets already opened in an earlier process.

## execution-router (Phase 4b)

Run alongside the signal gateway:

```bash
uv run python -m execution_router.api      # binds 0.0.0.0:5004
```

`GET /health` — wiring summary (which sidecars are configured + treasury address).

`POST /api/execution/open`

```bash
curl -sS -X POST http://localhost:5004/api/execution/open \
  -H 'Content-Type: application/json' \
  -d '{
    "position_id": "<uuid>",
    "market_id":  "<polymarket-condition-id>",
    "token_id":   "<clob-token-id>",
    "side":       "BUY",
    "usdc_amount": 5.0
  }'
```

The router (1) derives a fresh burner from `keccak(BURNER_SEED ‖ position_id)`, (2) calls `PrivateSettlementHook.fundBurner` with an encrypted amount (KeeperHub-wrapped if `KEEPERHUB_API_KEY` is set), (3) submits a Polymarket market order signed by the burner. Returns the full `PositionRecord` (status, tx hashes, KeeperHub execution ids).

`POST /api/execution/resolve`

```bash
curl -sS -X POST http://localhost:5004/api/execution/resolve \
  -H 'Content-Type: application/json' \
  -d '{ "position_id": "<uuid>", "payout_usdc": 7.5 }'
```

Calls `markResolved(positionId, encrypted_payout)` then `settle(positionId)`. Both txs route through KeeperHub when configured.

`GET /api/execution/positions/<position_id>` — single record.
`GET /api/execution/positions` — list.

`GET /` — lightweight operator dashboard (vanilla HTML). Polls `/health` + `/api/execution/positions` every 5s. No build step. Good enough for a demo; opens links to BaseScan for tx hashes.

Graceful degradation:
* `BURNER_SEED` unset → 500.
* `MERIDIAN_HOOK_ADDRESS` / `BASE_SEPOLIA_RPC_URL` unset → offline mode (skip on-chain step, still return position with synthetic ids).
* `COGITO_BASE_URL` unset → `DryRunEncryptor` returns a placeholder `InEuint128` (chain submission will revert; useful for wiring tests). With cogito reachable, `encryptor.CogitoEncryptor` calls `POST /fhe/encrypt` which wraps cofhejs and returns a real sealed input.
* CLOB credentials missing or burner unfunded → `clob_status: "dry_run"`, synthetic order id.

## Phase roadmap

| Phase | What changes here |
|---|---|
| 1 ✓ | Single-LLM swarm-lite, no on-chain anchors |
| 2 ✓ | Multi-agent gossip via 3-node Gensyn AXL mesh; `SWARM_BACKEND=axl` toggles it. See `swarm_runner/README.md` |
| 3 ✓ | cogito sidecar pins seed + simulation to 0G Storage (populates `*_hash_0g`) and optionally routes LLM through 0G Compute (`LLM_PROVIDER=0g`). See `cogito/README.md`. Graceful fallback to `null` if cogito is down. |
| 4a ✓ | `contracts/src/PrivateSettlementHook.sol` — v4 CoFHE pool gate + encrypted treasury → burner → treasury flow. `forge test --via-ir` passes 38/38. |
| 4b ✓ | `execution_router/` Flask app on :5004. Wires burner derivation → fundBurner (KeeperHub-wrapped) → Polymarket CLOB → markResolved + settle. Falls back to dry-run when hook/CLOB credentials missing. |
| 5 ✓ | `orchestrator/` (scan → run → open) + operator dashboard served at `:5004/`. |

## DNS fallback note

`_dns_fallback.py` monkey-patches `socket.getaddrinfo` so Polymarket hosts (`gamma-api.polymarket.com`, `clob.polymarket.com`) resolve to hardcoded Cloudflare IPs when the LAN resolver returns NXDOMAIN. Long-term fix: set system DNS to `1.1.1.1` / `8.8.8.8`, or run inside docker (uses Docker's resolver). Module is a no-op when the OS resolver works.
