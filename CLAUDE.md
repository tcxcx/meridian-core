# MERIDIAN — agent context

Confidential autonomous prediction-market hedge fund. Fork of `666ghj/MiroFish`.
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
| 5 — autonomous loop + dashboard | done | `services/orchestrator/` (CLI daemon) + vanilla dashboard served at `:5004/` |
| 5b — Circle Gateway crosschain settlement | done | `services/cogito/src/bridge.ts` (+ `gatewayChains.ts`) + `services/execution_router/bridge_client.py` |
| 5c — cogito `/fhe/encrypt` (real `InEuint128`) | done | `services/cogito/src/fhe.ts` (cofhejs wrapper); Python `CogitoEncryptor` posts here |
| 6 — submission polish | next | |

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

- `backend/` — upstream MiroFish (Python). Don't modify; we sit beside it.
- `services/meridian_signal/` — Flask gateway on `:5002`. `/api/signal/{markets/scan,run,runs/<hash>}`.
- `services/swarm_runner/` — AXL mesh orchestrator (`SWARM_BACKEND=axl`).
- `services/cogito/` — Hono+Bun sidecar on `127.0.0.1:5003`. Wraps TS/WASM-only SDKs for the Python services: 0G Storage + 0G Compute, Circle Gateway (`POST /bridge` and `POST /bridge/deposit` — Arb Sepolia ↔ Polygon Amoy via EIP-712 BurnIntent + Forwarder), and cofhejs (`POST /fhe/encrypt` — mints real `InEuint128` sealed inputs for `PrivateSettlementHook`). Bearer-token auth, bound localhost only.
- `contracts/` — Foundry project. v4 CoFHE `PrivateSettlementHook` + `HybridFHERC20` (fhUSDC). `forge test --via-ir`. Deploy script: `script/DeployPrivateSettlement.s.sol`.
- `services/execution_router/` — Flask gateway on `:5004`. `/api/execution/{open,resolve,positions,audit,audit/<id>}`. Per position: derive burner EOA (`keccak(BURNER_SEED‖id)`) → `fundBurner` encrypted on Arb Sepolia → Circle Gateway treasury→burner via cogito `/bridge` (Arb Sepolia → Polygon Amoy, Forwarder mints on destination) → submit Polymarket CLOB order. On `/resolve`: burner approves+deposits payout into Polygon Amoy GatewayWallet via cogito `/bridge/deposit`, then bridges back (Polygon Amoy → Arb Sepolia, Forwarder mints to treasury), then `markResolved`+`settle`. KeeperHub-wrapped when `KEEPERHUB_API_KEY` set. Dry-run fallbacks when sidecars are missing. Append-only SQLite audit log at `var/audit.db` records every state-changing op (`open.received`, `fund_burner.{ok,err}`, `bridge_send.{ok,err}`, `clob_submit.{ok,err}`, `gateway_deposit.{ok,err}`, `bridge_recv.{ok,err}`, `mark_resolved.ok`, `settle.ok`, `settled.ok`, `resolve.err`) with secrets redacted; readable via `GET /api/execution/audit?position_id=<id>&limit=<n>`. Live position deltas stream from `GET /api/execution/positions/stream` (text/event-stream — `snapshot` event on connect, then one `position` event per `store.upsert`); dashboard prefers SSE and falls back to 5s polling on transport error. Serves the operator dashboard at `/`.
- `services/orchestrator/` — autonomous loop. `python -m orchestrator [once|dry|loop]`. Polls signal-gateway, ranks by `|edge_pp|` × confidence, opens up to N positions per tick via the execution-router. Hydrates from `/api/execution/positions` on boot so restarts don't re-trade.

## Cross-cutting conventions

- Graceful degradation > hard failure during hackathon. cogito unreachable → `*_hash_0g: null`. AXL mesh down → fall back to `SWARM_BACKEND=lite`.
- All sidecar wallets are testnet-only and `.env`-gitignored.
- Don't expose any sidecar publicly — they're symmetric-bearer-auth between localhost processes.

## Tech debt

See `LESSONS.md` for a running log. Active items:

- **0G Galileo testnet faucet (`https://faucet.0g.ai`) is currently down.**
  Phase 3 cogito Storage + Compute paths typecheck and route correctly,
  but end-to-end smoke test (upload → root_hash → download verify, plus
  `/compute/account/setup` → `/compute/inference`) requires funded
  `ZG_PRIVATE_KEY` (min 3 OG ledger + 1 OG per provider). Re-test when
  faucet recovers. Until then, `seed_hash_0g` / `simulation_hash_0g` will
  surface as `null` (graceful path is exercised).
