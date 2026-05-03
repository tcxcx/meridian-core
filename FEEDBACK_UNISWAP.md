# Uniswap Trading API — Builder Feedback (MiroShark)

> Built against the Uniswap Trading API as the canonical swap rail for
> non-USDC inflows on the MiroShark treasury, plus as a router-of-last-resort
> when an agent closes a position into a token Polymarket can't settle in.
>
> Code: [`packages/uniswap/trading-api.js`](./packages/uniswap/trading-api.js),
> [`apps/app/app/api/uniswap/quote/route.js`](./apps/app/app/api/uniswap/quote/route.js),
> [`apps/app/app/api/uniswap/calldata/route.js`](./apps/app/app/api/uniswap/calldata/route.js).
>
> Filed for the Uniswap Trading API Builder Feedback bounty. Specific +
> actionable, written by the operator who actually wired it.

## Project context

MiroShark is a confidential autonomous prediction-market hedge fund. The
swarm trades Polymarket through per-position burner EOAs on Polygon, but
operator deposits arrive on whatever chain + token the user has handy
(MoonPay sends ETH on mainnet, agents collect profits in the asset of the
last rebalance, etc). Every one of those inflows has to become USDC on
Polygon before the next swarm tick can deploy it. Trading API is the
shortest path between "there's value sitting in the wrong shape" and
"there's USDC waiting in the burner queue."

We integrated read-side first: `getSwapQuote` and `buildSwapCalldata` are
exposed through bearer-gated Next.js routes (`/api/uniswap/quote`,
`/api/uniswap/calldata`) so both the Pinata-hosted agent and the Python
execution-router can quote against the same shared client without seeing
the API key. Execution itself goes through our existing rails — Circle
DCW for fund-scoped wallets, raw `eth_sendRawTransaction` for the
per-position burners — so every spend hits the same approval gate +
audit log + Telegram notification we already operate.

## What worked well

**REST shape is intuitive.** Three endpoints (`/check_approval`,
`/quote`, `/swap`), one mental model: ask, get, sign. We had a working
quote inside an hour, calldata inside two. The fact that `/swap` consumes
the exact `quote.quote` object from the previous call meant we did not
have to re-validate or re-resolve anything between the steps — the API
keeps the trade intent atomic. This matters when the agent is reasoning
about a swap proposal asynchronously: the quote payload is the canonical
record, and we can persist it to Postgres + 0G between operator review
and execution without re-quoting and getting a different route.

**Permit2 + Universal Router unification.** A single `to`/`data` payload
that the burner EOA submits is a real ergonomic win versus the old
"approve, then route, then settle" three-tx dance. For a fund that opens
and closes positions multiple times a day, fewer round-trips means lower
gas variance and lower latency between the swarm decision and the actual
fill. We didn't have to write our own approval-versus-permit branching;
the API hides it.

**`x-universal-router-version: 2.0` upgrade was painless.** We started
without the header, hit one route mismatch, added the header, never
touched it again. Many APIs gate breaking changes behind awkward URL
versioning. A request header that defaults to a stable behavior is the
right call.

**Quote latency is real and consistent.** Median ~250 ms from our Vercel
region to the gateway. We can confidently put `getSwapQuote` behind an
SSE stream that updates the operator's preview rail in near real time
without burning the rate-limit budget.

## What hurt and what we'd ask for

### 1. There is no official TypeScript / Node SDK

We had to write our own client (`packages/uniswap/trading-api.js`),
including the address regex, amount-string regex, retry/backoff for 429
and 5xx, AbortController-based timeout, and a token-symbol-to-address
catalogue scoped to the chains we actually trade (1, 137, 8453). All of
this is undifferentiated work. Every team integrating Trading API
re-implements the same 200 lines.

**Ask:** ship `@uniswap/trading-api-client` (TS, dual-export ESM+CJS) with:
- typed request/response objects per routing variant (CLASSIC, DUTCH_V2,
  PRIORITY, WRAP, UNWRAP, BRIDGE, …),
- built-in 429/5xx backoff,
- a `swapper` argument that accepts either a viem `Address` or a string,
- an opt-in token resolver that pulls from the official multi-chain token
  list rather than each integrator hardcoding addresses.

The skill at `~/.claude/plugins/cache/uniswap-ai/uniswap-trading/` is
excellent context for an LLM and got our integration most of the way
home, but it is not a substitute for a typed runtime.

### 2. `tokenInChainId`/`tokenOutChainId` must be **strings**

