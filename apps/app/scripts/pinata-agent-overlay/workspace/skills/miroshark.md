# skills/miroshark.md — MiroShark execution-router + signal-gateway cookbook

This is the canonical reference for every MiroShark endpoint you can call. Read this before issuing any HTTP request to the MiroShark services. See `MIROSHARK.md` for *why*.

## Auth

All requests to `MIROSHARK_SIGNAL_URL/*` and `MIROSHARK_EXECUTION_URL/*` (except `/health`) require:

```
Authorization: Bearer ${MIROSHARK_API_TOKEN}
```

If the token is wrong or missing, the response is `401 { "error": "unauthorized", "message": "..." }`. Health probes work without a token so you can check liveness anytime.

## Common envelope

- Success responses are JSON; success status codes 200 (or 202 for async).
- Error responses are JSON: `{ "error": "<short>", "message": "<long>", ... }`. HTTP status reflects the failure mode (400 invalid input, 403 tenant disallows, 404 unknown, 422 over-limit, 502 downstream, 503 demo-real-required).
- `position` records always include `position_id`, `status`, `usdc_amount`, `tenant_id`, `strategy`, `market_id`, `token_id`, `burner_address`, plus per-step tx fields (`fund_tx`, `bridge_send_burn_tx`, `bridge_send_mint_tx`, `clob_order_id`, `gateway_deposit_tx`, `bridge_recv_burn_tx`, `bridge_recv_mint_tx`, `resolve_tx`, `settle_tx`, `payout_usdc`, `created_at`, `updated_at`, optional `error`).

---

## 1. Health + readiness

### GET `${MIROSHARK_EXECUTION_URL}/health`
No auth required. Use this before any /open call to confirm the rail is alive and to check `demo_require_real` mode.

```bash
curl -s "$MIROSHARK_EXECUTION_URL/health" | jq .
```

Response highlights:
- `status` — should be `"ok"`
- `wiring.audit_healthy` — must be `true` (audit DB readable). If false, the demo backbone is broken.
- `wiring.bridge` — `"BridgeClient"` for real, `"DryRunBridgeClient"` for fallback
- `wiring.encryptor` — `"CogitoEncryptor"` for real FHE, `"DryRunEncryptor"` for fallback
- `demo_require_real` (bool) — if true and any wiring leg is dry-run, /open will 503
- `demo_real_blockers` — list of human-readable strings if real-mode blocked
- `rpcs.arb_sepolia.{ok,latency_ms}` — settlement-chain RPC status
- `rpcs.polygon_amoy.{ok,latency_ms}` — trading-chain RPC status

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/operator/status`
The operator's full picture. Read this once on heartbeat to know capital plane, sponsor readiness, kill-switch state, threshold for signal acceptance.

```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/operator/status" | jq .
```

Key fields:
- `mode` — `"manual"` or `"autonomous"`
- `capital_plane.balances` — grand_total, available_to_deploy, deployed_at_risk, profit_sweep_pending
- `capital_plane.policy` — `per_position_min_usdc`, `per_position_max_usdc`. **Never exceed `per_position_max_usdc`** — the router will 422 you.
- `thresholds.directional_min_edge_pp` — minimum edge to even consider a trade (e.g. 3.0 means 3 percentage points)
- `thresholds.directional_min_confidence` — minimum confidence (e.g. 0.55)
- `automation.kill_switch_enabled` — if true, ALL trades are blocked by Tomas
- `sponsors[]` — list of `{ key, label, ready, mode, blocker }`. Reads e.g. Polymarket, Circle Gateway, Fhenix, KeeperHub. If `ready: false`, that leg is degraded.

### GET `${MIROSHARK_SIGNAL_URL}/health`
No auth required.

```bash
curl -s "$MIROSHARK_SIGNAL_URL/health" | jq .
```

---

## 2. Discovery + thesis (signal-gateway)

### POST `${MIROSHARK_SIGNAL_URL}/api/signal/markets/scan`
Polymarket market scan. Filters by liquidity, returns top N.

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_SIGNAL_URL/api/signal/markets/scan" \
  -d '{"limit": 10, "min_liquidity_usd": 5000}' | jq .
```

Response: `{ "markets": [{ market_id, slug, question, outcomes, token_ids, liquidity_usd, volume_usd, ... }, ...] }`

