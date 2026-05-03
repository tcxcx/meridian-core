# SWARM_UPGRADE.md — Roadmap for the AXL prediction swarm

Living roadmap for upgrading MiroShark's swarm intelligence from "much
better than vanilla LLM ensemble" (where Phase 6 left it) to "true alpha —
better than a junior trader at a prop shop, then better than a senior one."

**Status legend:**

- ✅ **DONE** — shipped + commit hash
- 🟡 **NEXT** — current focus (or next-up after the in-progress UI polish)
- ⚪ **TIER 1/2/3** — researched, decided, awaiting build
- 🟣 **RESEARCH** — open question, decision pending

**Current operator focus:** UI + sponsor-integration polish (Phase 6c). All
items in this file are queued behind that pass and will land iteratively
on testnet until the swarm is "so good it's time to bring it live."

---

## Phase 6a baseline (shipped 2026-05-02)

What the swarm currently does — context for everything below:

- Tetlock 5-step methodology embedded in `agent.py:_SUPERFORECASTER_SYS`
- Rich seed_doc per `seed.py`: per-outcome order-book microstructure (E-01),
  correlated markets (T-03), cryo anomaly (C-02), resolution criteria
- Category-aware persona pool (politics / finance / crypto / general)
- Disagreement-aware aggregation: `confidence` (penalised) +
  `raw_confidence` + `agreement_score` + `minority_report`

Commits: `ad48267` (seed), `d21ffb2` (prompt + personas), `42f4e29` (aggregation),
`64ab1f3` (overlay sync), `4afb504` (docs).

Everything below is what comes AFTER this baseline.

---

## Tier 1 — Quick wins (~2-4h CC each, big lift)

### 1. ⚪ News + social signal injection

**Goal:** agents currently see static market metadata. They have zero
awareness of *what just happened in the world* relevant to the market.
Polymarket prices move minutes after a Reuters wire — the swarm should know
the wire exists. Largest single-step lift available.

**API decision:**

| Provider | Pricing | Latency | LLM-friendly? | Pick? |
|---|---|---|---|---|
| **Tavily Search API** | $0.01/query, 1k free/mo | <1s | yes — designed for LLM agents, returns clean snippets + sources | ✅ **primary** |
| **Perplexity API** | $5/1k queries | 1-3s | yes — returns RAG'd answers with citations | ✅ **secondary** for top-edge markets only |
| NewsAPI.org | $449/mo Business tier | <1s | OK, returns headlines + URL | ❌ pricing |
| Brave Search API | $5/1k via Goggles | <1s | OK, lower quality than Tavily for news | maybe later |
| Google News RSS | free | varies | poor — needs scraping per article | ❌ unreliable |
| Twitter/X API | $200/mo basic | <1s | yes but expensive for hackathon scope | ❌ defer |

**Default config**: Tavily for every market (~$0.01 each). Perplexity only
when `signal.run` candidate has `edge_pp ≥ 5.0` AND `confidence ≥ 0.65`
(roughly the top 5% of markets). Caches per-market for 60 min.

**Architecture:**

```
services/meridian_signal/news.py            (new, ~120 LoC)
  ┌─ fetch_market_news(market, *, lookback_h=24, deep=False) -> NewsBundle
  │    • extracts entities from market.question via simple keyword + NER
  │    • Tavily query: "{entity1} {entity2} prediction market" + lookback
  │    • dedupes by URL canonical form
  │    • caches in var/news_cache.db (SQLite, 60-min TTL)
  │    • when deep=True, also calls Perplexity for synthesis
  └─ NewsBundle = {items: [{title, source, ts, snippet, url}],
                   summary: str | None,  # only when deep=True
                   queried_at, cache_hit}

services/meridian_signal/seed.py             (extend)
  + accept news_bundle param; format as "## Recent context (N-01)" section

services/meridian_signal/api.py              (extend /run)
  + pre-fetch news_bundle BEFORE seed.build_seed_document, pass through
```

**Files touched:** new `news.py`, edit `seed.py`, edit `api.py`. ~150 LoC net.

**Cost model**: at 50 swarm runs/day default mode = $0.50/day Tavily +
~5 deep dives = $0.025 Perplexity. ~$15/mo all-in.

**Acceptance criteria:**

- `seed_doc` contains a `## Recent context (N-01)` section with 3-5 headlines for any news-eligible market
- Agent reasoning explicitly references at least one headline ~30% of the time on news-rich markets (politics + crypto + macro)
- Perplexity invoked only on the top-edge markets (cost-controlled)
- Cache hit rate > 70% on repeat scans of the same market within 60 min

---

### 2. ⚪ Whale position tracking

**Goal:** Polymarket positions are public on-chain. Insider buying often
precedes resolution news. The swarm should see "address `0xabc…` just bought
50k YES shares in the last 24h" as a first-class signal.

**API decision:**

