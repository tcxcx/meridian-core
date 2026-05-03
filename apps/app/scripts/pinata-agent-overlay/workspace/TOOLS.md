# TOOLS.md — Environment Notes

## MiroShark HTTP rail (primary)

You make trades via MiroShark, not via `mp position buy`. See `MIROSHARK.md` (briefing) and `skills/miroshark.md` (cookbook + curl examples).

### Required secrets
| Secret | What it is |
|---|---|
| `MIROSHARK_SIGNAL_URL` | Public URL (ngrok) of the signal-gateway (`:5002` locally) |
| `MIROSHARK_EXECUTION_URL` | Public URL (ngrok) of the execution-router (`:5004` locally) |
| `MIROSHARK_COGITO_URL` | Public URL of cogito (`:5003`) — usually you don't call this directly |
| `MIROSHARK_API_TOKEN` | Bearer token for the two services above. Required on every non-/health call. |
| `MIROSHARK_TENANT_ID` | Tomas's tenant id. Defaults to `default`. |

### Most-used endpoints (full list in skills/miroshark.md)
| Method + path | Purpose |
|---|---|
| `GET  /health` (signal + execution) | Liveness check. No auth. |
| `GET  /api/execution/operator/status` | Capital plane, sponsor readiness, kill switch, thresholds |
| `POST /api/signal/markets/scan` | Polymarket scan |
| `POST /api/signal/run` | AXL swarm thesis on one market — lead trade cards with this verdict |
| `POST /api/execution/open` | Place a position (canonical) |
| `GET  /api/execution/positions/<id>` | Poll status during the 60-120s bridge wait |
| `GET  /api/execution/audit/<id>` | Audit trail for one position — the demo backbone |
| `POST /api/execution/resolve` | Settle a position (`payout_usdc=0` is valid) |
| `GET  /api/execution/positions/stream` (SSE) | Live position deltas |

### Curl skeleton
```bash
curl -s -H "Authorization: Bearer $MIROSHARK_API_TOKEN" \
  "$MIROSHARK_EXECUTION_URL/api/execution/operator/status" | jq .
```

---

## MoonPay CLI

- **Binary:** `mp` (installed globally via `npm install -g @moonpay/cli`)
- **Version check:** `mp --version`
- **All tools:** `mp tools`
- **Help:** `mp <command> --help`
- **JSON output:** append `--json` to any command

## Key command groups

| Group | What it does | Status in MiroShark mode |
|-------|--------------|--------------------------|
| `mp prediction-market market` | Search, trending, event detail, price history | ✅ KEEP — discovery layer |
| `mp prediction-market position` | Buy, sell, list, redeem | ❌ DEPRECATED — use MiroShark `/api/execution/{open,resolve}` instead |
| `mp prediction-market pnl` | PnL summary | ❌ DEPRECATED — compute from MiroShark `/api/execution/positions` |
| `mp prediction-market trade` | Trade history | ❌ DEPRECATED — use MiroShark `/api/execution/audit` |
| `mp prediction-market user` | Register wallet with provider | ❌ N/A — MiroShark uses per-position burner EOAs derived from BURNER_SEED |
| `mp token balance` | Check USDC balance before trading | ✅ KEEP for the agent's MoonPay wallet (informational) |
| `mp buy` | Fund wallet with fiat (MoonPay onramp) | ✅ KEEP — this is the "Fund via MoonPay" UI button surface |
| `mp wallet` | Wallet management | ✅ KEEP for MoonPay-side wallet tasks |

## Providers

| Provider | Chain | Token | Min liquidity to trade |
|----------|-------|-------|----------------------|
| Polymarket | Polygon | USDC.e | $10K+ recommended |
| Kalshi | Solana | USDC | $10K+ recommended |

## Skills location

After build: `skills/` in the workspace root.

## Notes

Add environment-specific details here as you discover them:
- Registered wallet addresses per provider
- USDC balance thresholds for this user
- Preferred providers and position sizes
