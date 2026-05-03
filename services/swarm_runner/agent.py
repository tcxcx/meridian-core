"""One swarm agent: runs a private LLM forecast, broadcasts belief, drains peers, refines.

Each agent lives on exactly one AXL node (one local API URL). The orchestrator
spawns 6-7 agents per node so total = ~20 across 3 nodes.

Round flow (per market):
    1. drain inbox (catch up on prior-round peer beliefs)
    2. private LLM forecast → initial belief
    3. broadcast belief to all peers
    4. sleep gossip_window seconds
    5. drain inbox again
    6. weighted-average our belief with peer beliefs (trust = sender confidence)
    7. broadcast revised belief
    8. return final belief
"""
from __future__ import annotations

import json
import logging
import os
import random
import threading
import time
from dataclasses import dataclass

from openai import OpenAI

from .axl_client import PROTO_VERSION, MSG_TYPE_BELIEF, AxlClient, Belief

log = logging.getLogger("meridian.swarm.agent")


class NodeInbox:
    """Per-node shared cache around AxlClient.drain().

    AXL's /recv pops a message exactly once. With N agents per node calling
    drain() concurrently, the first agent grabs everything and the rest see
    nothing. Wrapping drain() in a node-scoped cache lets all agents on the
    same node observe every belief that crossed the mesh.
    """

    def __init__(self, axl: AxlClient) -> None:
        self._axl = axl
        self._lock = threading.Lock()
        self._cache: list[Belief] = []

    def drain_all(self) -> list[Belief]:
        """Pull anything new from /recv into the cache, then return the cache."""
        with self._lock:
            new = self._axl.drain()
            if new:
                self._cache.extend(new)
            return list(self._cache)


_NODE_INBOXES: dict[str, NodeInbox] = {}
_INBOX_LOCK = threading.Lock()


def _inbox_for(api_url: str, known_peers: list[str]) -> NodeInbox:
    with _INBOX_LOCK:
        ib = _NODE_INBOXES.get(api_url)
        if ib is None:
            ib = NodeInbox(AxlClient(api_url=api_url, known_peers=known_peers))
            _NODE_INBOXES[api_url] = ib
        return ib


def reset_inboxes() -> None:
    """Clear the per-node cache. Call between independent swarm runs."""
    with _INBOX_LOCK:
        _NODE_INBOXES.clear()

# ── Persona library ────────────────────────────────────────────────────────
# Each persona is (label, lens). The lens shapes what the agent prioritises
# when it reasons about the market. Personas are pulled from a category-aware
# pool: politics markets get more geopolitical analysts, financial markets
# get more quants, etc. Falls back to the full pool when category can't be
# inferred from the question text.

_PERSONAS_CORE = [
    ("contrarian-quant", "a contrarian quant who shorts narrative trades; you fade hype and lean into orderbook signals"),
    ("base-rate", "a Tetlock-style base-rate forecaster who anchors on prior frequencies and reference classes"),
    ("microstructure", "a market-microstructure specialist who treats order book entropy, spread, and depth as primary signals"),
    ("bayesian", "a Bayesian updater who sets a prior, lists 3 evidence buckets, and updates explicitly"),
    ("value", "a value investor who fades extreme prices and asks 'what would have to be true for this to be wrong?'"),
]
_PERSONAS_POLITICS = [
    ("geopolitical", "a geopolitical analyst tracking real-world signals: polls, news cycle, base rates of incumbency"),
    ("political-historian", "a political historian who anchors on similar elections / appointments / votes from the last 30 years"),
    ("policy-wonk", "a policy wonk who reads the resolution criteria word-for-word and finds the loophole"),
]
_PERSONAS_FINANCE = [
    ("momentum", "a momentum trader who follows price action and treats trends as informative until proven broken"),
    ("vol-trader", "a volatility trader who reads the spread + depth as the truer probability than mid-price"),
    ("macro", "a macro analyst who connects this market to broader rates / FX / commodity regime"),
]
_PERSONAS_CRYPTO = [
    ("on-chain", "an on-chain analyst who weights wallet flows, exchange reserves, and protocol metrics over headlines"),
    ("narrative", "a narrative trader who tracks what's loud on Crypto Twitter and sizes against consensus"),
]
_PERSONAS_NEWS = [
    ("news-driven", "a news-driven trader who weights recency heavily and treats stale resolution criteria as a tell"),
]


_POLITICS_KW = ("election", "president", "senate", "congress", "trump", "biden", "harris", "vance",
                "putin", "ukraine", "war", "ceasefire", "treaty", "vote", "poll", "primary", "supreme court",
                "nominee", "appointment", "impeachment", "geopolitic", "diplomatic")