Use the `market_id` and `token_ids[0]` (YES) / `token_ids[1]` (NO) for the next steps.

You can still use `mp prediction-market market trending list --provider polymarket --limit 10` — same data, different rail. Use whichever is faster on demo day.

### POST `${MIROSHARK_SIGNAL_URL}/api/signal/run`
Run the AXL swarm on a single market. Returns the swarm consensus + edge. **This is the thesis you lead every trade card with.**

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_SIGNAL_URL/api/signal/run" \
  -d '{"market_id": "<market_id>"}' | jq .
```

Response highlights:
- `phase` — should start with `"2-axl-mesh"` for full multi-node consensus
- `confidence` — float 0..1
- `edge` — `{ outcome: "YES" | "NO", edge_pp: 4.2 }` (positive percentage points vs market price)
- `key_factors[]` — short bullet strings the swarm reasoned about
- `reasoning` — paragraph from the swarm consensus
- `attestation_envelope` — present when 0G Storage pinning is healthy
- `seed_hash_0g` / `simulation_hash_0g` — non-null when 0G Storage is up (faucet-dependent)

If `edge.edge_pp < operator_status.thresholds.directional_min_edge_pp` OR `confidence < thresholds.directional_min_confidence`, **don't recommend the trade** — Tomas's threshold gate would reject it anyway.

### GET `${MIROSHARK_SIGNAL_URL}/api/signal/runs/stream?market_id=<id>` (SSE)
Live debate stream for one market. Event types: `run`, `start`, `belief`, `agent_error`, `result`. Use only when Tomas explicitly asks "show me the swarm debate" — for normal flow, the synchronous `/run` endpoint is enough.

---

## 3. Open a position

### POST `${MIROSHARK_EXECUTION_URL}/api/execution/open`

The trade. Generate `position_id` client-side (any unique string; UUID4 recommended).

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/open" \
  -d '{
    "position_id": "tomas-2026-05-02-001",
    "market_id": "<market_id from /signal/markets/scan>",
    "token_id":  "<token_ids[0] for YES, token_ids[1] for NO>",
    "side":      "BUY",
    "usdc_amount": 5.0,
    "strategy":  "directional",
    "tenant_id": "default"
  }' | jq .
```

Required: `position_id`, `market_id`, `token_id`, `usdc_amount`. Defaults: `side="BUY"`, `strategy="directional"`, `tenant_id="default"`.

Response:
```json
{ "position": { "position_id": "...", "status": "open", "burner_address": "0x...",
                "fund_tx": "0x...", "clob_order_id": "...", ... } }
```

Status interpretation:
- `200 + position.status="open"` — happy path. Open in <60s if real RPCs are pinned, up to 120s on public RPCs.
- `400` — missing required fields. Body says which.
- `403` — tenant doesn't allow this strategy. Body lists `allowed_strategies`.
- `422` — `usdc_amount` exceeds `tenant.per_position_max_usdc`. Resize and retry.
- `502` — bridge or hook failed mid-flight. Body includes the position record so you can see how far it got.
- `503` — `DEMO_REQUIRE_REAL=1` is set and a leg is dry-run. Body includes `blockers: [...]` — relay verbatim to Tomas.

### Poll status: GET `${MIROSHARK_EXECUTION_URL}/api/execution/positions/<position_id>`

```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/positions/<position_id>" | jq .
```

Status values you'll see during `/open`: `funding` → `open`. If status is `failed`, read `error` field.

### Read audit timeline: GET `${MIROSHARK_EXECUTION_URL}/api/execution/audit/<position_id>`

```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/audit/<position_id>" | jq .
```

Returns `{ "events": [{ event, status, payload, ts }, ...] }`. Use the latest `event` to tell Tomas which lifecycle stage we're in (e.g. "still bridging — at `bridge_send.ok`, waiting for Forwarder to mint").

---

## 4. Resolve a position

### POST `${MIROSHARK_EXECUTION_URL}/api/execution/resolve`

When a market resolves, settle the position. Required: `position_id`, `payout_usdc` (the actual USDC the burner received from Polymarket).

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/resolve" \
  -d '{
    "position_id": "tomas-2026-05-02-001",
    "payout_usdc": 7.5
  }' | jq .
