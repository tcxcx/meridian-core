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
├── cogito/                 # Phase 3: Hono+Bun sidecar — 0G Storage pin/fetch +
│                           #          0G Compute (DeAIOS) verifiable LLM inference
│   ├── src/
│   │   ├── index.ts        # Hono app, middleware, routes
│   │   ├── zg.ts           # @0gfoundation/0g-ts-sdk wrapper (storage)
│   │   └── compute.ts      # @0glabs/0g-serving-broker wrapper (compute)
│   └── README.md
├── signal-gateway/         # (reserved — empty)
├── execution-router/       # (reserved — phase-4)
├── market-scanner/         # (reserved — phase-5 watcher loop)
└── fund-state/             # (reserved — phase-4 burner-wallet ledger)
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

## Phase roadmap

| Phase | What changes here |
|---|---|
| 1 ✓ | Single-LLM swarm-lite, no on-chain anchors |
| 2 ✓ | Multi-agent gossip via 3-node Gensyn AXL mesh; `SWARM_BACKEND=axl` toggles it. See `swarm_runner/README.md` |
| 3 ✓ | cogito sidecar pins seed + simulation to 0G Storage (populates `*_hash_0g`) and optionally routes LLM through 0G Compute (`LLM_PROVIDER=0g`). See `cogito/README.md`. Graceful fallback to `null` if cogito is down. |
| 4 | Add `POST /api/signal/execute { signal }` → calls `execution-router/` (burner wallets + KeeperHub) |
| 5 | Add `services/orchestrator/` autonomous loop that polls scan → run → execute |

## DNS fallback note

`_dns_fallback.py` monkey-patches `socket.getaddrinfo` so Polymarket hosts (`gamma-api.polymarket.com`, `clob.polymarket.com`) resolve to hardcoded Cloudflare IPs when the LAN resolver returns NXDOMAIN. Long-term fix: set system DNS to `1.1.1.1` / `8.8.8.8`, or run inside docker (uses Docker's resolver). Module is a no-op when the OS resolver works.
