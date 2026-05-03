# Sponsor integration depth — honest map

What's actually wired vs what's a stub or marketing claim. Tracks how each
sponsor's tech feeds the swarm + the autonomous Pinata operator.

Conventions for the **status** column:

- **Live** — code path runs in the demo, has tests or visible UI artifact, gated by env so dry-run is honest.
- **Read-side live** — we resolve / consume the sponsor surface. Mint / write side is design only.
- **Solidity-only** — the on-chain side is real (contracts compiled, tests pass), the JS package is a stub.
- **Stub** — package exists, no real code yet.

---

## ENS — Best ENS Integration for AI Agents · Most Creative Use ($5,000)

| | |
|---|---|
| **Status** | Live (read-side fully wired; mint-side scripted, awaits parent registration on Sepolia) |
| **Package** | [`packages/ens/index.js`](./packages/ens/index.js) (real, viem-based, ~180 LoC) |
| **API route** | [`apps/app/app/api/ens/resolve/route.js`](./apps/app/app/api/ens/resolve/route.js) (5-min in-memory cache) |
| **UI component** | [`apps/app/components/miroshark/ens-name.jsx`](./apps/app/components/miroshark/ens-name.jsx) |
| **Sepolia mint scripts** | [`apps/app/scripts/ens/check.mjs`](./apps/app/scripts/ens/check.mjs) (preflight, read-only) + [`apps/app/scripts/ens/register.mjs`](./apps/app/scripts/ens/register.mjs) (idempotent subname mint + text records) |
| **Circle DCW bridge** | [`apps/app/app/api/circle/execute/route.js`](./apps/app/app/api/circle/execute/route.js) (Next.js → Circle SDK) + [`services/_shared/circle_dcw.py`](./services/_shared/circle_dcw.py) (Python client) — Phase 2 lets the Python execution_router sign treasury → trading transfers via Circle DCW instead of TREASURY_PRIVATE_KEY when the source fund has `wallet_provider='circle-dcw'` |
| **Where it shows** | AGENT panel header (agent wallet), Treasury popover Address row, Agent popover Address row |
| **Env** | `ENS_NETWORK=mainnet\|sepolia`, `MAINNET_RPC_URL`, `SEPOLIA_RPC_URL`, `MIROSHARK_AGENT_ENS`, `MIROSHARK_TENANT_ENS_<TENANT>`, `MIROSHARK_PARENT_ENS_NAME`, `ENS_REGISTRAR_PRIVATE_KEY` |

**How ENS does real work for the agent:**

Each fund a user creates atomically gets its own ENS subname under the
platform parent (`miroshark.eth` on Sepolia). The flow lives in
[`apps/app/app/api/funds/route.js`](./apps/app/app/api/funds/route.js):
DB row → derive trading address from `BURNER_SEED` → mint subname →
set address record → write text records → mark active. The dialog at
[`apps/app/components/miroshark/add-fund-dialog.jsx`](./apps/app/components/miroshark/add-fund-dialog.jsx)
streams each step's tx hash live; judges click "+ Add fund" in the
operator terminal Agent ▾ popover and watch ENS provisioning happen
in real time. Same flow runs as a callout in the treasury onboarding
step so a brand-new user lands in the operator terminal with their
first fund + ENS already minted.

The autonomous Pinata trader (xt1sgi73) signs every position with the same
trading EOA. Without ENS that's an opaque address in the audit log. With
ENS, it resolves to `xt1sgi73.miroshark.eth` whose text records carry:

- `agent.skills` → `probe · swarm · open · settle` (mirrors the AGENT panel)
- `agent.template` → `Polymarket Trader`
- `org.telegram` → `@miro_shark_bot`
- `description` → human-readable summary

The same resolver runs across tenants: `fund-a.miroshark.eth` resolves to
the FUND-A trading wallet, `fund-b.miroshark.eth` to FUND-B's. Tenant
routing is read from text records — env-overridable via
`MIROSHARK_TENANT_ENS_FUND_A=fund-a.miroshark.eth`.

**Per-position subnames** (design, not minted yet): every settled position
mints `pos-{shortid}.miroshark.eth` pointing at the burner EOA, with text
records storing market_id, outcome, payout, settle_tx. Auditors resolve via
ENS, get a human-readable trail. Mint-side is gas + parent-name dependent —
currently shipping as a documented design with the read path live.

**Demo path:** open the operator terminal, hover any address in the
Treasury or Agent popover. If a `.eth` is bound, it renders as the primary
label with the address as tooltip; if not, it falls back to short hex.

---

## Uniswap Foundation — Best Uniswap API integration ($5,000)

| | |
|---|---|
| **Status** | Solidity-only (hook + tests live), JS package stub |
| **Contracts** | `contracts/src/PrivateSettlementHook.sol`, `contracts/src/HybridFHERC20.sol` |
| **Tests** | `contracts/test/PrivateSettlementHook.t.sol`, `HybridFHERC20.t.sol` (Foundry) |
| **JS package** | `packages/uniswap/package.json` is a stub — no JS-side wiring needed |
| **Where it runs** | Hook lives on Arb Sepolia; called by `services/execution_router/hook_client.py` for `fundBurner`, `markResolved`, `settle` |