_FINANCE_KW = ("fed", "rate", "interest", "cpi", "inflation", "gdp", "earnings", "ipo", "stock", "spx",
               "nasdaq", "treasury", "bond", "yield", "spread", "fx", "dollar", "euro", "yen", "recession")
_CRYPTO_KW = ("bitcoin", "btc", "ethereum", "eth", "solana", "sol", "crypto", "etf", "halving", "merge",
              "stablecoin", "usdc", "usdt", "defi", "memecoin", "doge", "pepe", "shib", "polymarket")


def _detect_market_category(seed_doc: str) -> str:
    """Cheap keyword classifier. Returns 'politics' | 'finance' | 'crypto' | 'general'."""
    text = seed_doc.lower()[:1500]  # cap — first 1.5k chars carries the question + summary
    pol = sum(1 for kw in _POLITICS_KW if kw in text)
    fin = sum(1 for kw in _FINANCE_KW if kw in text)
    crp = sum(1 for kw in _CRYPTO_KW if kw in text)
    best = max(pol, fin, crp)
    if best == 0:
        return "general"
    if pol == best:
        return "politics"
    if crp == best:
        return "crypto"
    return "finance"


def _persona_pool(category: str) -> list[tuple[str, str]]:
    """Return the persona pool for a market category. Always anchors on
    _PERSONAS_CORE so every swarm has the base lenses, then layers on the
    category-specific personas to get specialist depth."""
    pool = list(_PERSONAS_CORE) + list(_PERSONAS_NEWS)
    if category == "politics":
        pool += _PERSONAS_POLITICS
    elif category == "finance":
        pool += _PERSONAS_FINANCE
    elif category == "crypto":
        pool += _PERSONAS_CRYPTO
    return pool


def _persona_for(agent_index: int, seed_doc: str) -> tuple[str, str]:
    """Pick a (label, lens) tuple for this agent based on market category.
    Round-robin across the category pool so each agent gets a distinct lens
    until the pool wraps."""
    pool = _persona_pool(_detect_market_category(seed_doc))
    return pool[agent_index % len(pool)]


# ── LLM call ──────────────────────────────────────────────────────────────
# The user prompt embeds the (now-rich) seed_doc + peer beliefs + a strict
# JSON schema. The system prompt is the Tetlock-style superforecaster
# methodology, adapted from polymarket/agents prompts.py:112-144 (which is
# itself drawn from Phil Tetlock's _Superforecasting_ work). We additionally
# tell agents how to interpret the Polymarket-specific signals that seed.py
# now bakes in (entropy tier, spread, correlations, cryo) — the agent
# framework had none of this Polymarket awareness.

_SUPERFORECASTER_SYS = """You are one of many independent forecasters in a prediction-market swarm. Hold your own view; update on peer beliefs ONLY when their reasoning outweighs yours. Diversity beats agreement.

For each market, follow this Tetlock-style methodology silently before producing your answer:

1. Decompose: break the question into 2-3 sub-questions whose joint probability gives the answer.
2. Base-rate: anchor on the historical frequency of similar events. Reference class > intuition.
3. Inside view: list 2-3 case-specific factors that move probability up or down. Quantify each.
4. Update on signals: read the order-book microstructure section in the seed_doc.
   - Spread > 100 bps OR entropy tier 2 (deep freeze) → discount your edge by ≥50%; the price is probably stale or whale-parked, not consensus.
   - Tier 1 (frozen) → soft penalty (−0.1 confidence). Tier 0 (active) → no adjustment.
   - Cryo anomaly (sudden freeze) → either someone knows something (small size, fast exit) or manipulation (pass). Either way, lower confidence.
   - Correlated markets section → if you see correlated markets you don't already hold, your trade is uncrowded; if the fund holds correlated positions, treat as duplicate-bet (lower confidence).
5. Probabilistic output: express probabilities, never certainties. Calibration matters more than directional accuracy."""

_USER_PROMPT_TEMPLATE = """Your lens: **{persona_lens}**

{seed_doc}
{peer_summary}
Return ONLY a JSON object with these exact keys:
- probabilities: object with one key per outcome ({outcomes}) mapping to 0..1 (must sum to ~1.0)
- confidence: number 0..1 — your confidence in YOUR estimate (NOT the swarm consensus). Apply the signal-driven penalties from the system prompt explicitly.
- reasoning: one short paragraph (≤80 words) covering: (a) your decomposition + base-rate, (b) how the order-book signals shifted your estimate, (c) your distinct angle vs the swarm. NOT a summary of peer beliefs."""