| Source | Auth | Latency | Pros | Cons |
|---|---|---|---|---|
| **Polymarket Data API** (`data-api.polymarket.com/positions`, `/trades`, `/holders`) | none | <1s | free, official, JSON, paginated | rate limit unclear; testnet coverage unknown |
| **Polymarket subgraph** (The Graph) | API key | 1-2s | richer GraphQL queries, batch joins | requires Graph account, more complex |
| **Direct CTF (ERC-1155) on-chain query** via web3 | own RPC | 5-10s | most reliable, can't be deprecated | slow, paid RPC quota |

**Default config:** Polymarket Data API as primary. Subgraph as fallback for
historical or batch queries. Direct CTF query reserved for verification when
Data API returns suspicious data.

**Architecture:**

```
services/meridian_signal/whales.py           (new, ~150 LoC)
  ┌─ whale_flow(market_id, *, top_n=20, lookback_h=24) -> WhaleFlowReport
  │    • GET data-api.polymarket.com/positions?market=...&sortBy=size&limit={top_n}
  │    • for each holder, GET /trades?market=...&user=... since lookback_h
  │    • compute delta_24h per holder, group by side
  │    • caches in var/whale_cache.db (SQLite, 15-min TTL — moves fast)
  └─ WhaleFlowReport = {holders: [{address, side, total_usdc, delta_24h_usdc,
                                   first_seen, last_active}],
                        net_buying_pressure_24h_usdc: float,
                        cluster_score: float}  # 0..1, "how concentrated is the position?"

services/meridian_signal/seed.py             (extend)
  + accept whale_flow param; format as "## Whale flow (W-04)" section
    with trader's note: "insider buying often precedes resolution news;
    cross-reference with cryo flag."

services/meridian_signal/api.py              (extend /run)
  + pre-fetch whale_flow BEFORE seed.build_seed_document, pass through
```

**Files touched:** new `whales.py`, edit `seed.py`, edit `api.py`. ~180 LoC.

**Acceptance criteria:**

- `seed_doc` shows top-5 holders + 24h deltas for any market with > $5k liquidity
- `cluster_score` exposed in `/api/signal/run` response under `signals.whales`
- Trader's note tells agent how to interpret: high cluster_score + positive delta = potential insider buying
- Cache hits > 80% within 15-min window

---

### 3. ⚪ Multi-LLM diversity

**Goal:** all 21 agents currently call the same model (`LLM_MODEL_NAME`).
Different model architectures have different priors; ensemble forecasting
literature consistently shows 5-15% improvement when models are mixed vs
homogeneous. Easy structural win.

**API decision:**

| Approach | Pros | Cons |
|---|---|---|
| **OpenRouter** (single API for all major models) | one env var, one auth path, easy model rotation, includes open-source models | adds a hop (~50ms latency); their pricing has small markup |
| Direct OpenAI + Anthropic + Google + xAI | no markup, lowest latency | 4 env vars, 4 SDKs, 4 rate limits to manage |
| 0G Compute (existing cogito wiring) | TEE-attested inference | currently slower + smaller model selection; keep as `LLM_PROVIDER=0g` opt-in |

**Pick: OpenRouter as the orchestrator-side default; keep direct providers as
config option.** Each agent gets a model from `MIROSHARK_MODEL_POOL`
(comma-separated). Falls back to `LLM_MODEL_NAME` when pool unset.

Recommended starting pool (matched on quality + cost):

```
anthropic/claude-sonnet-4-5
openai/gpt-4o
google/gemini-2.0-flash-exp
x-ai/grok-3
meta-llama/llama-3.3-70b-instruct
```

5 models × ~4 agents each = 20 of 21 agents diversified. The 21st agent
stays on the operator's primary model for reproducibility on benchmarks.

**Architecture:**

```
services/swarm_runner/agent.py               (extend)
  + _MODEL_POOL = os.environ.get("MIROSHARK_MODEL_POOL", "").split(",")
  + _pick_model(agent_index) -> str
       - if MIROSHARK_MODEL_POOL set: round-robin via index
       - else: fallback to LLM_MODEL_NAME
  + _llm_forecast(*, model: str | None = None, ...)
       - new `model` param overrides env-default
  + run_agent: pass model=_pick_model(...) to _llm_forecast
  + log line includes the model that fired

services/swarm_runner/__init__.py            (new export)
  + supported_models() returns the resolved pool for /health surfacing

services/meridian_signal/api.py              (extend /health)
  + report wiring.swarm_model_pool: [...]
```

**Files touched:** mostly `agent.py`. ~80 LoC. Drop-in for OpenRouter — they
expose an OpenAI-compatible API so the existing `OpenAI(client)` wrapper
works with `base_url="https://openrouter.ai/api/v1"` + their API key.

**Cost model:** OpenRouter routes; pricing at ~$3-5/1M input tokens for
the pool above. With ~50 runs/day × 21 agents × ~2k tokens = 2.1M
tokens/day = ~$8/day model cost.

