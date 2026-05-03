# KeeperHub builder feedback — MiroShark integration

> Built against KeeperHub Direct Execution API + MCP, integrating into a Python
> Flask execution-router that mediates per-position burner EOAs across
> Arbitrum Sepolia (Fhenix CoFHE settlement) and Polygon Amoy (Polymarket
> CLOB). Code: [`services/execution_router/keeperhub.py`](./services/execution_router/keeperhub.py).
> Smoke tests: [`services/execution_router/scripts/smoke_keeperhub.py`](./services/execution_router/scripts/smoke_keeperhub.py),
> [`sponsor_smoke_full.py`](./services/execution_router/scripts/sponsor_smoke_full.py),
> [`preflight.py`](./services/execution_router/scripts/preflight.py).
>
> Filed for the Builder Feedback Bounty ($250–$500). Specific + actionable.

## Summary

KeeperHub is the right primitive for what MiroShark is doing. Per-position
burners + multi-chain bridge txs + hook calls means we generate a *lot* of
small, async, retryable transactions where managed gas + nonce coordination
+ post-hoc auditability via `executionId` are valuable. We hit these pain
points during the hackathon and we'd hit them again next time. Listing
them in the order we encountered them.

---

## 1. Documentation gaps that cost us time

### 1a. EIP-1559 priority fee override is undocumented

**Where we got stuck.** Our hook calls on Arb Sepolia were getting stuck
in the mempool ~30% of the time during peak hackathon hours (Sun afternoon).
The default tip Direct Execution computed was below the network's effective
priority floor. Looking at the docs, we found `gasLimitMultiplier` and
`gasPriceMultiplier` but no clear way to set an explicit priority-fee
floor or override the EIP-1559 split.

**What we tried.** Cranking `gasPriceMultiplier` to 2.0, then 3.0. This
worked but burned ~3× the gas budget for what should have been a
priority-tip-only adjustment. Felt like the wrong knob.

**What we wished existed.**

```python
client.execute(
    contract=hook_address,
    function='settle(bytes32)',
    args=[position_id],
    eip1559={
        'maxFeePerGas': '50_gwei',
        'maxPriorityFeePerGas': '2_gwei',  # explicit, not multiplier
    },
)
```

Or document clearly that `gasPriceMultiplier` applies to both legs of
EIP-1559 and there's no tip-only knob — so users know to switch network
or pre-compute a higher base.

**Doc page that should mention this:** the API reference for the execute
endpoint at `/api` should have a worked example for "stuck tx, need
priority tip" since this is the most common operator failure mode.

### 1b. Network slug error UX returns 200 with unhelpful body

**Repro.**

```python
client = KeeperHubClient(api_key=KEY, network='arbitrum_sepolia')  # underscore wrong, should be hyphen
result = client.execute(...)  # → 200 OK, body says "execution queued" with executionId="0xinvalid…"
```

**What happens.** The API accepts the bad slug, returns a fake-looking
`executionId`, and the tx never actually runs. Polling
`/executions/{id}` returns 404, but you don't know why for ~5 minutes.

**What we wished happened.** Either:
1. Reject bad network slug at execute-time with a 400 + the valid slug list, or
2. Return the canonicalized network in the response body so callers can
   double-check. (`{ executionId, status, network: 'arbitrum-sepolia' }`)

We worked around with a startup-time `validateNetwork()` call against a
hardcoded slug allow-list in [`keeperhub.py:36`](./services/execution_router/keeperhub.py).
Real users without our error-paranoia would silently fail.

### 1c. MCP tool descriptions don't mention EIP-1559 fee fields

**Where.** The `keeperhub-execute` MCP tool's parameter schema lists
`gasPriceMultiplier` but not the network's expected fee semantics.
Pinata-Cloud-hosted agents we paired don't have `httpx`-level access; they
go through MCP. So the agent's mental model of how to retry a stuck
keeper tx is incomplete.

