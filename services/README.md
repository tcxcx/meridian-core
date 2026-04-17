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
├── signal-gateway/         # (reserved — phase-2 multi-process gateway, currently empty)
├── swarm-runner/           # (reserved — phase-2 AXL agents)
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
| `LLM_API_KEY` | — required — | OpenAI-format key (Phase 3 will switch to 0G Compute base URL) |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | swap for 0G in Phase 3 |
| `LLM_MODEL_NAME` | `gpt-4o-mini` | |
| `SIGNAL_GATEWAY_PORT` | `5002` | |

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
  "simulation_hash_0g": null
}
```

`edge.outcome` = whichever outcome the swarm disagrees with the market most strongly on (sorted by `abs(edge_pp)` desc). Positive `edge_pp` = swarm thinks the outcome is more likely than the market does (BUY signal).

## Phase roadmap

| Phase | What changes here |
|---|---|
| 1 ✓ | Single-LLM swarm-lite, no on-chain anchors |
| 2 | Replace `swarm.py` body with multi-agent gossip via AXL; populate `contributing_agents` with AXL agent IDs |
| 3 | Point `LLM_BASE_URL` at 0G Compute Broker; populate `seed_hash_0g` + `simulation_hash_0g` from 0G Storage uploads |
| 4 | Add `POST /api/signal/execute { signal }` → calls `execution-router/` (burner wallets + KeeperHub) |
| 5 | Add `services/orchestrator/` autonomous loop that polls scan → run → execute |

## DNS fallback note

`_dns_fallback.py` monkey-patches `socket.getaddrinfo` so Polymarket hosts (`gamma-api.polymarket.com`, `clob.polymarket.com`) resolve to hardcoded Cloudflare IPs when the LAN resolver returns NXDOMAIN. Long-term fix: set system DNS to `1.1.1.1` / `8.8.8.8`, or run inside docker (uses Docker's resolver). Module is a no-op when the OS resolver works.