**Acceptance criteria:**

- `/health` shows `wiring.swarm_model_pool` populated when env var set
- Agent log lines show which model fired per agent
- Per-run telemetry exposes `models_used: [...]` so we can A/B vs
  single-model baseline
- Disagreement-aware aggregation surfaces split-by-model patterns
  (e.g. "Anthropic agents say YES, OpenAI says NO" — interesting
  signal in itself)

---

### 4. ⚪ Time-horizon-aware reasoning

**Goal:** markets resolving in 6 hours behave nothing like markets resolving
in 6 weeks. Current prompt treats them identically. 30-minute prompt edit
with measurable effect on calibration.

**API decision:** none — pure prompt engineering against `market.end_date_iso`
(already in seed_doc). No external dependency.

**Architecture:**

```
services/meridian_signal/seed.py             (extend)
  + compute hours_to_resolution = (parse(end_date_iso) - now).total_seconds() / 3600
  + prepend a "## Time horizon" line at top of seed_doc:
      "Resolves in {N} hours ({short|medium|long}-horizon)."
        short  = < 24h   → weight news + microstructure heavily
        medium = 24-168h → balanced; both news and base rates
        long   = > 168h  → weight base rates + macro; news is noise

services/swarm_runner/agent.py               (extend _SUPERFORECASTER_SYS)
  + new step in the methodology block:
      "0a. Read 'Resolves in N hours' at the top of seed_doc.
       - short-horizon: news + microstructure are primary signal,
         base rates are tiebreaker
       - long-horizon: base rates + macro are primary, news is noise.
         Weight your inside-view factors accordingly."
```

**Files touched:** `seed.py` + `agent.py`. ~30 LoC total.

**Acceptance criteria:**

- Every seed_doc shows `Resolves in N hours (short|medium|long-horizon)` at top
- Backtest on resolved markets shows lower MAE on short-horizon predictions
  vs pre-change baseline (post-Tier-2 calibration tracking will measure this directly)

---

## Tier 2 — Compounding (~1-2 days CC each, edge that grows over time)

### 5. ⚪ Calibration tracking + Brier-weighted aggregation

**Goal:** the single most impactful long-term upgrade. Log every belief vs
eventual resolution. After 50-100 resolved markets, you have per-persona
Brier scores. Re-weight aggregation by inverse Brier so historically-
calibrated agents pull more weight. **This is what makes the swarm get
smarter on its own.**

**API decision:**

| Source for ground-truth resolutions | Fit |
|---|---|
| **Polymarket Data API** `/markets/<id>` returns `resolved`, `resolutionWinner`, `resolvedAt` | ✅ **primary** — daily polling job |
| Polymarket subgraph | ✅ secondary — efficient batch queries for historical backfill |
| Polymarket on-chain CTF state | ⚠ verification only |

**Storage: new SQLite database** `services/swarm_runner/var/calibration.db`,
parallel to `audit.db`. Schema:

```sql
CREATE TABLE belief_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL,
  market_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  persona TEXT NOT NULL,            -- 'contrarian-quant', 'geopolitical', etc.
  model TEXT NOT NULL,              -- which LLM fired (Tier 1 #3 dependency)
  outcomes TEXT NOT NULL,           -- JSON array of outcome labels
  predicted_probs TEXT NOT NULL,    -- JSON array, parallel to outcomes
  confidence REAL NOT NULL,
  reasoning TEXT
);
CREATE INDEX idx_belief_market ON belief_log (market_id);
CREATE INDEX idx_belief_persona ON belief_log (persona, ts);

CREATE TABLE resolution_log (
  market_id TEXT PRIMARY KEY,
  resolved_outcome TEXT NOT NULL,   -- e.g. "YES" or "NO"
  resolved_outcome_idx INTEGER NOT NULL,
  resolved_at REAL NOT NULL,
  source TEXT NOT NULL              -- 'polymarket-data-api'
);

CREATE TABLE persona_calibration (
  persona TEXT NOT NULL,
  model TEXT NOT NULL,
  category TEXT NOT NULL,           -- politics / finance / crypto / general
  window_days INTEGER NOT NULL,
  brier_score REAL NOT NULL,        -- lower = better calibrated
  sample_size INTEGER NOT NULL,
  computed_at REAL NOT NULL,
  PRIMARY KEY (persona, model, category, window_days)
);
```

**Architecture:**