**Suggestion.** Add a one-line `description` field to the MCP tool's
`gasPriceMultiplier` parameter explaining "applies to both maxFeePerGas
and maxPriorityFeePerGas under EIP-1559; for tip-only adjustments, set X".
The MCP framework will surface the description into the agent's prompt.

---

## 2. Reproducible bugs

### 2a. `executionId` collisions across networks

**Repro.** Submit one execute on `arbitrum-sepolia` and one on
`polygon-amoy` within ~2 minutes. We observed two distinct executions
returning `executionId` strings that shared their first 12 hex characters
even though they targeted different contracts on different networks.

**Why this matters for us.** We log `executionId` to our audit trail
([`audit_event.payload->>'execution_id'`](./services/execution_router/audit.py))
and use it to correlate keeper tx → position. If two positions on different
chains return colliding short-prefix ids, our operator UI's
`shorten(execution_id, 12)` display showed the same string for two distinct
executions — confused us during the demo dry-run.

**Workaround.** Always print the full id in audit logs even when truncating
in UI. But upstream this is a randomness-source issue worth checking.

### 2b. `/executions?status=pending` filter not supported

**What we tried.**

```python
GET /executions?status=pending&network=polygon-amoy
```

Returns the same payload as the unfiltered list — `status` query
parameter is ignored without error. Status filtering is implemented
client-side (we pull the full list and filter in Python). For an operator
running 50+ concurrent positions this gets slow.

**What we wished.** Either reject the unknown query param with 400
(makes the bug obvious) or implement `status` + `network` filters
server-side. The list endpoint would benefit from `since=<timestamp>`
too — pagination by created-at would be welcome.

### 2c. Polling `/executions/{id}` directly after submit returns 404 for ~3-5s

**Repro.** Submit an execute, immediately (within 1s) GET
`/executions/{returned_id}`. Returns 404 with `{ "error": "not_found" }`
even though the same id will be valid 3-5 seconds later.

**What we wished.** During the propagation window, return 200 with
`{ status: 'queued', executionId, … }`. The 404 misled us into thinking
the submit had failed; we ended up adding a defensive 5s sleep before the
first status poll, which we wouldn't need.

---

## 3. Feature requests with concrete use cases

### 3a. Per-fund executor pools (multi-tenant SaaS)

**Use case.** MiroShark is multi-tenant by design — each "fund" (fund-a,
fund-b) has its own treasury wallet, trading wallet, and per-position
burner EOAs. Today we ship one `KEEPERHUB_API_KEY` for the whole router.
We'd love to scope keys per tenant so:

- Each fund's executions are billed/observable separately
- A misbehaving fund (loop of failing settle calls) can't exhaust the
  shared executor capacity
- Per-fund rate limits are enforceable

**What that might look like in API terms.**

```
POST /api/teams/{team}/executor-pools         { name, networks, rate_limit }
POST /api/executor-pools/{pool}/keys          → returns scoped api_key
GET  /api/executor-pools/{pool}/executions
```

This is the most natural scaling axis for a fund-of-funds use case and
probably for any SaaS using KeeperHub as its execution backend.

### 3b. Batch `executePack(...)` for atomic multi-tx submission

**Use case.** Our `/open` lifecycle today fires three sequential keeper
calls: `fundBurner` (Arb Sepolia hook) → `bridge.send` (Circle CCTP) →
`clob.placeOrder` (Polygon Amoy). We model this as 3 audit events with
3 different `executionId`s. If step 1 succeeds and step 2 fails, we have
half-funded burners floating around.

**What we wished.** A `POST /executions/pack` that takes an array of
calls + a "rollback semantics" hint (`fail-fast` | `best-effort`). Even
without on-chain atomicity (each call is on a different chain), KeeperHub
giving us a single `packId` that groups them + auto-pause-on-first-failure
would be a meaningful operator quality-of-life win.

