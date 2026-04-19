# Keys & accounts required to run MiroShark Terminal end-to-end

The graceful-degradation path lets you boot the dashboard, scan markets, and
run the swarm without any of these. To produce a fully-funded on-chain
demo (one open → bridge → CLOB → resolve → settle round-trip), all six
manual signups below have to be in `.env`.

Settlement chain: **Arbitrum Sepolia** (chainId `421614`).
Trading chain:    **Polygon PoS Amoy** (chainId `80002`).

| # | Sponsor / source | What you sign up for | `.env` keys it populates | Why we need it |
|---|------------------|----------------------|--------------------------|----------------|
| 1 | **Polymarket** (Privy) | Polymarket account → derive proxy wallet, fund it ≥1 USDC.e on Polygon | `POLYMARKET_API_KEY` (CLOB key from `apps.polymarket.com`); per-position burner EOAs are derived from `BURNER_SEED` and need 0.01 MATIC + USDC.e funding before `/api/execution/open` | Burner trades the actual outcome share on Polymarket CLOB. Without funding, `clob_client.submit_for_burner` returns a dry-run order id. |
| 2 | **KeeperHub** | Account at `app.keeperhub.com`, enable Arbitrum Sepolia, generate API key | `KEEPERHUB_API_KEY`, `KEEPERHUB_NETWORK=421614` | Wraps every `fundBurner` / `markResolved` / `settle` tx on Arb Sepolia so we get an `executionId` per call. Smoke proof: `make smoke-keeperhub`. |
| 3 | **0G (Galileo testnet)** | Galileo wallet, drip from `https://faucet.0g.ai` (≥3 OG ledger + 1 OG per provider) | `ZG_PRIVATE_KEY`, optionally override `ZG_RPC_URL` / `ZG_INDEXER_URL` | Pays gas for `cogito` Storage uploads (seed + simulation pins) and pre-funds the `/compute/account/setup` ledger so `/compute/inference` can route to a TeeML provider. |
| 4 | **LLM provider** | Either an OpenAI key OR `LLM_PROVIDER=0g` (re-uses #3) | `LLM_API_KEY`, `LLM_MODEL_NAME`, or `LLM_PROVIDER=0g` + `COGITO_LLM_MODEL` | Drives swarm-lite + swarm-axl agent reasoning. Without it, swarm runs hit the OpenAI API and fail loudly. |
| 5 | **Polygon Amoy faucet** | `https://faucet.polygon.technology/` (or Alchemy/Quicknode Amoy faucets) | (no `.env` key — funds the burner addresses) | Burners need MATIC for CLOB approve/order tx **and** for the per-position `approve` + `deposit` into Polygon Amoy GatewayWallet on `/resolve`. Treasury does NOT need Polygon MATIC — Circle's Forwarder mints destination USDC, so cogito never broadcasts on Polygon Amoy. |
| 6 | **Arbitrum Sepolia faucet** | `https://faucet.quicknode.com/arbitrum/sepolia` or Alchemy faucet | (funds `TREASURY_PRIVATE_KEY`) | Treasury pays gas for `fundBurner` / `markResolved` / `settle` on the hook (when KeeperHub is unset), the one-time `approve` + `deposit` into Arb Sepolia GatewayWallet, and the per-position Gateway BurnIntent submission for the outbound bridge (Arb Sepolia → Polygon Amoy). |

## Optional (already-deployed-once items)

These are not signups — they’re one-time-per-environment values you produce
yourself and stash in `.env`:

| Key | How to get it |
|-----|--------------|
| `BURNER_SEED` | `python -c "import secrets; print('0x'+secrets.token_hex(32))"` |
| `COGITO_TOKEN` | `python -c "import secrets; print(secrets.token_urlsafe(48))"` |
| `TREASURY_PRIVATE_KEY` | Generate a fresh testnet key (`cast wallet new`) and fund it from #6. **Do not reuse a mainnet key.** |
| `MERIDIAN_HOOK_ADDRESS` | `cd contracts && forge script script/DeployPrivateSettlement.s.sol --rpc-url $ARB_SEPOLIA_RPC_URL --broadcast` and read the address out of the broadcast log. |
| `FHE_PRIVATE_KEY` | Falls back to `TREASURY_PRIVATE_KEY` when blank. Override only if you want a separate FHE submitter. |

### One-time treasury Gateway deposit

Before the first `/api/execution/open`, the treasury must seed its Gateway
unified balance on Arb Sepolia (subsequent `/open` calls just spend it down):

```bash
curl -s -X POST http://127.0.0.1:5003/bridge/deposit \
  -H "Authorization: Bearer $COGITO_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"chain":"arbitrum_sepolia","amount":"50","signer":{"kind":"treasury"}}'
```

You only do this once per refill. Burner deposits on Polygon Amoy happen
automatically per-position inside `/api/execution/resolve`.

## Sanity check after wiring

```bash
make smoke-keeperhub                        # writes docs/proof/keeperhub.md
curl -s http://127.0.0.1:5002/health | jq   # zg_anchor.health.compute should be ok
curl -s http://127.0.0.1:5004/health | jq   # wiring.{hook,bridge,keeperhub} should all be true
```

If any of these surface `null` / `false`, the `.env` row tied to that
sponsor is the failing one — every wiring slot maps 1:1 to a row in the
table above.