**The wedge:** position size on Polymarket leaks. A serious desk that wants
to take real size telegraphs exactly how much they believe via the public
order book. MiroShark moves the size envelope behind a Uniswap v4 hook
(`PrivateSettlementHook`) that mints `fhUSDC` (`HybridFHERC20`) for
per-position burner EOAs. The hook accepts FHE-encrypted `InEuint128`
inputs, so the size is hidden even from the hook operator.

The hook is a real Uniswap v4 hook with `BeforeSwap`/`AfterSettle` flags,
not a generic vault. The submission framing is "Uniswap as the privacy
primitive for prediction-market sizing" — leverages v4's flexibility, doesn't
just wrap the swap router.

**Caveat:** the `@repo/uniswap` JavaScript package is a 1-line stub — the
on-chain side carries the integration. README updated to reflect this.

---

## Fhenix CoFHE — encrypted size on a Uniswap v4 hook

| | |
|---|---|
| **Status** | Live |
| **Surface** | `services/cogito/src/fhe.ts` exposes `POST /fhe/encrypt` |
| **Solidity** | Hook consumes `InEuint128` sealed inputs; `euint128` deltas inside |
| **Python wiring** | `services/execution_router/encryptor.py::SealedInput` maps cogito JSON → Solidity tuple |
| **Env** | `COGITO_BASE_URL`, `COGITO_TOKEN`, `FHE_PRIVATE_KEY` (or `TREASURY_PRIVATE_KEY`) |

The Uniswap hook (above) is the *surface*; Fhenix CoFHE is the *primitive*.
cogito server-side runs cofhejs, mints sealed `InEuint128` inputs, and
returns them as JSON to the Python router. Router decodes, calls
`fundBurner(InEuint128 sealed)` — chain accepts the ciphertext.

Dry-run path: `DryRunEncryptor` fakes the same JSON shape without calling
cogito. `DEMO_REQUIRE_REAL=1` blocks the dry-run path so demo failures
surface honestly instead of silently passing.

**Caveat (kept honest):** Fhenix CoFHE testnet only on Arb Sepolia, no
mainnet. The whole settlement chain choice is downstream of this constraint.

---

## 0G — Best Autonomous Agents, Swarms & iNFT Innovations ($7,500 + $7,500)

| | |
|---|---|
| **Status** | Live |
| **Storage** | `services/cogito/src/zg.ts` (227 LoC) — Indexer.upload + MerkleTree, signer pays gas, root pinned to Galileo testnet |
| **Compute** | `services/cogito/src/compute.ts` — TeeML-verifiable LLM inference, `LLM_PROVIDER=0g` toggles it for the swarm |
| **Helpers** | `packages/zero-g/index.js` (227 LoC) — viem chain config + funding/health utilities |
| **UI surface** | Header `0G` health dot + Treasury → Settled position rows show pin root |

Every swarm run pins two artifacts to 0G Storage by merkle root:
1. **Seed doc** — the prompt the swarm saw (microstructure + correlations + cryo)
2. **Simulation envelope** — the consensus + reasoning + per-agent beliefs

Each pin is tx-anchored on Galileo so a third party can pull bytes by root
and verify the swarm's input + output against what the platform claims.

For the **agent framework** prize track: the swarm runner orchestrates 21
agents (3 nodes × 7 agents) over 2 gossip rounds with disagreement-aware
aggregation (`agreement_score`, soft-cap on confidence when split > 0.30,
minority report when L1 distance ≥ 0.20 + confidence ≥ 0.5). The Tetlock
superforecaster system prompt + persona specialization (politics / finance /
crypto / news / general) is documented in `README.md` as a verbatim block.

**Known issue (kept honest):** Galileo storage signer goes broke quickly
(faucet intermittent). `cogito/src/zg.ts` `isContractRevert()` detection
catches CALL_EXCEPTION on storage fee revert and surfaces a structured
error with current balance + faucet hint. The `0G` health dot in the lean
header turns amber when balance < 0.01 OG.

---

## KeeperHub — Best Use of KeeperHub ($4,500)

| | |
|---|---|
| **Status** | Live |
| **Client** | `services/execution_router/keeperhub.py` (~200 LoC, full Direct Execution API) |
| **Wired into** | `hook_client.fundBurner`, `markResolved`, `settle`, treasury bridge sends |
| **Env** | `KEEPERHUB_API_KEY`, `KEEPERHUB_NETWORK` |
| **Smoke test** | `services/execution_router/scripts/smoke_keeperhub.py` |

When `KEEPERHUB_API_KEY` is set, every on-chain tx the router sends routes
through KeeperHub Direct Execution (managed gas, retries, nonce
coordination, `executionId` per tx). Falls back to direct web3 sends when
unset (dev / dry-run).

Audit log captures `execution_id` per tx — surfaces in the operator
terminal Position card timeline as `keeper {execution_id}`.