### 3c. Webhook on terminal state instead of polling

**Today.** We poll `/executions/{id}` every 2s while a position is
in-flight. For multi-position runs that's a lot of HTTP.

**What we wished.** `POST /api/webhooks` that fires a callback when an
execution reaches a terminal state (success / failed / dropped). Same
shape as the polling response, just pushed. Saves us bandwidth and
reduces our own pulse-frequency on the audit table.

### 3d. `idempotencyKey` on execute

**Use case.** We retry on network errors. Today, a retry mid-flight can
double-submit if the first request's response was lost. We work around
with a client-side request hash + Postgres dedup. KeeperHub-side
`idempotencyKey` would let us retry safely without app-level dedup logic.

**API sketch.**

```python
client.execute(..., idempotency_key='miroshark-pos-abc123-fund-burner')
```

If two requests arrive with the same key within (say) 10 minutes, the
second returns the original `executionId` instead of submitting again.
Standard payment-API pattern; would be obvious + appreciated here.

---

## 4. UX friction points

### 4a. Dashboard executions list lacks position-id correlation

We tag every execute with a `metadata.position_id` field — the audit log
correlates keeper tx → MiroShark position. The KeeperHub dashboard
doesn't surface this metadata in the executions list. We have to copy
the executionId, paste into the dashboard URL, then drill in to see the
metadata.

**Suggestion.** Show `metadata.label` (or a configurable key) as a
column in the executions table. Trivial UX win.

### 4b. Free-tier rate limits aren't documented per-network

We hit a 429 during the hackathon and couldn't find documentation for
how many requests per minute the free tier allows on Arb Sepolia vs
Polygon Amoy. Had to guess and back off. A small "Rate limits" page in
docs covering free + paid tiers per network would have saved us 20
minutes of trial-and-error.

### 4c. The CLI doesn't support reading from stdin

We wanted to pipe a JSON tx descriptor into `keeperhub execute`:

```bash
cat tx.json | keeperhub execute --network polygon-amoy
```

Today the CLI requires every field as a flag, which gets unwieldy for
contract calls with multiple args. Standard `--from-file -` or piped
stdin support would make the CLI scriptable.

### 4d. Wallet-mode confusion between Direct Execution and managed wallets

We initially thought KeeperHub managed our signer keys. The docs make
clear that for Direct Execution we sign with our own keys and KeeperHub
just relays. But the wording on the homepage ("guaranteed onchain
execution") implied to us that signing was managed too. Spent ~30 min
exploring before realizing we needed to ship our private key context.

**Suggestion.** A one-liner under each product card: "Direct Execution:
you sign, KeeperHub relays + retries. Managed Wallets: KeeperHub
signs."

---

## 5. What we love

To balance the list — the things that worked great for us:

- **`executionId` per tx** is exactly the right primitive. We pin it
  into our audit log and the operator terminal surfaces `keeper {id}`
  inline; auditors trace tx → execution → keeper without digging.
- **Retry / nonce coordination** removed an entire class of bugs we'd
  hit before with raw `web3.send_transaction`. Mid-demo we had to
  restart our router three times and KeeperHub picked up where we left
  off without a single duplicate or missed nonce.
- **MCP server out of the box** is big. Our Pinata-Cloud-hosted agent
  (`xt1sgi73`) talks to KeeperHub through MCP, no glue code required.
  This pattern is going to matter a *lot* in the next 12 months.

---

## Suggested priority for v-next

If someone asked "what's the one fix that'd help builders most":
**`/executions?status=pending&network=...` server-side filtering**.
It's the smallest API change that unlocks the most operator-flow
improvements. Webhooks (3c) is the bigger architectural win but
filtering is the lower-hanging fruit.

---

*Filed by MiroShark team, Eth Cinco de Mayo 2026 hackathon. Happy to
discuss any of the above on Telegram (@CriptoPoeta) or open issues
against `keeperhub-docs`.*
