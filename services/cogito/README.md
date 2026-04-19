# cogito — MERIDIAN's 0G anchor + inference sidecar

Tiny Hono+Bun service that wraps the TS-only SDKs we need from Python:

- **`@0gfoundation/0g-ts-sdk`** → 0G **Storage**: pins seed + simulation
  envelopes and serves them back by merkle root.
- **`@0glabs/0g-serving-broker`** → 0G **Compute** (DeAIOS): runs
  OpenAI-compatible chat completions through TeeML-verifiable providers
  with on-chain micropayments.
- **`@circle-fin/bridge-kit`** → Circle **CCTP V2** cross-chain USDC
  transfers (Arb Sepolia ↔ Polygon Amoy) via `POST /bridge`.
- **`cofhejs`** → Fhenix **CoFHE** sealed-input generation via
  `POST /fhe/encrypt` (mints real `InEuint128` payloads for the hook).

The Python `meridian_signal` + `execution_router` services call cogito
over `127.0.0.1:5003` because these SDKs are TypeScript / WASM-only.

## Layout

```
cogito/
├── src/
│   ├── index.ts          Hono app + middleware + routes
│   ├── zg.ts             ZgClient: upload(), download()  (0G Storage)
│   ├── compute.ts        ComputeClient: listServices(), inference(), ack/fund
│   ├── bridge.ts         createBridgeRoutes: POST /bridge (Circle CCTP V2)
│   └── fhe.ts            createFheRoutes:    POST /fhe/encrypt (cofhejs InEuint128)
├── package.json
└── tsconfig.json
```

## Prereqs

- Bun >= 1.3 (`brew install oven-sh/bun/bun`).
- A 0G Galileo testnet wallet **funded with testnet 0G** for upload gas.
  Faucet: https://faucet.0g.ai (verify URL — sponsor docs at
  `.context/meridian/sponsor-docs/0g.md`).
- Env vars in `meridian-core/.env`:
  | Var | Purpose |
  |---|---|
  | `ZG_RPC_URL` | `https://evmrpc-testnet.0g.ai` |
  | `ZG_INDEXER_URL` | `https://indexer-storage-testnet-turbo.0g.ai` |
  | `ZG_PRIVATE_KEY` | hex-encoded EVM private key of the funded wallet |
  | `COGITO_TOKEN` | shared bearer token (Python <-> Node localhost auth) |
  | `COGITO_PORT` | default `5003` |
  | `COGITO_HOST` | default `127.0.0.1` (do NOT bind 0.0.0.0) |
  | `TREASURY_PRIVATE_KEY` | (optional) enables `POST /bridge` — Arb Sepolia signer |
  | `FHE_PRIVATE_KEY` | (optional) enables `POST /fhe/encrypt`; falls back to `TREASURY_PRIVATE_KEY` |
  | `FHE_RPC_URL` | (optional) Arb Sepolia RPC for cofhejs; falls back to `ARB_SEPOLIA_RPC_URL` → `ZG_RPC_URL` |

## Boot

```bash
cd meridian-core/services/cogito
bun install
bun start         # foreground, prints signer address + listening port
bun run dev       # watch mode
```

## Endpoints

`GET /health` — public

```json
{
  "service": "cogito",
  "status": "ok",
  "signer": "0x…",
  "rpc": "https://evmrpc-testnet.0g.ai",
  "indexer": "https://indexer-storage-testnet-turbo.0g.ai"
}
```

`POST /upload` — bearer-token required

```bash
curl -sS -X POST http://127.0.0.1:5003/upload \
  -H "Authorization: Bearer $COGITO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"kind":"seed","payload":{"market_id":"0x…","seed_doc":"..."},"meta":{"run_id":"abc"}}'
# → {"root_hash":"0x…","tx_hash":"0x…","size_bytes":4231,"kind":"seed"}
```

`GET /download/<root_hash>` — bearer-token required, returns the original
JSON envelope wrapped under `{schema, kind, pinned_at, meta, payload}`.

### 0G Compute (DeAIOS)

All require bearer auth.

