# AGENTS.md — Prediction Market Trader Workspace (MiroShark integration)

## Workspace Layout

```
workspace/
  SOUL.md        # Trader principles + confirmation format (still load-bearing)
  AGENTS.md      # This file — workspace conventions
  MIROSHARK.md   # ⭐ READ FIRST — overrides MoonPay-only execution from SOUL.md
  IDENTITY.md    # Your name and persona
  TOOLS.md       # CLI + HTTP environment
  BOOTSTRAP.md   # First-run setup (delete after setup)
  HEARTBEAT.md   # Periodic check-in config
  USER.md        # About Tomas (your operator)
  MEMORY.md      # Long-term memory (create when needed)
  memory/        # Session logs (create when needed)
  book.md        # Open positions and running thesis
  skills/        # Cookbook files
    miroshark.md            # Every MiroShark endpoint + curl + JSON shapes
    moonpay-auth.md         # MoonPay login (still used for discovery)
    moonpay-prediction-market.md  # Discovery only — buy/sell paths deprecated for MiroShark
    moonpay-buy-crypto.md   # Fiat onramp via MoonPay (`mp buy`)
    moonpay-check-wallet.md # Wallet balance helper
```

## ⭐ MiroShark mode (canonical)

This agent operates inside MiroShark — a confidential prediction-market hedge fund. **Read `MIROSHARK.md` and `skills/miroshark.md` before any execution.** Trades route through `POST $MIROSHARK_EXECUTION_URL/api/execution/open`, NOT through `mp prediction-market position buy`. The MoonPay-only execution paths in SOUL.md are deprecated for this workspace; SOUL.md's *thesis discipline + confirmation format* still apply, but the actual buy/sell call is replaced.

### What stays MoonPay
- **Discovery** — `mp prediction-market market trending list / search / event retrieve` are still your fastest read-only path to find candidates.
- **Onramp** — `mp buy --token usdc_polygon` is how Tomas funds the treasury (the operator UI exposes this as the "Fund via MoonPay" button).
- **Auth + wallet management** — `mp login`, `mp wallet list` for the agent's MoonPay session.

### What moves to MiroShark
- **Thesis** — `POST $MIROSHARK_SIGNAL_URL/api/signal/run` for the AXL-swarm consensus on a candidate market. Lead every trade card with this verdict, not your own LLM read.
- **Execution** — `POST $MIROSHARK_EXECUTION_URL/api/execution/open`. Routes through per-position burner EOA + Circle Gateway bridge + Fhenix CoFHE-encrypted size + Polymarket CLOB.
- **Book monitoring** — `GET $MIROSHARK_EXECUTION_URL/api/execution/positions`, `/audit/<id>`, `/positions/stream` (SSE).
- **Resolve** — `POST $MIROSHARK_EXECUTION_URL/api/execution/resolve`. Bridges proceeds back, `markResolved` + `settle` on the hook, updates audit.

## Workflow

1. Build runs `setup.sh` — installs the MoonPay CLI (still needed for discovery + onramp)
2. The agent operates via conversation + heartbeat + Telegram (`@miro_shark_bot`)
3. All position entries and exits require explicit user confirmation
4. All execution flows through MiroShark — see MIROSHARK.md + skills/miroshark.md

## Memory

- Create `book.md` to track open positions: `position_id` (MiroShark), thesis, entry, size, audit-event count, status
- Create `MEMORY.md` for market notes, resolved positions, and patterns
- Create `memory/YYYY-MM-DD.md` for daily trade logs (mention which MiroShark `position_id` each trade became)
- Update `book.md` on every state transition (read from `/api/execution/positions/stream` if subscribed, else poll on heartbeat)

## Conventions

- Never place a trade without showing the full confirmation format from `skills/miroshark.md` (which extends SOUL.md with the privacy + settlement-rail rows)
- Every trade is identified by its MiroShark `position_id` — use that as the canonical id, not the CLOB order id
- Track every trade in `book.md` — `position_id`, thesis, entry, size, swarm verdict from `/signal/run`, audit-event-count, target exit
- When a market resolves, call `/api/execution/resolve` (don't `mp position redeem`) — that fires the bridge back + settle on the hook
- When `MIROSHARK_API_TOKEN` is unset or wrong → 401 — stop, tell Tomas, do NOT fall back to `mp position buy`
- When `DEMO_REQUIRE_REAL=1` returns 503 → stop, relay blockers verbatim — do NOT fall back to `mp position buy`
