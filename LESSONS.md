# LESSONS.md — running log of gotchas, tech debt, and resolved-the-hard-way

Append-only. Newest at top.

---

## 2026-04-18 — cofhejs lives server-side; Python posts to cogito `/fhe/encrypt` (RESOLVED)

**What:** `PrivateSettlementHook.fundBurner(InEuint128 amount, ...)` needs a
real sealed input (`{ctHash, securityZone, utype, signature}`). cofhejs is
the only supported way to mint one, and it's a TypeScript + WASM library.
The execution-router is Python. Previous shim: `DryRunEncryptor` returned a
bogus payload that always reverts on-chain.

**Fix:** `services/cogito/src/fhe.ts` exposes `POST /fhe/encrypt` wrapping
`cofhejs.initializeWithEthers({environment: "TESTNET"})` + `cofhejs.encrypt([
Encryptable.uint128(v)])`. Python `CogitoEncryptor.encrypt_uint128()` posts
`{value, sender, utype}`, receives `{ctHash, securityZone, utype, signature}`
and parses it into `SealedInput` → Solidity `InEuint128(uint256,uint8,uint8,bytes)`.

**Caveat — sender binding:** CoFHE binds every sealed input to the *prover*
address (the cofhejs signer). The on-chain hook's `FHE.asEuint128()` verifies
against that signer. Our route therefore requires the Python-side `sender`
field to equal cogito's `FHE_PRIVATE_KEY` (or `TREASURY_PRIVATE_KEY` as
fallback) address; mismatch → 400 from the route, would otherwise revert.

**utype mismatch footgun:** cofhejs's `FheTypes.Uint128 = 6`. The old Python
`DryRunEncryptor` hardcoded `utype=8` (copy-pasted from a stale enum guess).
The route returns whatever cofhejs produces — don't hardcode the integer.

**Graceful degradation:** If `FHE_PRIVATE_KEY`+RPC aren't configured, the
route returns 503 and Python falls back to `DryRunEncryptor` so the offline
demo path still walks through every state transition.

**Init cost:** `cofhejs.initializeWithEthers` is expensive (downloads FHE
public keys + TFHE WASM). We cache the init promise; first request pays the
cost, subsequent requests share it.

---

## 2026-04-18 — Circle Bridge Kit beats Gateway for MERIDIAN's testnet route (RESOLVED)

**What:** Needed USDC crosschain between MERIDIAN's settlement chain (Arb
Sepolia, where the Fhenix CoFHE hook lives) and trading chain (Polygon Amoy,
Polymarket's only network). Initially spec'd Circle **Gateway** for the
unified-balance story — looks great on paper for a hedge fund.

**Why Gateway didn't fit:** Gateway testnet coverage does **not** include
either Arbitrum Sepolia or Polygon Amoy. The supported testnets are Eth
Sepolia, Base Sepolia, Avalanche Fuji, OP Sepolia, Unichain Sepolia, a few
newer chains, and Arc Testnet. None match our two required chains.

**What we switched to:** Circle **Bridge Kit** (`@circle-fin/bridge-kit` +
`@circle-fin/adapter-viem-v2`) which wraps CCTP V2 and DOES support both
`Arbitrum_Sepolia` and `Polygon_PoS_Amoy` on testnet. Single call per
transfer (`kit.bridge({ from, to, amount, recipient })`) — approve/burn/
fetchAttestation/mint all in one result object.

**Architecture:** Bridge Kit is TypeScript-only, so the integration lives in
`services/cogito/src/bridge.ts` as a `POST /bridge` Hono route behind the
same bearer-token auth as the 0G sidecar. The Python execution-router calls
it over localhost via `services/execution_router/bridge_client.py`. Keeps
one language per chain concern (Solidity+Python for the hook, TS for Circle
primitives) and reuses the cogito security posture.

**Flow per position:**
1. `/open`: `fundBurner` encrypted on Arb Sepolia → bridge treasury USDC →
   burner on Polygon Amoy (forwarded mint) → Polymarket CLOB buy.
2. `/resolve`: bridge burner proceeds back → treasury on Arb Sepolia →
   `markResolved` + `settle` encrypted.

**Forwarding Service** (`useForwarder: true`) is essential: cogito doesn't
need to hold a hot wallet on Polygon Amoy. Costs 0.20 USDC per non-Eth
destination which is fine at hackathon scale.

**Rule of thumb:** Before committing to Gateway, grep its supported-chain
table for *every* chain you actually need on testnet. Bridge Kit's CCTP V2
testnet footprint is broader — default to Bridge Kit unless you explicitly
need the unified-balance abstraction AND your chains all sit on Gateway.

---

## 2026-04-18 — Hook deploy target is Arb Sepolia, not Base Sepolia (RESOLVED)

**What:** Initial scaffolding assumed Base Sepolia because several hackathon
sponsor chains live there. But MERIDIAN specifically needs Fhenix CoFHE
coverage for the private-settlement hook, and Fhenix CoFHE testnet is on
Ethereum Sepolia + Arbitrum Sepolia only.

**Why Arb Sepolia wins over Eth Sepolia:** cheaper gas, faster blocks,
same CoFHE coverage, and CCTP V2 support via Bridge Kit. No functional
reason to pick Eth Sepolia for a hackathon demo.

**Surface migrated:**
- `contracts/script/DeployPrivateSettlement.s.sol` — comment + RPC env.
- `services/execution_router/hook_client.py` — prefers `ARB_SEPOLIA_RPC_URL`,
  still falls back to `BASE_SEPOLIA_RPC_URL` to avoid breaking stale `.env`.
- `services/execution_router/keeperhub.py` — default `KEEPERHUB_NETWORK`
  `84532` → `421614`.
- `services/execution_router/static/dashboard.html` — explorer URLs
  basescan → arbiscan + polygonscan (network-aware per tx).
- `services/README.md` — env table.

**Why not a breaking rename:** the `BASE_SEPOLIA_RPC_URL` fallback is a
soft-deprecation. If a developer has an old `.env` with the old name, the
router still wires up instead of silently going offline. Clean up in Phase 6.

---

## 2026-04-18 — CoFHE ciphertext ACL propagates per-contract, not per-user (RESOLVED)

**What:** `PrivateSettlementHook.fundBurner` passed an `euint128` (converted
from `InEuint128`) into `HybridFHERC20.transferFromEncrypted(...)`. Even
though the hook called `FHE.allowThis(amt)` and `FHE.allow(amt, treasury)`,
every test reverted with `ACLNotAllowed(ctHash, 0xF100)` — the fhUSDC
contract itself wasn't in the ACL.

**Why:** `FHE.asEuint128(InEuint128)` only grants transient ACL to
`msg.sender` of the verifyInput call (= the hook). The destination contract
that downstream receives the handle has to be explicitly allowed.

**Fix:** `FHE.allow(amt, address(fhToken))` before any external call that
passes the handle to another contract. Same pattern applies in `settle()`
for `positionPayout[positionId]`.

**Rule of thumb:** any time you hand an `euint*` to a *different contract*
via an external call, call `FHE.allow(handle, address(that_contract))`
first. `allowThis` is not enough — it only covers the emitting contract.

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