def _llm_forecast(
    *,
    seed_doc: str,
    outcomes: list[str],
    persona_lens: str,
    peer_beliefs: list[Belief],
    api_key: str,
    base_url: str,
    model: str,
) -> tuple[dict[str, float], float, str]:
    """Single LLM call. Returns (probabilities, confidence, reasoning)."""
    peer_summary = ""
    if peer_beliefs:
        lines = []
        for b in peer_beliefs[-12:]:  # cap context
            probs = ", ".join(f"{o}={b.probabilities.get(o, 0):.2f}" for o in outcomes)
            lines.append(f"- {b.agent_id} (conf={b.confidence:.2f}): {probs}")
        peer_summary = "\n## Peer beliefs you have observed\n" + "\n".join(lines) + "\n"

    user_prompt = _USER_PROMPT_TEMPLATE.format(
        persona_lens=persona_lens,
        seed_doc=seed_doc,
        peer_summary=peer_summary,
        outcomes=outcomes,
    )
    sys_prompt = _SUPERFORECASTER_SYS

    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": user_prompt},
        ],
        temperature=0.7,  # higher than swarm-lite — we WANT divergent agents
    )
    raw = json.loads(resp.choices[0].message.content or "{}")
    probs = {k: float(v) for k, v in (raw.get("probabilities") or {}).items()
             if isinstance(v, (int, float))}
    total = sum(probs.values()) or 1.0
    probs = {k: v / total for k, v in probs.items()}
    return (
        probs,
        float(raw.get("confidence", 0.5)),
        str(raw.get("reasoning", ""))[:600],
    )


@dataclass
class AgentSpec:
    agent_id: str        # "node-a/agent-3"
    node_index: int      # 0,1,2 — only for persona spread
    api_url: str         # local AXL node API
    node_pubkey: str     # this node's AXL public key
    peer_pubkeys: list[str] = None  # other nodes' pubkeys for guaranteed delivery


def run_agent(
    *,
    spec: AgentSpec,
    seed_doc: str,
    market_id: str,
    outcomes: list[str],
    rounds: int = 2,
    gossip_window_s: float = 2.5,
    llm_api_key: str | None = None,
    llm_base_url: str | None = None,
    llm_model: str | None = None,
) -> Belief:
    """Run one agent through `rounds` of broadcast→gossip→refine. Returns final belief."""
    llm_api_key = llm_api_key or os.environ["LLM_API_KEY"]
    llm_base_url = llm_base_url or os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
    llm_model = llm_model or os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini")

    axl = AxlClient(api_url=spec.api_url, known_peers=spec.peer_pubkeys or [])
    inbox = _inbox_for(spec.api_url, spec.peer_pubkeys or [])
    # Pick a persona aware of the market's category (politics / finance /
    # crypto / general) so specialist lenses get used where relevant.
    persona_label, persona_lens = _persona_for(
        agent_index=spec.node_index * 7 + int(spec.agent_id.rsplit("-", 1)[-1]),
        seed_doc=seed_doc,
    )
    last_belief: Belief | None = None

    for r in range(1, rounds + 1):
        # 1. read shared per-node cache (every agent on this node sees the
        #    same beliefs — AXL's /recv is one-shot per node).
        accumulated = inbox.drain_all()
        # only consider beliefs about THIS market, and not our own
        market_peers = [
            b for b in accumulated
            if b.market_id == market_id and b.agent_id != spec.agent_id
        ]

        # 2. forecast (with whatever peer context we have)
        probs, conf, reasoning = _llm_forecast(
            seed_doc=seed_doc,
            outcomes=outcomes,
            persona_lens=persona_lens,
            peer_beliefs=market_peers,
            api_key=llm_api_key,
            base_url=llm_base_url,
            model=llm_model,
        )

        belief = Belief(
            proto=PROTO_VERSION,
            type=MSG_TYPE_BELIEF,
            market_id=market_id,
            outcomes=outcomes,
            probabilities=probs,
            confidence=conf,
            reasoning=reasoning,
            agent_id=spec.agent_id,
            node_id=spec.node_pubkey,
            round=r,
            timestamp=time.time(),
        )
        log.info(
            "%s [%s] round=%d probs=%s conf=%.2f peers_seen=%d",
            spec.agent_id, persona_label, r,
            {k: round(v, 3) for k, v in probs.items()},
            conf, len(market_peers),
        )

        # 3. broadcast (fire-and-forget; peers will drain on their next round)
        axl.broadcast(belief)
        last_belief = belief

        if r < rounds:
            # 4. let other agents publish before next refine round.
            #    Add a tiny jitter so all agents don't drain at the same instant.
            time.sleep(gossip_window_s + random.uniform(0, 0.5))

    # final drain into the shared cache so the orchestrator can audit
    inbox.drain_all()
    return last_belief  # type: ignore[return-value]