```

Status walks: `open` → `resolving` → `settled`. Same 60-120s bridge wait as `/open`, this time Amoy → Arb. Poll `/positions/<id>` until `status="settled"`. Read audit until `settled.ok` event lands.

`payout_usdc=0` is valid — it means the position lost (no payout, just cleanup). The router still walks the resolve path so the audit log shows a complete trade lifecycle.

---

## 5. Book monitoring

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/positions`
All positions across all tenants. Use this on every heartbeat.

```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/positions" | jq '.positions | map(select(.status != "settled" and .status != "failed"))'
```

PnL on settled trades:
```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/positions" \
  | jq '.positions | map(select(.status == "settled")) | map({pid: .position_id, pnl: ((.payout_usdc // 0) - .usdc_amount)})'
```

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/positions/stream` (SSE)
Live position updates. Backoff-reconnect baked in; one snapshot event on connect, then one position event per state change. Use when you want to react to settlements without polling.

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/audit?limit=50`
Recent audit events across all positions (no position_id filter).

---

## 6. Tenants (rarely needed)

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/tenants`
For Tomas's solo deployment, you'll see `[{ "tenant_id": "default", ... }]`. Use that. Don't invent new tenants.

---

## 7. Daily PnL pack (Bucket 5 — useful for end-of-day reports)

### POST `${MIROSHARK_EXECUTION_URL}/api/execution/daily-pack/<YYYY-MM-DD>/build`
Builds and pins a daily verifiable PnL pack to 0G Storage (when faucet is up). Returns the pack envelope + the pinning result. Surface this to Tomas at end of day so he has the auditable artifact for the demo.

### GET `${MIROSHARK_EXECUTION_URL}/api/execution/daily-pack/<YYYY-MM-DD>`
Reads the cached pack.

---

## 8. Cogito (you don't usually call this directly)

The execution-router calls cogito on Tomas's behalf for FHE encryption + Circle Gateway bridges. You only hit cogito if Tomas explicitly asks you to test FHE encryption manually:

### POST `${MIROSHARK_COGITO_URL}/fhe/encrypt`
Requires its own `Authorization: Bearer ${COGITO_TOKEN}` (different secret). For demo, leave this to the execution-router.

---

## 9. Error patterns to watch for

- `{"error": "BURNER_SEED not configured"}` (500) → Tomas hasn't set up the burner key yet. Tell him to run setup.
- `{"error": "tenant 'default' does not allow strategy 'X'", "allowed_strategies": [...]}` (403) → strategy field wrong, retry with one from the list
- `{"error": "usdc_amount=N exceeds tenant 'default' per_position_max=M"}` (422) → resize down to M and retry
- `{"error": "DEMO_REQUIRE_REAL=1 set...", "blockers": [...]}` (503) → DON'T fall back to MoonPay. Relay blockers verbatim.
- `{"error": "bridge send failed: ..."}` (502) → check the `position` field in the body for state; tell Tomas which step failed and consider a small retry after 60s
- `{"error": "unauthorized"}` (401) → `MIROSHARK_API_TOKEN` is wrong or missing. Stop and tell Tomas.

---

## 10. Trade confirmation format (override SOUL.md)

When proposing a trade, use this template (replaces the one in SOUL.md):

```
Market: <title>                              [via Polymarket on Polygon Amoy]
Outcome: YES / NO                            [token_id ... ]
Price: $0.65 per share (implies 65% probability)
Size: 7.5 USDC
Cost: 7.5 USDC                                [paid by burner EOA, derived per-position]

Swarm verdict (MiroShark AXL): YES @ 5.2pp edge, 0.71 confidence
Key factors:
  • <factor 1 from /signal/run key_factors>
  • <factor 2>
  • <factor 3>

Privacy: encrypted size via Fhenix CoFHE hook (size never appears on-chain in cleartext)
Settlement rail: Circle Gateway (Arb Sepolia ↔ Polygon Amoy), ~60-120s bridge wait

Max profit: $4.04 (if resolves YES)
Max loss: $7.5 (if resolves NO)

Confirm? (yes / no)
```

On `yes`, fire `POST /api/execution/open`. Stream the audit events to Tomas as they land. Update book.md with the position_id + status.