```
services/swarm_runner/calibration.py         (new, ~280 LoC)
  ┌─ record_belief(belief, market_id, persona, model)
  │    • called from orchestrator after each agent forecasts
  │    • appends to belief_log
  ├─ poll_resolutions(*, lookback_days=14)
  │    • daily background job
  │    • for each unique market_id in belief_log without a resolution_log row,
  │      query Polymarket Data API for resolution status
  │    • write to resolution_log when resolved
  ├─ compute_brier_scores(*, window_days=30)
  │    • for each (persona, model, category) tuple in last window_days,
  │      compute mean Brier score across resolved markets
  │    • upsert to persona_calibration
  ├─ persona_weight(persona, model, category, *, window_days=30) -> float
  │    • returns inverse Brier weight: 1.0 / (brier + 0.05)
  │    • returns 1.0 (neutral) when sample_size < 10 (cold start)
  └─ leaderboard(category=None, window_days=30) -> list[dict]
       • for /api/signal/calibration/leaderboard endpoint

services/swarm_runner/orchestrator.py        (extend _aggregate_beliefs)
  + accept calibration: PersonaCalibration | None param
  + when present, multiply each agent's confidence weight by
    calibration.persona_weight(persona, model, category)

services/orchestrator/                       (new task)
  + add daily "calibration_sweep" task scheduled 04:00 UTC:
      poll_resolutions() → compute_brier_scores()

apps/app/components/miroshark/operator-terminal.jsx  (new card)
  + small "Calibration leaderboard" rail card showing top-3 personas
    over last 30 days, by category. Updates when /api/signal/calibration
    endpoint returns new data.
```

**Files touched:** new `calibration.py`, edit `orchestrator.py`, new task
in `services/orchestrator/`, new endpoint, optional UI card. ~400 LoC.

**Dependencies:** Tier 1 #3 (multi-LLM diversity) wants to land first so
the per-model dimension of calibration is meaningful. Without it, every
calibration row has the same `model` value.

**Acceptance criteria:**

- After 50 resolved markets, `persona_calibration` table has at least one
  row per (persona, category) combination with `sample_size >= 10`
- Aggregation visibly diverges from naive mean — well-calibrated personas
  pull more weight in `/api/signal/run` consensus
- `/api/signal/calibration/leaderboard?category=politics` returns ranked list
- Daily sweep job runs without manual intervention; idempotent on retry
- Operator UI card shows top-3 personas + their Brier score

---

### 6. ⚪ Tool use (function calling)

**Goal:** agents currently work from a static `seed_doc`. Better: agents
can fetch what they need on demand mid-reasoning. Doubles inference cost
per agent but per-trade quality lift is large for ambiguous markets.

**API decision:** OpenAI / Anthropic / Gemini all support tool/function
calling natively. OpenRouter normalises to OpenAI-compatible. **No new
external API; reuse the connectors built in Tier 1 + 2.**

**Tool schema:**

```python
TOOLS = [
    {
        "name": "fetch_news",
        "description": "Get recent headlines about an entity related to this market. Use when seed_doc news section is stale or missing relevant entity coverage.",
        "parameters": {"entity": "string", "lookback_hours": "integer (default 24)"},
        # → news.fetch_market_news with single entity override
    },
    {
        "name": "lookup_resolved_markets",
        "description": "Find historical Polymarket markets matching this question pattern. Returns base rate + N most-similar resolved cases.",
        "parameters": {"query": "string", "limit": "integer (default 10)"},
        # → polymarket.discover_resolved_matching(...) — new function
    },
    {
        "name": "get_market_history",
        "description": "Fetch the price-history for this market over N hours. Use to detect momentum, regime change, or recent jumps.",
        "parameters": {"market_id": "string", "hours": "integer (default 24)"},
        # → polymarket.get_orderbook_price_history(...)
    },
    {
        "name": "get_whale_flow",
        "description": "Get top-20 holders and their 24h position deltas. Use for political/sports markets where insider info exists.",
        "parameters": {"market_id": "string"},
        # → whales.whale_flow (Tier 1 #2)
    },
    {
        "name": "compare_to_kalshi",
        "description": "Look up the same underlying question on Kalshi and return the implied probability. Returns null when no match exists.",
        "parameters": {"question": "string"},
        # → kalshi.find_matching_market (Tier 3 #9)
    },
]
```

**Architecture:**

```
services/swarm_runner/tools.py               (new, ~200 LoC)
  + TOOL_REGISTRY: {name: callable}
  + execute_tool(name, args, *, market_context) -> dict
  + tool_definitions() -> list[dict]  # OpenAI/Anthropic schema
  + Per-agent rate limiter: max 3 tool calls per agent per market

services/swarm_runner/agent.py               (rewrite _llm_forecast)
  + use chat completions with tools=tool_definitions()
  + loop: call LLM → if tool calls returned, execute + append to messages → repeat
  + cap at 3 tool rounds, then force final JSON
  + log per-agent which tools fired

services/swarm_runner/orchestrator.py        (extend _aggregate_beliefs)
  + record per-agent tool usage in SwarmRunResult.tool_log
  + expose in /api/signal/run as signals.tool_usage
```

**Files touched:** new `tools.py`, mostly rewrite `_llm_forecast` in
`agent.py`. ~350 LoC.

