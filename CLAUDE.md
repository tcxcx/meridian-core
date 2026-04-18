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
| 4 — v4 Fhenix CoFHE pool + execution-router | next | |
| 5 — autonomous loop + dashboard | pending | |
| 6 — submission polish | pending | |

`done*` = code complete, smoke test blocked on funded testnet wallet (see Tech Debt).

## Service layout

- `backend/` — upstream MiroFish (Python). Don't modify; we sit beside it.
- `services/meridian_signal/` — Flask gateway on `:5002`. `/api/signal/{markets/scan,run,runs/<hash>}`.
- `services/swarm_runner/` — AXL mesh orchestrator (`SWARM_BACKEND=axl`).
- `services/cogito/` — Hono+Bun sidecar on `127.0.0.1:5003`. Wraps both 0G TS SDKs (Storage + Compute). Bearer-token auth, bound localhost only.

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
