# MERIDIAN

> **Confidential autonomous prediction-market hedge fund.** Multi-agent LLM swarm scans Polymarket, ranks markets by edge × confidence, and trades through per-position burner EOAs whose treasury funding flow is encrypted with FHE on a Uniswap v4 hook.

Forked from [`666ghj/MiroFish`](https://github.com/666ghj/MiroFish). The MiroFish swarm engine is the brain; everything in `services/`, `contracts/`, and the cross-chain settlement plumbing is MERIDIAN.

---

## Pitch

Polymarket trades are public. Position sizes leak. Copy-traders front-run. A serious desk that believes in a market for non-trivial size cannot trade it without telegraphing exactly how much they believe. MiroShark fixes that: encrypted sizing on a Fhenix CoFHE Uniswap v4 hook, fresh per-position burner EOAs, Circle Gateway crosschain settlement, Polymarket CLOB execution, all coordinated by a Gensyn AXL swarm and pinned to 0G Storage with a daily verifiable PnL pack anyone can audit. **Multi-tenant out of the box** — fork the kit and run your own confidential fund on the same rails.

Full pitch: [`docs/PITCH.md`](./docs/PITCH.md). 3-minute demo script: [`docs/demo-script.md`](./docs/demo-script.md).

## Architecture

See [`docs/arch.svg`](./docs/arch.svg) (rendered) or [`docs/arch.html`](./docs/arch.html) (interactive). Swimlanes: Off-chain (Python) · cogito sidecar (TS/Bun) · On-chain (Arb Sepolia + Polygon Amoy).

---

## Sponsor tracks (all four wired)

| Track | Surface |
|---|---|
| **Uniswap Foundation** | Custom v4 hook `PrivateSettlementHook` + `HybridFHERC20` (fhUSDC). 38/38 Foundry tests pass. Implements Fhenix's published *Private Prediction Market* case study end-to-end. |
| **Fhenix CoFHE** | `euint128` treasury → burner → treasury deltas. Real `InEuint128` sealed inputs minted via cofhejs server-side (`cogito /fhe/encrypt`). |
| **0G** | `cogito` sidecar wraps **0G Storage** (pins seed + simulation envelopes by merkle root) AND **0G Compute** (TeeML-verifiable LLM inference; `LLM_PROVIDER=0g` toggles it). |
| **KeeperHub** | Every hook tx (`fundBurner`, `markResolved`, `settle`) routes through KeeperHub Direct Execution API when `KEEPERHUB_API_KEY` is set. |
| **Gensyn AXL** *(bonus)* | 3-node Yggdrasil-routed multi-agent mesh; agents gossip beliefs over `/recv` per-node before consensus. `SWARM_BACKEND=axl` toggles it. |

## Chain topology

| Role | Chain | Why |
|---|---|---|
| **Settlement** — fhUSDC + `PrivateSettlementHook` + treasury custody | Arbitrum Sepolia (chainId `421614`, CCTP domain `3`) | Fhenix CoFHE testnet coverage; cheaper/faster than Eth Sepolia. |
| **Trading** — Polymarket CLOB + per-position burner EOAs | Polygon PoS Amoy (chainId `80002`, CCTP domain `7`) | Polymarket has always been Polygon-native (EOA flow, no deploy). |
| **Cross-chain** | Circle **Bridge Kit** (CCTP V2) — NOT Gateway. Gateway testnet doesn't cover either chain. | See [`LESSONS.md`](./LESSONS.md). |

## Position lifecycle

**`/open`:**
1. Derive burner EOA: `keccak(BURNER_SEED ‖ position_id)`.
2. `fundBurner(InEuint128 amount, address burner)` on Arb Sepolia hook (real cofhejs sealed input via `cogito /fhe/encrypt`).
3. Bridge USDC treasury (Arb Sepolia) → burner (Polygon Amoy) via Bridge Kit forwarder.
4. Submit Polymarket CLOB order signed by the burner key.

**`/resolve`:**
1. Bridge proceeds burner (Polygon Amoy) → treasury (Arb Sepolia).
2. `markResolved(position_id, payout)` encrypted on the hook.
3. `settle(position_id)` — encrypted credit to treasury.

The privacy property: an on-chain observer sees one anonymous burner EOA per position, no link back to the treasury, and the funding amount as an `euint128` handle. **The fund's positions are public; its capital allocation is private.**

---

## Quickstart

### Prereqs

- macOS or Linux.
- [`uv`](https://docs.astral.sh/uv/) (Python services) — `brew install uv`.
- [`bun`](https://bun.sh/) ≥ 1.3 (cogito sidecar) — `brew install oven-sh/bun/bun`.
- [`foundry`](https://book.getfoundry.sh/) (contracts) — `curl -L https://foundry.paradigm.xyz | bash && foundryup`.
- A funded **Arbitrum Sepolia** EOA (treasury) and an **Arbitrum Sepolia 0G Galileo** wallet (cogito signer). Faucets: [arb-sepolia](https://www.alchemy.com/faucets/arbitrum-sepolia), [0g](https://faucet.0g.ai) *(intermittent — see [LESSONS.md](./LESSONS.md))*, [polygon-amoy](https://faucet.polygon.technology/).

### One-shot demo

```bash
cp .env.example .env       # fill in keys + RPC URLs
make install               # uv sync + bun install + forge install
make demo                  # boots cogito (5003) + signal-gateway (5002) + execution-router (5004) + orchestrator (one tick)
```

Then open the operator dashboard at **http://127.0.0.1:5004/** and watch positions flow through `funding → bridged → open → resolving → settled`.

### Manual control

```bash
make cogito                # cogito sidecar (Bun, :5003)
make signal                # signal-gateway (Flask, :5002)
make execution             # execution-router (Flask, :5004) — also serves dashboard at /
make orchestrator-once     # single tick: scan → rank → open up to N positions
make orchestrator-loop     # daemon loop (interval = $ORCHESTRATOR_INTERVAL_S)
make orchestrator-dry      # daemon, log-only, never hits /open
make contracts-test        # forge test --via-ir (38/38)
make stop                  # kill any service started by `make demo`
```

### Graceful degradation

Every sidecar is optional and the upstream caller falls back:

| Missing | Fallback |
|---|---|
| `BURNER_SEED` | execution-router /open returns 500 (hard-required) |
| `MERIDIAN_HOOK_ADDRESS` / `ARB_SEPOLIA_RPC_URL` | offline mode — synthetic tx hashes, dashboard still walks the state machine |
| `COGITO_URL` | `DryRunEncryptor` + `DryRunBridgeClient` (chain submission would revert; useful for wiring tests) |
| `KEEPERHUB_API_KEY` | tx submitted directly by treasury EOA |
| `LLM_PROVIDER!=0g` | direct OpenAI; `seed_hash_0g` / `simulation_hash_0g` populate as `null` |
| AXL down | `SWARM_BACKEND=lite` → single-LLM stand-in |

This is a hackathon — graceful is the point. Demos still run when sponsors' testnets blip.

---

## Repo layout

```
meridian-core/
├── contracts/                Foundry. PrivateSettlementHook + HybridFHERC20 (fhUSDC).
│   └── script/               Deploy + pool-create + swap scripts.
├── services/
│   ├── meridian_signal/      Flask :5002 — Polymarket scanner + swarm gateway.
│   ├── swarm_runner/         3-node Gensyn AXL mesh (SWARM_BACKEND=axl).
│   ├── cogito/               Hono+Bun :5003 — wraps 0G Storage, 0G Compute, Bridge Kit, cofhejs.
│   ├── execution_router/     Flask :5004 — burner EOAs + bridge + CLOB + KeeperHub. Serves dashboard.
│   ├── orchestrator/         Autonomous CLI loop (`python -m orchestrator [once|dry|loop]`).
│   └── README.md             Full env table + per-service docs.
├── backend/                  Upstream MiroFish (Python). Don't modify; we sit beside it.
├── frontend/                 Upstream MiroFish (Node). Untouched in this branch.
├── .context/meridian/        Spec, build plan, sponsor docs (LLM context dir).
├── CLAUDE.md                 Agent-facing context (phase table, conventions).
├── LESSONS.md                Append-only running log of gotchas + rationale.
├── INJECTION_POINTS.md       Where MERIDIAN hooks into upstream MiroFish.
├── Makefile                  see Quickstart above.
└── .env.example              all required + optional env vars with safe placeholders.
```

Sponsor docs live at [`.context/meridian/sponsor-docs/`](./.context/meridian/sponsor-docs/) — one markdown per sponsor with the actual API/SDK we used.

---

## Tech debt

See [`LESSONS.md`](./LESSONS.md) for the running log. Active items:

- **0G Galileo testnet faucet outage** blocks the live `seed_hash_0g` demo bar. Code path is exercised via the graceful-`null` fallback. Re-test when faucet recovers.
- **`BASE_SEPOLIA_RPC_URL` soft-deprecation** — `hook_client` honors it as a fallback so old `.env`s don't silently go offline. Hard-rename in Phase 6.
- **cofhejs init cost** — first `/fhe/encrypt` call downloads FHE public keys + TFHE WASM. Cached after that.

## License

Forked from [666ghj/MiroFish](https://github.com/666ghj/MiroFish). MERIDIAN-specific code is MIT (see [`LICENSE`](./LICENSE)). Upstream attribution preserved in [`README-ZH.md`](./README-ZH.md).
