# MiroShark · Submission Pitch

> **A confidential autonomous prediction-market hedge fund, on a forkable terminal.**
> The fund's positions are public. Its capital allocation is private.

---

## The privacy gap

Polymarket is the most liquid prediction-market venue on the internet. Every order is a public on-chain event. Every wallet is a fingerprint. Position sizes leak. Copy-traders front-run. A serious desk that believes in a market for non-trivial size cannot trade it without telegraphing exactly how much they believe.

The status quo: trade smaller than your conviction, or eat the slippage from being copied.

That is the problem MiroShark fixes.

## What it does

MiroShark is two things in one repo:

1. **A confidential autonomous fund.** Multi-agent LLM swarm scans Polymarket, ranks markets by edge × confidence, sizes the position privately on Arbitrum Sepolia behind a Fhenix CoFHE hook, derives a fresh per-position burner EOA, bridges USDC via Circle Gateway, executes on the Polymarket CLOB, and unwinds in reverse on resolve.
2. **A terminal you can fork.** Multi-tenant Allocator, per-tenant burner namespace (`keccak(seed ‖ tenant_id ‖ strategy_id ‖ position_id)`), per-tenant daily verifiable PnL packs pinned to 0G Storage, public verifier page. Bring your own treasury, your own strategy whitelist, your own per-position cap. Run your own fund on the same rails.

The privacy property is the whole point: an on-chain observer sees one anonymous EOA per position, no link back to the treasury, and the funding amount as an `euint128` handle. The trade is visible. The size is not. The book is not. The portfolio is not.

## The stack (and why)

| Sponsor | What we use it for |
|---|---|
| **Fhenix CoFHE** (Uniswap v4 hook) | `PrivateSettlementHook` + `HybridFHERC20` (fhUSDC). Treasury → burner → treasury deltas all encrypted as `euint128`. Real `InEuint128` sealed inputs minted server-side via cofhejs. |
| **0G Storage + Compute** | Pin every swarm run, per-position attestation, and daily PnL pack to 0G by merkle root. TeeML-verifiable LLM inference when `LLM_PROVIDER=0g`. |
| **Circle Gateway** | Sub-500ms Arb Sepolia ↔ Polygon Amoy crosschain settlement. Treasury holds a unified balance; per-position the burner approves+deposits its payout into Polygon Amoy GatewayWallet on `/resolve`, signs a BurnIntent, and Forwarder mints on the destination. Cogito never holds destination-chain gas. |
| **KeeperHub** | Every hook tx (`fundBurner`, `markResolved`, `settle`) routes through KeeperHub Direct Execution when `KEEPERHUB_API_KEY` is set. Treasury key never hot-signs. |
| **Gensyn AXL** | 3-node Yggdrasil-routed multi-agent mesh. Agents gossip beliefs over `/recv` per-node before consensus. Toggleable via `SWARM_BACKEND=axl`. |

## What's shipped

- **Contracts:** `PrivateSettlementHook` + `HybridFHERC20`, 38/38 Foundry tests, deploy script for Arbitrum Sepolia (Fhenix CoFHE testnet).
- **Cogito sidecar** (Hono+Bun, `:5003`): wraps 0G Storage, 0G Compute, Circle Gateway (`/bridge` + `/bridge/deposit`), cofhejs (`/fhe/encrypt`). Bearer-auth, localhost-bound.
- **Execution router** (`:5004`): burner derivation, fund/bridge/order/resolve/settle pipeline, per-position pin to 0G, append-only audit log with secrets redacted, SSE position stream, multi-tenant Allocator gates (400/403/422 on unknown tenant / disallowed strategy / oversize).
- **Daily verifiable PnL pack** (`meridian/daily-pack/v1`): walks the audit log for the UTC date window, joins to position store, byte-deterministic JSON pinned to 0G, served at `/verifier/<tenant>/<date>`. 9/9 smokes.
- **Multi-tenant isolation** (Bucket 6): tenant registry from env, per-tenant burner namespace with `default` aliasing the prior layout (zero-migration for existing rows), per-tenant pack subdirs, tenant-scoped audit metadata. 9/9 smokes.
- **Operator dashboard** at `:5004/`: brutalist white + electric blue (`#0000FF`), JetBrains Mono, three-act journey (INTEL → DELIBERATION → EXECUTION), eleven-event proof-of-execution timeline per position.

## Who it's for

- **Funds** that want to trade prediction markets at conviction-level size without telegraphing.
- **Operators** who want to fork the kit and run their own confidential strategy on the same primitives.
- **Compliance** that wants the receipt: every state-changing op recorded, redacted at the boundary, queryable per position, with daily attestations pinned to 0G that anyone can re-verify byte-for-byte.

## Demo

3-minute walkthrough script lives at [`docs/demo-script.md`](./demo-script.md). Architecture diagram at [`docs/arch.svg`](./arch.svg). One-shot demo:

```bash
cp .env.example .env && make install && make demo
open http://127.0.0.1:5004/
```

Watch positions flow through `funding → bridged → open → resolving → settled`. Click into any to see the burner address, the encrypted fund tx, the Gateway transferIds, the Polymarket order, and the eleven-event audit timeline.

## The bet

There is no confidential prediction-market infrastructure today. The pieces exist (FHE, ZK, MPC), but nobody has assembled them into a fund-grade execution stack with a forkable operator surface. MiroShark is that assembly: encrypted sizing on a Uniswap v4 hook, public-yet-pseudonymous trade execution, verifiable settlement, multi-tenant isolation, and a daily PnL receipt anyone can audit.

Confidential. Autonomous. Forkable. That's MiroShark.