**Builder feedback bounty angle:** the docs were missing a clear example of
EIP-1559 priority-fee override. Worked around by setting
`DEFAULT_GAS_LIMIT_MULTIPLIER=1.2`. Will file a `FEEDBACK.md` in submission
covering: (a) docs gap on priority fee, (b) confused error when network
slug is wrong (returns 200 with unhelpful body), (c) requesting a
`/executions?status=pending` filter so operators don't poll every id.

**Caveat:** the `@repo/keeperhub` JavaScript package is a 1-line stub. All
real wiring is in the Python execution router. Honest README updated.

---

## Polymarket — venue (not a sponsor track here, but the trading rail)

| | |
|---|---|
| **Status** | Live (Polygon Amoy testnet) |
| **Client** | `services/execution_router/clob_client.py` |
| **Burner flow** | Per-position EOA derived as `keccak(BURNER_SEED ‖ tenant ‖ strategy ‖ position_id)` |
| **Caveat** | Polymarket CLOB is mainnet-only (chain 137). Our Amoy path is dev/testing — hence `DEMO_REQUIRE_REAL` flag for honest demo gating. |

---

## Gensyn AXL — multi-agent mesh (bonus track)

| | |
|---|---|
| **Status** | Live |
| **Runner** | `services/swarm_runner/orchestrator.py` — `run_axl_swarm()` + `stream_axl_swarm()` |
| **Mesh** | `services/swarm_runner/nodes.py` + `axl_client.py` |
| **Default config** | 3 nodes × 7 agents/node = 21 agents · 2 gossip rounds |
| **Toggle** | `SWARM_BACKEND=axl` (vs `single` for one-shot fallback) |

Each agent runs the same Tetlock-style system prompt with a persona lens
(politics / finance / crypto / news / general) routed by market category.
After a per-node round, agents gossip beliefs over `/recv` peer endpoints
and re-ground in round 2. Aggregation uses pairwise L1 distance for the
agreement score; soft-cap on confidence above 0.30 distance.

---

## Pinata Cloud — AI agent operator

| | |
|---|---|
| **Status** | Live |
| **Agent** | `xt1sgi73` (Polymarket Trader template) paired with `@miro_shark_bot` Telegram |
| **Tunnel** | Cloudflare Tunnel on `miro-shark.com` (3 subdomains: execution., signal., cogito.) |
| **Auth** | `MIROSHARK_AGENT_TOKEN` bearer on tunneled execution-router + signal-gateway |
| **Workspace** | `apps/app/scripts/pinata-agent-overlay/` — MIROSHARK.md + skills/miroshark.md + AGENTS.md / SOUL.md / TOOLS.md / USER.md / manifest.json |
| **UI surface** | AGENT panel inside selected-market region; Pinata run-state pulse in Agent wallet popover |

The Pinata agent is a peer co-operator. It uses MiroShark verbs (probe ·
swarm · open · settle) over the bearer-authed tunnel to act on the same
markets queue + capital plane the human operator sees. The AGENT panel
mirrors `pinataConnector.runState` (running / paused / idle / error) and
surfaces the agent's decision (`open NO $25 per playbook` vs
`skip · edge below threshold`) using the same edge × confidence logic the
agent itself uses.

---

## Verifiable demo (for judges)

| Claim | How to verify |
|---|---|
| ENS resolution is real | Hover any wallet address in Treasury / Agent popover. Tooltip shows full address; if `.eth` registered, label shows ENS name. |
| Uniswap hook accepts encrypted size | `cd contracts && forge test -vvv` — 38 hook tests, all pass. |
| 0G pins are real | Header `0G` dot is green. `psql $DATABASE_URL -c "SELECT zg_root FROM miroshark_swarm_run ORDER BY ts DESC LIMIT 1"` returns a non-null root; resolve via 0G Galileo explorer. |
| KeeperHub routes txs | Set `KEEPERHUB_API_KEY`, run `python services/execution_router/scripts/smoke_keeperhub.py`. Audit `execution_id` lands in `miroshark_audit_event.payload`. |
| AXL swarm is multi-node | `SWARM_BACKEND=axl python -m swarm_runner.test_cross_node` — 3 node spawn + gossip log. |
| Pinata agent acts autonomously | Telegram `@miro_shark_bot` /status → response from agent xt1sgi73 calling `GET /api/execution/operator/status` over the bearer-authed tunnel. |
| Persistence works | Open lean canvas, run a position, refresh. Position + audit timeline reload from `miroshark_position` + `miroshark_audit_event` (Neon), not from the Python in-memory store. |

---

## Stubs that are honestly stubs

These exist as `@repo/<name>/index.js` with one-line `export const sponsor = '<name>'` declarations and nothing else. Listed so the README stops claiming otherwise.

- `@repo/uniswap` — Solidity is real, JS package is a placeholder slot
- `@repo/keeperhub` — Python client is real, JS package is a placeholder slot
- `@repo/pinata-agents` — overlay scripts are real (apps/app/scripts/), JS pkg is a placeholder

These don't impede the demo; they exist so future work can hang JS-side helpers off the canonical name.
