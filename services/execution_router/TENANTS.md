# Multi-tenant Allocator (Bucket 6)

> Fork the kit, register your fund as a tenant, run your own confidential strategy on the same rails. Every position derives a per-tenant burner EOA, every PnL pack is tenant-scoped, every audit event carries the tenant id.

The execution-router has been multi-tenant since `95f4abf`. This doc is the env-var reference for forking the kit. Implementation: [`tenants.py`](./tenants.py). Smoke: [`test_tenants_smoke.py`](./test_tenants_smoke.py).

---

## Quickstart

Single-tenant fork (the default — leave `TENANTS` unset and you get one implicit tenant called `default` with permissive caps):

```bash
# nothing to set — the implicit "default" tenant uses:
#   capital_usdc          = 100
#   per_position_max_usdc = 25
#   strategies            = (any)
```

Multi-tenant fork (two funds sharing the same router):

```bash
TENANTS=fund-a,fund-b

TENANT_FUND_A_CAPITAL=250
TENANT_FUND_A_PER_POSITION_MAX=20
TENANT_FUND_A_STRATEGIES=directional,arb
TENANT_FUND_A_LABEL="Internal Treasury"

TENANT_FUND_B_CAPITAL=100
TENANT_FUND_B_PER_POSITION_MAX=5
TENANT_FUND_B_STRATEGIES=arb
TENANT_FUND_B_LABEL="Fund B"
```

Tenant ids → env-key form by uppercasing and replacing `-` with `_`.
So `fund-a` reads `TENANT_FUND_A_*`. Lowercase, hyphens, digits OK in the id.

---

## Env vars

| Var | Default | Notes |
|---|---|---|
| `TENANTS` | unset → single `default` tenant | Comma-separated tenant ids. Order is preserved end-to-end (verifier dropdown, `/tenants` response, daily-pack iteration). |
| `TENANT_<ID>_CAPITAL` | `100` | Total USDC the Allocator may deploy on this tenant's behalf. Decimal string, USDC units (not wei). |
| `TENANT_<ID>_PER_POSITION_MAX` | `25` | Hard cap on `usdc_amount` for any single position. Oversize requests `422` at `/api/execution/open`. |
| `TENANT_<ID>_STRATEGIES` | empty → permissive | Comma-separated strategy whitelist. Empty set = allow all (legacy behavior). Disallowed strategies `403` at `/api/execution/open`. |
| `TENANT_<ID>_LABEL` | the tenant id | Free-form display label for the verifier UI. |

---

## What changes per tenant

**Burner EOA derivation.** `keccak(BURNER_SEED ‖ tenant_id ‖ strategy_id ‖ position_id)`. Same `position_id` under different `(tenant_id, strategy_id)` tuples derives to a different EOA. The `default` tenant aliases the Bucket-4 layout (no tenant bytes in the preimage), so existing positions hydrate to the same burner without migration. See [`burner.py`](./burner.py).

**Position store.** `PositionRecord.tenant_id` carries the tag. `PositionStore.list()` is the single view; tenant filtering happens at the API + daily-pack layer (kept narrow on purpose so SSE stream stays cheap).

**Daily PnL packs.** `var/daily_packs/<tenant>/<date>.json` for non-default tenants; `var/daily_packs/<date>.json` for the default tenant (legacy flat path). Pin metadata + audit payloads carry `tenant_id` so the verifier can scope per fork. See [`daily_pack.py`](./daily_pack.py).

**Audit log.** Every state-changing event carries `tenant_id` in the payload. Pre-Bucket-6 events surface as `default`.

---

## API surface

| Endpoint | Tenant behavior |
|---|---|
| `POST /api/execution/open` | Reads `body.tenant_id` (defaults to `default`). `400` on unknown tenant, `403` on disallowed strategy, `422` on oversize. |
| `GET /api/execution/positions` | Optional `?tenant_id=` filter. `404` on unknown tenant so callers distinguish "no positions" from "no such tenant". |
| `GET /api/execution/tenants` | Snapshot of all configured tenants + per-tenant `open_positions` count. Used by the verifier dropdown. |
| `POST /api/execution/daily-pack/<date>/build` | Optional `?tenant_id=`. Audit event includes the tenant id. |
| `GET /api/execution/daily-pack/<date>` | Optional `?tenant_id=`. `404` hint includes the tenant in the build command. |
| `GET /verifier/<date>` | Default tenant (legacy URL). |
| `GET /verifier/<tenant>/<date>` | Tenant-scoped verifier. Tenant pill renders in the header; the dropdown lets operators switch tenants in-page. |

---

## Open / resolve flow

```bash
# Open a position under fund-a
curl -X POST http://127.0.0.1:5004/api/execution/open \
  -H 'content-type: application/json' \
  -d '{
    "position_id": "pos-001",
    "tenant_id":   "fund-a",
    "strategy":    "directional",
    "market_id":   "0x...",
    "token_id":    "...",
    "side":        "BUY",
    "usdc_amount": 15
  }'
# → 200 OK with body.tenant_id, body.burner_address, body.fund_tx, ...

# Try the same under fund-b (which only allows "arb")
# → 403 {"error":"tenant 'fund-b' does not allow strategy 'directional'", "allowed_strategies":["arb"]}

# Try fund-b with oversize
# → 422 {"error":"usdc_amount=10 exceeds tenant 'fund-b' per_position_max=5"}

# View positions for fund-a only
curl 'http://127.0.0.1:5004/api/execution/positions?tenant_id=fund-a'
```

---

## Daily verifiable PnL pack (per tenant)

```bash
# Build today's pack for fund-a
curl -X POST 'http://127.0.0.1:5004/api/execution/daily-pack/2026-04-19/build?tenant_id=fund-a'

# Read the cached pack
curl 'http://127.0.0.1:5004/api/execution/daily-pack/2026-04-19?tenant_id=fund-a'

# Public verifier page
open http://127.0.0.1:5004/verifier/fund-a/2026-04-19
```

The pack envelope (`meridian/daily-pack/v1`) carries `tenant_id`. Bytes are deterministic — `json.dumps(pack, sort_keys=True, separators=(",",":"))` — so the cached file is byte-equal to what gets pinned to 0G Storage. Anyone can re-verify by walking the audit log + position store and re-serialising.

---

## Forking checklist

1. Set `BURNER_SEED` to a fresh 32-byte hex string. **Do not reuse the upstream seed.** All tenants on this router share the same root seed; isolation comes from the per-tenant bytes in the keccak preimage.
2. Set `TENANTS=...` and one `TENANT_<ID>_*` block per tenant.
3. (Optional) `TENANT_<ID>_STRATEGIES` to whitelist strategies. Leave empty for permissive.
4. (Optional) `COGITO_PUBLIC_BASE_URL` if you want the verifier to render `DOWNLOAD` links for the 0G root hash.
5. Smoke: `services/.venv/bin/python services/execution_router/test_tenants_smoke.py` (9/9 PASS expected).
6. Boot the router. `GET /api/execution/health` should return your tenant ids in `wiring.tenants`.
7. Hit `/verifier/<your-tenant>/<today>` — the tenant pill should match.

That's it. You're a fund.
