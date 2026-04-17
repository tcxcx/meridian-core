# MERIDIAN — Fork Injection Points

Source-of-truth for **where** in the MiroFish fork (`meridian-core/`) we attach our sponsor integrations. Walked the upstream tree on 2026-04-17 (commit `fa0f651` "rename README-EN.md").

Working tree layout: `meridian-core/` is the fork checkout (gitignored from the orchestrator). Our additions land in `meridian-core/services/` (new dir) plus targeted edits inside `backend/app/`.

---

## Upstream layout (relevant subset)

```
meridian-core/
├── docker-compose.yml          # one service: ghcr.io/666ghj/mirofish:latest, ports 3000/5001
├── Dockerfile                  # python:3.11 + node + uv ; CMD npm run dev
├── backend/
│   ├── pyproject.toml          # uv-managed
│   └── app/
│       ├── __init__.py         # Flask app factory; CORS open on /api/*; blueprints + /health
│       ├── config.py           # env loader: LLM_API_KEY / LLM_BASE_URL / LLM_MODEL_NAME / ZEP_API_KEY
│       ├── api/
│       │   ├── graph.py        # /api/graph/*    (Zep knowledge-graph CRUD)
│       │   ├── simulation.py   # /api/simulation/*  (OASIS lifecycle, interview agents)
│       │   └── report.py       # /api/report/*   (LLM report-agent, tool-use loops)
│       ├── services/
│       │   ├── simulation_runner.py        (1768 LoC)  — OASIS subprocess driver
│       │   ├── simulation_manager.py       (529 LoC)   — orchestration, status
│       │   ├── simulation_ipc.py           (394 LoC)   — file-based IPC w/ subprocess
│       │   ├── simulation_config_generator.py
│       │   ├── oasis_profile_generator.py  (1205 LoC)  — agent personality builder
│       │   ├── ontology_generator.py
│       │   ├── graph_builder.py
│       │   ├── report_agent.py             (2572 LoC)  — tool-using report agent
│       │   ├── zep_tools.py                (1736 LoC)  — Zep memory CRUD
│       │   ├── zep_graph_memory_updater.py (554 LoC)
│       │   ├── zep_entity_reader.py        (437 LoC)
│       │   └── text_processor.py
│       ├── utils/
│       │   ├── llm_client.py   ★ single OpenAI-format wrapper used by everything
│       │   └── retry.py
│       └── models/
│           ├── project.py      — local project + run state
│           └── task.py
├── frontend/                   # Vite app
└── locales/
```

---

## 1. LLM inference  →  0G Compute / DeAIOS

**Single chokepoint:** `backend/app/utils/llm_client.py:30`

```python
self.client = OpenAI(api_key=self.api_key, base_url=self.base_url)
```

