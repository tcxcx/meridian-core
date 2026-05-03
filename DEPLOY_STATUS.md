# MiroShark deploy status — hackathon demo

## Live URLs

| Surface | URL | Status |
|---|---|---|
| **Operator terminal** (Vercel) | https://miroshark-app.vercel.app | 🟢 200 OK |
| ENS subname (Sepolia) | https://sepolia.app.ens.domains/miroshark.eth | 🟢 owned by 0x0646…EC69 |
| Tenant subname FUND-A | https://sepolia.app.ens.domains/fund-a.miroshark.eth | 🟢 minted |
| Tenant subname FUND-B | https://sepolia.app.ens.domains/fund-b.miroshark.eth | 🟢 minted |
| Agent subname | https://sepolia.app.ens.domains/xt1sgi73.miroshark.eth | 🟢 minted |
| Cloudflare Tunnel | execution.miro-shark.com / signal.miro-shark.com / cogito.miro-shark.com | 🟢 4 active connections |
| Pinata agent | https://app.pinata.cloud/agents/xt1sgi73 paired w/ @miro_shark_bot | 🟢 |
| Database | Neon Postgres (8 tables: operator_state + secret + waitlist + position + audit + swarm_run + treasury_transfer + fund) | 🟢 |

## Verified live

- **Circle DCW**: `POST /api/circle/execute` returns 502 with "API parameter invalid" for fake walletId — proves credentials authenticate, entity secret encrypts, SDK loaded
- **Circle wallet provisioning**: created 6+ Circle wallets this session (incl. `0xc78816…`, `0x715ac6…`, `0x74a23f3a…`, `0xe14c2d50…`)
- **ENS minting**: `circle-qa-d5e9.miroshark.eth` minted via Circle DCW address — 8 successful Sepolia txs
- **Bridge auth**: 401 unauthorized when bearer missing
- **Tunnel**: all 3 subdomains return 200 from health checks

## Demo path

1. Open https://miroshark-app.vercel.app → sign in with Google (Clerk)
2. Setup → Treasury step → "Provision first fund" → AddFundDialog mints fund + ENS subname
3. Open operator terminal → click `+ Add fund` in Agent ▾ popover → atomic Circle DCW + ENS provisioning
4. Telegram @miro_shark_bot → /status → reach-back via Cloudflare Tunnel
5. Watch swarm graph + DEBATE feed light up when running a market

## Env (set in Vercel production)

- 49 env keys synced from `apps/app/.env.local` to Vercel
- Includes: `CIRCLE_API_KEY` + `CIRCLE_ENTITY_SECRET` + `CIRCLE_BRIDGE_TOKEN` + `CIRCLE_WALLET_SET_ID`, ENS Sepolia config, Clerk auth, Pinata bot tokens, all Circle Modular Wallets keys

## Deploys

| Commit | Status | Time |
|---|---|---|
| `0a155a9` fix(vercel): correct turbo filter | 🟢 Ready | 39s |
| `7dcd6c1` fix(vercel): bun install for monorepo | 🔴 Error (filter mismatch) | 10s |
| `68ca574` feat: hackathon-ready | 🔴 Error (workspace:* via npm) | 4s |

## Known limits

- Vercel SSO protection blocks the direct `*-tcxcxs-projects.vercel.app` URLs — use the alias `miroshark-app.vercel.app` instead
- `/api/funds` requires Clerk session (browser auth flow); test via UI not curl
- Cogito storage signer Galileo balance currently low (faucet intermittent — known)