Subtle but real: passing `tokenInChainId: 1` (number) gets you a 200 with
a misrouted quote on some chains, and a 4xx on others. Passing
`tokenInChainId: "1"` works everywhere. We discovered this only because
the `routing` field came back `null` for a route that should have been
`CLASSIC`. The skill flags this in a callout — without that callout, we
would have shipped a broken build.

**Ask:** accept both forms in the API and coerce to string server-side,
or hard-fail with a clear error message (`"chainId must be passed as a
string"`) instead of silently returning a degraded route.

### 3. Error responses are coarse-grained

When `/quote` fails for a real reason (insufficient liquidity for the
requested size, unsupported pair on this chain, slippage above the
auto-slippage ceiling), the response is generic. We had to grep
`response.body` for substrings to decide whether to surface `"no route"`
versus `"price impact too high"` versus `"try a smaller size"` to the
operator.

**Ask:** add a top-level `errorCode` enum in the response envelope:
`INSUFFICIENT_LIQUIDITY`, `PAIR_NOT_SUPPORTED`, `AMOUNT_TOO_SMALL`,
`PRICE_IMPACT_EXCEEDED`, `CHAIN_NOT_SUPPORTED`, `RATE_LIMITED`. We can
already infer most of these from HTTP status + body, but a stable enum
means the entire integrator population can branch on it without parsing
prose.

### 4. Rate limits are undocumented at signup

We never hit them in development, but the docs do not state the
per-key request-per-second budget for `/quote`, and we did not see
`X-RateLimit-Remaining` headers. For a fund whose UI streams quotes
live as the operator drags a slippage slider, knowing the budget at
integration time is the difference between "stream every 200 ms" and
"debounce to 1 s." Either policy works — we just need to know which one.

**Ask:** publish the limits in the developer-portal API key dashboard
and emit `X-RateLimit-Limit` / `X-RateLimit-Remaining` /
`X-RateLimit-Reset` on every response.

### 5. Quote TTL + push expiry

A quote is good for ~30 seconds. Our async approval flow (swarm
proposes a swap, Telegram pings the operator, operator clicks Approve
on their phone 90 seconds later) means we re-quote on approval almost
every time. That's fine for a swap that's not racing the market, but
for a quote that's part of a multi-leg unwind (close Polymarket
position → swap USDC.e to USDC.native → bridge to mainnet → swap to
ETH) the cumulative re-quote cost compounds, and any leg can fail
mid-flight on price drift.

**Ask:** either let us request a "soft quote" with a longer TTL (60–
120 s) at the cost of a wider slippage envelope, or expose a websocket
`quote.expired` push so we can re-fetch immediately when a quote dies
instead of polling. The first option is what 80% of integrators want;
the second is the principled answer.

### 6. Testnet sandbox

Trading API is mainnet-first. We test the production swap rail by
sending real funds, which is fine for our team but kept us from putting
the swap path into the swarm's reinforcement loop (we don't want the
agent to learn-by-loss with real liquidity). A sandbox mode that
returns plausible quote shapes without on-chain execution would unlock
"agent self-tests swap math" cleanly. Even a flat 0.3 % spread + a
deterministic gas estimate would be enough.

**Ask:** add a `?mode=sandbox` query param (or a separate
`https://trade-api.gateway.uniswap.org/sandbox/v1` host) that returns
the same response shape with a clearly-faked `route` and a fixed gas
cost, so we can write end-to-end tests without spending mainnet capital.

### 7. Swapper-vs-recipient ergonomics

In MiroShark every position has its own burner EOA. The wallet that
holds the input token is *not* always the wallet we want to receive the
output. Today we work around this by transferring to the burner first,
then quoting with the burner as `swapper`. A `recipient` field on the
quote/swap payload would let us route directly to the destination
wallet in one tx, which is meaningfully cheaper for a fund that does
this dozens of times a day.

**Ask:** add an optional `recipient` field. Default to `swapper` for
backwards compat.

## What we'd build with the next version

A `swap.preview` SSE stream — open once, push-update the operator
preview rail any time route, gas, or output amount changes by >0.05 %.
This is what every modern trading UI wants and what the current REST
shape can technically support (the gateway sees the freshest route
information; the integrator just needs a cheap delivery channel). Every
team wires this differently right now; a first-party SSE/WS feed would
be a real moat for Trading API as the canonical AMM router.

## Overall

**8/10.** The Trading API is what every other AMM router should look
like. The REST design is correct, the latency is correct, the Permit2 +
Universal Router unification is correct. The gap is developer tooling
— a typed SDK, structured errors, and rate-limit transparency would
take it to a 10. We will keep using it.

— *Tomas Cordero, MiroShark / Bu Finance*