Driven entirely by env vars: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME`. Every consumer (`report_agent`, `oasis_profile_generator`, `simulation_*`, `ontology_generator`, `simulation_config_generator`) goes through the `LLMClient.chat` / `LLMClient.chat_json` methods.

### Plan

- **Path A (preferred):** if 0G Compute Broker exposes an OpenAI-compatible HTTP base URL → just point `LLM_BASE_URL` at it. Zero code change in MiroFish, zero rebase pain. Verify in Phase 3.
- **Path B (fallback):** add `backend/app/utils/zg_llm_client.py` mirroring `LLMClient`'s public surface (`chat`, `chat_json`), wrapping `createZGComputeNetworkBroker`. Add a `LLM_PROVIDER=openai|0g` env switch in `config.py` and a one-line factory in `llm_client.py`. Keep upstream constructor intact for clean rebases.

OpenAI fallback retained for dev only (per cut plan in BUILD_PLAN).

---

## 2. Agent memory + run logs  →  0G Storage

**Current backend = Zep**, accessed via three modules in `backend/app/services/`:

| File | LoC | Purpose |
|---|---:|---|
| `zep_tools.py` | 1736 | Zep CRUD, graph + episode read/write — used by `report_agent` and `simulation_runner` |
| `zep_graph_memory_updater.py` | 554 | Pushes new episodic memory into Zep after a run |
| `zep_entity_reader.py` | 437 | Reads entities back for the next simulation seed |

The Zep API key is gated at every API entry (`Config.ZEP_API_KEY` checks in `api/simulation.py:60`, etc.).

### Plan

- New `backend/app/services/zg_storage.py` — `@0gfoundation/0g-ts-sdk`-equivalent in Python (or shell out to a small Node sidecar — one TCP localhost call). Surfaces:
  - `upload(payload: dict | bytes) -> root_hash`
  - `download(root_hash) -> bytes`
  - `register_run(run_id, seed_hash, sim_hash) -> tx_hash`  (writes to 0G DA / EVM)
- Replace **only** the calls inside the three Zep modules whose result feeds into agent memory or run audit. Keep Zep alive in parallel for the existing graph-builder UI (no need to rip it out for the demo). Feature-flag per-call via `MEMORY_BACKEND=zep|0g` so we can demo both during judging.
- Always upload `seed_document_hash` and `simulation_output_hash` to 0G — these are the audit-trail anchors per ARCHITECTURE.md.

---

## 3. Agent-to-agent communication  →  Gensyn AXL

**Important nuance:** MiroFish doesn't own the messaging layer — it delegates to **OASIS** (CAMEL-AI's social simulator). OASIS runs in a subprocess and MiroFish drives it via `simulation_ipc.py` (file-system command/response with `INTERVIEW`, `BATCH_INTERVIEW`, `CLOSE_ENV` commands).

So we cannot just `Edit` a `send_message` line — there is none in the fork.

### Three options

1. **(a) Subclass / monkey-patch the OASIS environment** to route every action's downstream propagation through AXL. Highest fidelity but requires patching OASIS internals — fragile.
2. **(b) Build our own swarm orchestrator alongside MiroFish.** Use MiroFish for what it's best at (profile generation via `oasis_profile_generator.py`, memory via the new `zg_storage`), and run the actual prediction-market swarm as N processes — each registering an MCP service with the AXL router. Cross-node belief gossip = `POST /mcp/{peer}/agent-{id}` over the mesh. **Recommended.**
3. **(c) Run multiple MiroFish instances on different AXL nodes** with cross-node gossip in our orchestrator only. Heaviest infra; weakest cross-node visibility for judges.

### Plan (option b)

- New service `services/swarm-runner/` (Python) — spawns N agent processes, each:
  - Reads its profile from MiroFish via the existing API
  - Registers `agent-{id}` with the local AXL MCP router (per `sponsor-docs/axl.md`)
  - Exposes MCP tools: `propose_belief`, `update_trust`, `gossip(belief, evidence_hash)`
  - Loops: poll signal-gateway for the current market → run a 0G inference → push belief to N random peer agents over `/mcp/{peer}/agent-{i}/gossip`
- 3 AXL nodes (3 docker containers), 20 agents distributed across them — meets Gensyn's "must demonstrate communication across separate AXL nodes" qualification.
- All AXL traffic mirrored to a local log file → dashboard overlay.

---

## 4. HTTP API surface (for extension)

**Current shape** (`backend/app/__init__.py:66-74`):

```
POST/GET /api/graph/*       → graph_bp        (knowledge graph CRUD)
POST/GET /api/simulation/*  → simulation_bp   (OASIS lifecycle, interviews)
POST/GET /api/report/*      → report_bp       (tool-using report agent)
GET      /health
```

CORS is open on `/api/*` (line 43). Flask app factory in `__init__.py`.

### Plan

Add a fourth blueprint **without modifying upstream blueprints** — register from a new module so future rebases stay clean:

- `services/signal-gateway/` mounts `signal_bp` at `/api/signal/*`:
  - `POST /api/signal/markets/scan` → scan Polymarket, return candidates
  - `POST /api/signal/run { market_id }` → drive the swarm, return `{ swarm_prediction, market_price, edge, confidence, contributing_agents, seed_hash_0g, simulation_hash_0g }`
  - `GET  /api/signal/run/{run_id}` → poll
  - `POST /api/signal/execute { signal }` → kick off execution-router (private fund flow + KeeperHub)
- Register from `meridian-core/services/__init__.py` and import into `backend/app/__init__.py` via one new line — the only upstream edit needed for routing.

---

## 5. Frontend extension

`frontend/` is Vite + Vue (per `vite.config.js` and `package.json`). Reuse existing layout chrome; add panels:
- Live market feed (Polymarket WS)
- Active positions + P&L
- Swarm + AXL message overlay (extend the existing graph viz)
- **Privacy audit panel** — copy the Bagel `app/pages/privacy-audit.tsx` "observer view vs reality" pattern (per `REFERENCES.md`)

Phase 5 work; not blocking Phase 1.

---

## 6. Docker baseline status

- `docker compose config --quiet` parses clean ✓
- Compose pulls `ghcr.io/666ghj/mirofish:latest` (or builds local Dockerfile)
- Requires `meridian-core/.env` with at minimum: `LLM_API_KEY`, `LLM_BASE_URL`, `LLM_MODEL_NAME`, `ZEP_API_KEY` (created `.env.example` stub at fork root)
- Ports: 3000 (frontend), 5001 (backend Flask)
- Volume: `./backend/uploads:/app/backend/uploads` (will mount `.context/meridian/runs/` here in Phase 3 for persistent run logs)

**Baseline run not yet attempted** — needs real LLM key + Zep key. Do this before Phase 1 work.

---

## Cheat-sheet: who edits what (per BUILD_PLAN role split)

| Owner | Phase | Files they'll touch |
|---|---|---|
| Conejo | 0 | this doc, `.env.example`, `services/` skeleton dirs |
| Conejo | 1 | `services/signal-gateway/` (new), one import line in `backend/app/__init__.py` |
| Conejo | 2 | `services/swarm-runner/` (new), AXL node configs, no MiroFish edits |
| Tomi | 3 | `backend/app/services/zg_storage.py` (new), surgical edits in `zep_*.py`, possibly `utils/llm_client.py` factory |
| Conejo | 4 | `meridian-core/contracts/` (new), `services/execution-router/` (new) |
| Conejo | 5 | `services/orchestrator/` (new) — autonomous loop |
| Tomi  | 5 | `frontend/src/` panels |
| Both  | 6 | submission READMEs (one per sponsor) under `.context/meridian/submissions/` |

Keep the upstream MiroFish files untouched wherever possible. The only surgical edits planned are: one blueprint registration line, one LLM-client factory line, and the targeted Zep-call replacements behind a feature flag.