**Cost model:** with 3 tool rounds × 21 agents avg ~50% tool-use rate =
~33 extra LLM calls per swarm run = ~$0.50 extra per run on default model
pool. ~$25/day at 50 runs.

**Acceptance criteria:**

- Per-run telemetry shows tool_usage histogram (which tools fire most)
- Agents demonstrably USE tools when seed_doc is incomplete (e.g. they
  fetch news on a 6h-horizon political market with no news section)
- Tool round cap prevents runaway loops (verified via test)
- Failed tool calls degrade gracefully — agent continues without the
  data, doesn't crash

---

### 7. ⚪ Adversarial / red-team agent

**Goal:** dedicated devil's advocate. Always populates `minority_report`
even when the swarm is naturally aligned. Catches groupthink. Cheap to
add — one slot per node.

**API decision:** none — pure persona engineering.

**Architecture:**

```
services/swarm_runner/agent.py               (extend)
  + _PERSONA_RED_TEAM = ("red-team",
       "you are the swarm's devil's advocate. Your only job is to find the
        strongest case the consensus is wrong. You do NOT participate in the
        consensus weighting. Your reasoning will surface as minority_report
        regardless of agreement_score. State your case in concrete terms with
        a specific scenario under which the consensus loses big.")
  + new param `red_team: bool = False` on AgentSpec
  + when red_team=True, agent gets _PERSONA_RED_TEAM lens and a custom
    user prompt prefix: "CONSENSUS SO FAR (post round-1): {avg_probs}.
    Now find the strongest case it's wrong."

services/swarm_runner/orchestrator.py        (extend)
  + _build_specs: ensure exactly 1 red_team=True agent per node
    (3 red-team agents total in default config)
  + _aggregate_beliefs: exclude red_team beliefs from consensus weighting
    BUT include them in minority_report selection (they get +0.5 score
    bonus so they almost always surface)
  + new return field: red_team_dissent — list of all 3 red-team beliefs
    even if minority_report only shows the strongest
```

**Files touched:** `agent.py` + `orchestrator.py`. ~120 LoC.

