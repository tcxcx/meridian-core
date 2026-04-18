# LESSONS.md — running log of gotchas, tech debt, and resolved-the-hard-way

Append-only. Newest at top.

---

## 2026-04-18 — 0G Galileo testnet faucet outage (UNRESOLVED, blocks Phase 3 e2e)

**What:** `https://faucet.0g.ai` not currently distributing testnet OG. Phase 3
cogito sidecar (`services/cogito/`) is fully implemented and typechecks
clean, but the end-to-end smoke test that proves the full flow can't run
without a funded `ZG_PRIVATE_KEY`.

**Surface area:**
- `services/cogito/src/zg.ts` — Storage `upload()` / `download()` (needs gas to register merkle root on-chain)
- `services/cogito/src/compute.ts` — Compute requires:
  1. `addLedger(>= 3 OG)` once per wallet
  2. `acknowledgeProviderSigner(provider)` once per provider
  3. `transferFund(provider, >= 1 OG)` once per provider
- `services/meridian_signal/api.py` — `/api/signal/run` calls `cogito.upload` for both seed + simulation; falls back to `null` hashes on failure (proven), so the path is non-blocking for higher phases.

**Why we shipped anyway:** Graceful-degradation path is exercised. Code review and typecheck cover the static contract. The on-chain proof can land later as a single PR once funded.

**To unblock when faucet returns:**
1. Drop funded private key into `meridian-core/.env` as `ZG_PRIVATE_KEY=0x…`
2. `cd services/cogito && bun start` — confirm signer address printed
3. `curl -sS http://127.0.0.1:5003/health` — should show signer + capabilities
4. Run setup curls in `services/cogito/README.md` (one-time per wallet)
5. Hit `/api/signal/run` with any market_id — `seed_hash_0g`, `simulation_hash_0g` should populate (no longer `null`)
6. Optionally toggle `LLM_PROVIDER=0g` and re-run to prove the inference path

**Blast radius if not unblocked by submission:** 0G prize track loses the
"live on-chain hashes in demo" demo bar. Submission-form framing should
emphasize the architectural integration (two SDKs, one sidecar, security
middleware) and link to the cogito README for the curl-replayable flow.

---

## 2026-04-18 — AXL `/recv` is one-shot per node (RESOLVED)

**What:** Yggdrasil-routed AXL `/recv` returns each message exactly once
*per node*, not per agent. With multiple agents per node, the first agent
to call `drain()` consumes everyone else's beliefs.

**Fix:** `services/swarm_runner/agent.py:NodeInbox` — per-node shared cache
behind a lock. All agents on a node read from the cache, only one drains
from AXL.

---

## 2026-04-18 — AXL `X-From-Peer-Id` is Yggdrasil routing ID, not pubkey (RESOLVED)

**What:** AXL signs messages with the Yggdrasil routing ID (first 16 hex
chars of the ed25519 pubkey, then routing-derived suffix), not the raw
pubkey. Naive equality checks against pubkey fail.

**Fix:** Compare by 16-char prefix in `test_cross_node.py` and
`axl_client.all_peer_ids()`.

---

## 2026-04-18 — AXL `/send` only sees 1 peer for spokes during tree-convergence (RESOLVED)

**What:** Spanning-tree convergence is async; if you broadcast immediately
after mesh boot, peers' topology view is incomplete. Spokes only see the
hub.

**Fix:** Orchestrator injects a `known_peers` roster into each `AxlClient`.
`all_peer_ids()` unions topology + tree + injected. Bypasses convergence
window for the hackathon mesh.