| Route | Purpose |
|---|---|
| `GET  /compute/services` | list on-chain providers (model, price, verifiability) |
| `GET  /compute/account`  | ledger snapshot for cogito's signer |
| `POST /compute/account/setup`  `{ amount }` | addLedger (min 3 OG per SDK v0.6.x) |
| `POST /compute/provider/ack`   `{ provider }` | acknowledge a provider (1× per provider) |
| `POST /compute/provider/fund`  `{ provider, amount }` | transferFund → sub-account (min 1 OG per provider) |
| `POST /compute/inference`      `{ model?, provider?, messages, temperature?, max_tokens? }` | OpenAI-style chat → `{ content, model, provider, chat_id, valid }` where `valid` is the TeeML-signature verification result |

One-time setup (per wallet, per testnet):

```bash
# 1. fund the ledger
curl -sS -X POST http://127.0.0.1:5003/compute/account/setup \
  -H "Authorization: Bearer $COGITO_TOKEN" -H "Content-Type: application/json" \
  -d '{"amount": 3.0}'

# 2. ack + fund a single provider (gpt-oss-20b testnet)
curl -sS -X POST http://127.0.0.1:5003/compute/provider/ack \
  -H "Authorization: Bearer $COGITO_TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"0x8e60d466FD16798Bec4868aa4CE38586D5590049"}'

curl -sS -X POST http://127.0.0.1:5003/compute/provider/fund \
  -H "Authorization: Bearer $COGITO_TOKEN" -H "Content-Type: application/json" \
  -d '{"provider":"0x8e60d466FD16798Bec4868aa4CE38586D5590049","amount":1.0}'
```

Then inference works:

```bash
curl -sS -X POST http://127.0.0.1:5003/compute/inference \
  -H "Authorization: Bearer $COGITO_TOKEN" -H "Content-Type: application/json" \
  -d '{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"ping"}]}'
```

To route the Python swarm through 0G Compute, set `LLM_PROVIDER=0g` in
`meridian-core/.env`. The signal gateway will call
`/compute/inference` instead of OpenAI.

### Fhenix CoFHE (`POST /fhe/encrypt`)

Mints a real `InEuint128` sealed input for the `PrivateSettlementHook` on
Arbitrum Sepolia. The Python execution-router (`encryptor.CogitoEncryptor`)
posts here for `fundBurner` and `markResolved`.

Request:

```json
{
  "value": "1000000",                                   // decimal uint128 (USDC micros etc.)
  "sender": "0xabc...",                                 // must equal cogito's FHE signer
  "utype": 6,                                           // optional; FheTypes.Uint128
  "security_zone": 0                                    // optional
}
```

Response (matches Solidity `InEuint128(uint256,uint8,uint8,bytes)`):

```json
{ "ctHash": "0x…", "securityZone": 0, "utype": 6, "signature": "0x…" }
```

The route is `503 offline` until both `FHE_PRIVATE_KEY` (or
`TREASURY_PRIVATE_KEY`) and an Arb Sepolia RPC are configured.
`sender` must match the cofhejs signer address — CoFHE binds the sealed
input to the prover; a mismatch reverts on-chain.

### Circle Bridge Kit (`POST /bridge`)

Server-signed CCTP V2 USDC transfer. Used by the Python execution-router
to move USDC Arb Sepolia ↔ Polygon Amoy around each position (see
`services/execution_router/bridge_client.py`).

## Security

- **Bound to `127.0.0.1` only.** Never expose publicly — the bearer token
  is shared symmetric and Bun is not ratelimited at the kernel.
- Bearer token verified in constant time.
- 1 MB body cap (`COGITO_MAX_BODY_BYTES`).
- 60 req/min total cap (`COGITO_RATE_LIMIT_PER_MIN`).
- `secureHeaders()` on every response.

## Failure mode

The Python signal-gateway **degrades gracefully** if cogito is down:
`/api/signal/run` returns `seed_hash_0g: null` and
`simulation_hash_0g: null` instead of failing. So a hackathon-time RPC
or wallet-funding outage does not bring the swarm offline.