**Dependencies:** none — could ship before Tier 1 even, but adds more value
once tool use (Tier 2 #6) lands so red-team can pull contrary evidence.

**Acceptance criteria:**

- Every `/api/signal/run` response has populated `red_team_dissent` array
  (3 entries, one per node)
- `minority_report` is non-null on > 80% of runs (vs ~30% baseline post-
  Phase-6) because red-team always provides a candidate dissenter
- Red-team agents demonstrably pick the OPPOSITE outcome from consensus on
  > 60% of runs — verified via test on a fixed seed_doc

---

### 8. ⚪ Resolution-criteria stress-test agent

**Goal:** Polymarket resolves on specific wording. Bad traders skim it;
alpha is in finding the loophole. Dedicated agent reads `market.description`
3x and finds edge cases.

**API decision:** none.

**Architecture:**

```
services/swarm_runner/agent.py               (extend)
  + _PERSONA_LOOPHOLE = ("loophole-finder",
       "you read the resolution criteria three times. Your job is to find
        the edge case under which this market resolves OPPOSITE to the
        obvious reading. Quote the exact phrasing that creates the
        ambiguity. If you find no ambiguity, say so explicitly.")
  + new flag `criteria_check: bool = False` on AgentSpec
  + custom user prompt that emphasises market.description over all else

services/swarm_runner/orchestrator.py        (extend)
  + _build_specs: 1 criteria_check agent per node (3 total)
  + _summarise_reasoning: if any criteria_check agent flagged ambiguity,
    promote its reasoning to the head of key_factors with prefix
    "⚠ Resolution-criteria edge case: "
```

**Files touched:** `agent.py` + `orchestrator.py`. ~80 LoC.

**Acceptance criteria:**

- On long-tail political/policy markets, the loophole-finder surfaces a
  concrete ambiguity in `key_factors` ~25% of the time
- When ambiguity is flagged, `confidence` is automatically capped at 0.6
  (regardless of consensus) — encoded in `_aggregate_beliefs`

---

## Tier 3 — Research grade (~1-2 weeks each, real moats)

### 9. ⚪ Cross-platform arbitrage agent

**Goal:** Kalshi runs the same political markets on a regulated US rail.
Spread between Kalshi and Polymarket on the literal same underlying
question is alpha — one venue is wrong. The `polymarket/agents` reference
framework had a Kalshi connector but never used it cross-venue.

**API decision:**

| Provider | Auth | Cost | Coverage |
|---|---|---|---|
| **Kalshi API** (`api.elections.kalshi.com/trade-api/v2/`) | JWT (account + member ID) | free for read-only, paid tier for trade | best for US politics + macro events |
| **Manifold Markets** (`manifold.markets/api/v0/`) | none | free | mostly play-money but real arb signals |
| **PredictIt** | n/a | retiring 2024 | ❌ skip |

Pick Kalshi as primary (real liquidity), Manifold as free secondary signal.

**Architecture:**

```
services/meridian_signal/kalshi.py           (new, ~250 LoC)
  ┌─ login() -> JWT  (cached for token lifetime)
  ├─ search_events(query: str, *, limit=10) -> list[KalshiEvent]
  ├─ get_market(market_ticker) -> KalshiMarket
  ├─ get_orderbook(market_ticker) -> OrderBook
  └─ find_matching_market(polymarket_question: str) -> KalshiMarket | None
       • semantic similarity via embedding model + keyword filter
       • returns None when match confidence < threshold

services/meridian_signal/manifold.py         (new, ~120 LoC)
  + similar shape, no auth, free tier

services/swarm_runner/agent.py               (extend persona pool)
  + _PERSONA_CROSS_VENUE = ("cross-venue-arb",
       "you compare Polymarket prices against Kalshi (and Manifold) for
        the same underlying question. You always check whether the venues
        agree. When they disagree, the spread is alpha — but read the
        resolution criteria carefully because venues sometimes resolve
        identical questions differently.")

services/meridian_signal/seed.py             (extend)
  + accept cross_venue_quote param; format as "## Cross-venue (X-06)" section
    showing Kalshi/Manifold prices when matched

services/meridian_signal/api.py              (extend /run)
  + pre-fetch cross_venue_quote = kalshi.find_matching_market(...)
                                  + manifold.find_matching_market(...)
  + pass to seed.build_seed_document
```

**Files touched:** new `kalshi.py` + `manifold.py`, edit `seed.py` + `api.py`
+ `agent.py`. ~600 LoC.

**Acceptance criteria:**

- For markets with a Kalshi or Manifold equivalent, `seed_doc` shows the
  cross-venue price + spread
- New `/api/signal/run` field `signals.cross_venue` exposes the gap
- `cross-venue-arb` persona explicitly references the spread in its
  reasoning when significant (> 5pp difference)

---

### 10. ⚪ Order-flow imbalance + replay

**Goal:** don't show one snapshot of the order book — show last hour of
trades. Net buying pressure, who's hitting which side, large trades
clustered around what price.

**API decision:** Polymarket CLOB `clob.polymarket.com/trades?market=...&limit=100`
returns recent trades. Same Data API surface as #2.

**Architecture:**

```
services/meridian_signal/orderflow.py        (new, ~180 LoC)
  ┌─ recent_trades(market_id, *, lookback_h=1, limit=100) -> list[Trade]
  ├─ aggregate(trades) -> OrderFlowReport
  └─ OrderFlowReport = {
        net_buying_pressure_usd: float,
        large_buys_count: int,        # >$1k
        large_sells_count: int,
        vwap_buy: float,
        vwap_sell: float,
        mean_trade_size_usd: float,
        timestamps: list[float]       # for sparkline
     }

services/meridian_signal/seed.py             (extend)
  + accept orderflow_report param; format as "## Order flow (O-05)" section
    with a one-line summary + per-side VWAP

services/meridian_signal/api.py              (extend /run)
  + pre-fetch orderflow_report, pass to seed
```

**Files touched:** new `orderflow.py`, edit `seed.py` + `api.py`. ~250 LoC.

**Acceptance criteria:**

- `seed_doc` shows order-flow section with directional signal for any
  market with > 5 trades in the lookback window
- `microstructure` persona references order flow explicitly in reasoning
- Combined with Tier 1 #2 (whale flow), agents can distinguish "one
  whale moved the price" (whales = high cluster) from "broad participation"
  (orderflow = many small trades, whales = low cluster)

---

### 11. ⚪ Specialist sub-swarms with meta-aggregation

**Goal:** instead of one swarm of 21 generalists, run K=3 sub-swarms each
pre-conditioned on a different expert frame. Meta-agent reasons across
the K consensuses. Closer to how real prediction-market desks operate.

**API decision:** none — pure orchestration restructure.

**Architecture:**

```
services/swarm_runner/orchestrator.py        (extend)
  + new public API: run_axl_subswarms(
       seed_doc, market_id, outcomes,
       sub_swarms: list[SubSwarmConfig],
       meta_agent_model: str | None = None,
    ) -> MetaSwarmResult
  + SubSwarmConfig = {
        name: str,                    # "academic", "wall-street", "contrarian"
        persona_pool_override: list[tuple],
        system_prompt_prefix: str,    # e.g. "You are part of the academic
                                       #  political-science sub-swarm. Defer
                                       #  to peer-reviewed base rates."
        agents_per_node: int = 3,
    }
  + each sub-swarm runs its own AXL mesh round, reaches its own consensus
  + new _meta_aggregate_subswarms(sub_results, market_id, outcomes,
                                   meta_agent_model) -> MetaSwarmResult
       • dedicated meta-agent reads the K sub-consensuses + their
         minority_reports, reasons across them, produces final probability
         and a "panel reasoning" that quotes each sub-swarm's view

services/meridian_signal/swarm.py            (extend)
  + new run_swarm_subswarms variant
  + SwarmOutput gains optional sub_swarms: [{name, consensus, ...}, ...]
    and panel_reasoning: str fields

services/meridian_signal/api.py              (extend /run)
  + new request param `sub_swarms: bool = False` to opt in
  + when true, route through run_swarm_subswarms

apps/app/components/miroshark/graph-panel.jsx  (extend)
  + new "Panel" view mode showing K sub-swarm verdicts side by side
```

**Files touched:** ~600 LoC across orchestrator, swarm.py, api.py, UI.

**Default sub-swarm config** (saved as preset):

```python
SUBSWARMS_DEFAULT = [
    SubSwarmConfig(name="contrarian",
                   persona_pool_override=[CONTRARIAN_QUANT, RED_TEAM, VALUE],
                   system_prompt_prefix="You are part of the contrarian sub-swarm. Lean against the obvious read. Anchor on what could make the consensus wrong."),
    SubSwarmConfig(name="quantitative",
                   persona_pool_override=[BASE_RATE, MICROSTRUCTURE, BAYESIAN],
                   system_prompt_prefix="You are part of the quantitative sub-swarm. Anchor on numbers — base rates, microstructure, Bayesian updates. Avoid narrative."),
    SubSwarmConfig(name="domain",
                   persona_pool_override=[GEOPOLITICAL, MACRO, ON_CHAIN],  # adapts to category
                   system_prompt_prefix="You are part of the domain-expert sub-swarm. Apply specialist knowledge of this market's category."),
]
```

**Acceptance criteria:**

- `/api/signal/run?sub_swarms=true` returns `sub_swarms: [...]` array with
  3 named sub-consensuses + panel_reasoning
- Operator UI's swarm-graph card has a "panel view" toggle
- Backtest shows sub-swarm aggregate beats single-swarm aggregate on
  ambiguous markets (`agreement_score < 0.65` baseline)

---

### 12. ⚪ Fine-tuning on hits/misses

**Goal:** few-shot or fine-tune a small model on past correct/incorrect
swarm calls. Phase 7+. Turns the swarm into something a serious desk would
license rather than a clever prompt-engineered ensemble.

**API decision:**

| Provider | Pricing | Pros | Cons |
|---|---|---|---|
| **OpenAI fine-tuning** (gpt-4o-mini base) | training: $25/1M tokens, inference: $0.30/1M input + $1.20/1M output | well-documented, fast iteration | model lock-in to OpenAI |
| **Anthropic fine-tuning** | contact sales | best base model | limited availability |
| **Together AI** (Llama 3.3 70B base) | training $0.50/1M tokens, inference $0.88/1M | open-weights, can self-host | more setup |
| **Fireworks AI** (Llama / Qwen base) | similar to Together | fast cold start | similar |
| **Replicate** (custom Llama / Qwen) | $0.002/1k tokens roughly | flexible | latency variance |

Pick: **OpenAI gpt-4o-mini fine-tune for first iteration** (fast to ship,
clear pricing). Migrate to Together/Fireworks Llama 3.3 once we want to
self-host or remove single-vendor risk.

**Architecture:**

```
services/swarm_runner/finetune.py            (new, ~400 LoC)
  ┌─ build_training_set(*, lookback_days=180, min_brier_diff=0.15)
  │    • pull from calibration.belief_log + resolution_log
  │    • for each (market, persona, model) tuple where outcome is known,
  │      build training pair:
  │         input: full seed_doc + persona system prompt + agent prompt
  │         output: the agent's actual JSON output AND a "ground truth"
  │                 hint indicating whether the call was right
  │    • filter: only include "high-signal" examples — ones where the
  │      agent was SIGNIFICANTLY right (Brier delta vs market < -0.15)
  │      OR significantly wrong (delta > +0.15). Mediocre calls add noise.
  ├─ format_for_openai(pairs) -> JSONL
  ├─ submit_finetune(jsonl_path, *, base_model="gpt-4o-mini-2024-07-18")
  │    • uploads to OpenAI Files, creates fine-tune job, polls until done
  │    • returns the fine-tuned model id
  ├─ promote_model(ft_model_id, persona_id, *, mode="canary")
  │    • updates persona_calibration table to use the new model for this persona
  │    • mode="canary" routes 20% of agents to ft model, rest to base
  │    • mode="full" routes 100%
  └─ rollback_persona(persona_id)
       • returns to base model

services/swarm_runner/agent.py               (extend)
  + _pick_model now also reads persona_calibration to use a fine-tuned
    model for specific (persona, category) combinations when promoted

apps/app/scripts/finetune-sweep.sh           (new)
  + cron-friendly wrapper: build_training_set → submit_finetune → promote
  + run weekly per persona that has > 100 resolved-market data points
```

**Files touched:** ~500 LoC + cron wrapper. Plus operator UI for
"promote/rollback fine-tuned model" controls.

**Dependencies:** Tier 2 #5 (calibration tracking) is hard prerequisite —
we can't build training pairs without `belief_log` + `resolution_log`.

**Acceptance criteria:**

- After 200+ resolved markets per persona, `finetune-sweep.sh` produces a
  fine-tuned model checkpoint per persona
- Canary deploy (20% of agents on ft model) shows lower Brier vs base
  model on the same markets
- Promotion → full rollout improves overall swarm Brier score by ≥ 5%

---

## Cross-cutting concerns

### Cost ceiling

Sum of all default-on tiers at 50 runs/day:

| Item | Daily | Monthly |
|---|---|---|
| Tier 1 #1 news (Tavily + Perplexity) | $0.55 | $17 |
| Tier 1 #3 multi-LLM via OpenRouter | $8 | $240 |
| Tier 2 #6 tool use (extra LLM rounds) | $25 | $750 |
| Tier 3 #9 cross-venue (free APIs) | $0 | $0 |
| Tier 3 #12 fine-tuning ops | ~$50/mo training | $50 |
| **All-in default** | **~$33/day** | **~$1k/mo** |

For testnet iteration this is acceptable. At demo time, dial down via
`MIROSHARK_SWARM_BUDGET=low` config that disables Tier 2 #6 and reduces
Tier 1 #3 pool to 2 models.

### Telemetry surface

Every `/api/signal/run` response should grow (across all tiers) an
optional `signals` block consolidating the per-feature outputs:

```json
{
  "signals": {
    "entropy": { ... },
    "topology": { ... },
    "cryo": { ... },
    "news": { "items_count": 5, "deep": false, "queried_at": ... },
    "whales": { "top_holders_count": 20, "net_buying_pressure_24h_usdc": 4500 },
    "orderflow": { "net_buying_pressure_usd": 1200, "large_buys": 3 },
    "cross_venue": { "kalshi": { "matched": true, "price": 0.62, "spread_pp": -3 } },
    "tool_usage": { "fetch_news": 12, "lookup_resolved_markets": 4, ... },
    "models_used": [...]
  }
}
```

This makes /signal/run usable by anything from an operator UI to a backtest harness.

### Testing strategy

- **Backtest infrastructure already exists** at `services/meridian_signal/backtest.py`.
  Every Tier item should add a backtest benchmark before promoting.
- **Calibration database** (Tier 2 #5) becomes the universal scoreboard —
  every other Tier ships with a delta-Brier number vs baseline.
- **Tier 1 #4 (time horizon)** ships first because it's measurable in 24h
  on existing markets; everything else follows.

### Sequencing the build

Dependency graph:

```
Tier 1:
  #4 (time horizon)        ← no deps, ship first, measurable in a day
  #1 (news)                ← no deps; biggest single-step lift
  #2 (whale flow)          ← no deps
  #3 (multi-LLM)           ← no deps; enables per-model calibration in Tier 2

Tier 2:
  #5 (calibration)         ← prefer #3 first (per-model dimension)
  #6 (tool use)            ← prefer #1 + #2 first (tools to wrap)
  #7 (red team)            ← no deps; cheap; ship anytime
  #8 (loophole-finder)     ← no deps; cheap; ship anytime

Tier 3:
  #9 (cross-venue)         ← no deps; biggest standalone Tier-3 win
  #10 (order-flow)         ← no deps
  #11 (sub-swarms)         ← prefer #5 + #6 first (more agent diversity to subdivide)
  #12 (fine-tune)          ← hard prereq #5 (need calibration.db)
```

**Recommended ship order**: #4 → #1 → #2 → #3 → #7 → #8 → #5 → #6 → #9 → #10 → #11 → #12.

Each item gets its own commit + telemetry + backtest delta. We ship one tier
item per testnet iteration cycle until the calibration leaderboard says
the swarm is consistently beating the market by > 3pp net of fees on
high-liquidity markets — that's the threshold for mainnet.

---

## Maintenance contract

When you ship one of these items:

1. Edit this file. Mark the item ✅ DONE with the commit hash.
2. Add `Shipped:` line under the item with date + commit + actual LoC.
3. Add `Backtest:` line with the delta-Brier vs baseline measurement.
4. Update `CLAUDE.md` and `README.md` if the swarm response shape changed.
5. Push the corresponding edit to the Pinata agent's `skills/miroshark.md`
   so the deployed agent knows about the new field.

When you punt one of these items, write `Punt:` with a one-line reason so
future-you knows why.

When a new enhancement gets identified mid-build, add it as a new entry under
the appropriate Tier with the same structure (Goal / API decision /
Architecture / Files / Acceptance). Don't relegate to a backlog file — this
is the canonical roadmap.
