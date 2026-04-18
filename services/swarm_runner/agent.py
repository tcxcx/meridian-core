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
import time
from dataclasses import dataclass

from openai import OpenAI

from .axl_client import PROTO_VERSION, MSG_TYPE_BELIEF, AxlClient, Belief

log = logging.getLogger("meridian.swarm.agent")

_PERSONAS = [
    "a contrarian quant who shorts narrative trades",
    "a base-rate forecaster who anchors on prior frequencies",
    "a geopolitical analyst tracking real-world signals",
    "a market microstructure specialist watching order flow",
    "a Bayesian who updates aggressively on new evidence",
    "a momentum trader who follows market consensus",
    "a value investor who fades extreme prices",
    "a news-driven trader who weights recency heavily",
]


def _persona(agent_index: int) -> str:
    return _PERSONAS[agent_index % len(_PERSONAS)]


def _llm_forecast(
    *,
    seed_doc: str,
    outcomes: list[str],
    persona: str,
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

    user_prompt = (
        f"You are **{persona}** participating in a swarm of independent forecasters.\n"
        f"{seed_doc}\n"
        f"{peer_summary}\n"
        "Return ONLY a JSON object with these exact keys:\n"
        f"- probabilities: object with one key per outcome ({outcomes}) "
        "mapping to a probability 0..1 (must sum to ~1.0)\n"
        "- confidence: number 0..1 (how confident in YOUR estimate, "
        "not the swarm consensus)\n"
        "- reasoning: one short paragraph (≤ 60 words) — your distinct angle, "
        "NOT a summary of peers"
    )
    sys_prompt = (
        "You are one of many independent prediction-market forecasters. "
        "Hold your own view. Update on peer beliefs only when their reasoning "
        "outweighs yours; otherwise stay anchored. Diversity beats agreement."
    )

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

    axl = AxlClient(api_url=spec.api_url)
    persona = _persona(spec.node_index * 7 + int(spec.agent_id.rsplit("-", 1)[-1]))
    accumulated_peers: list[Belief] = []
    last_belief: Belief | None = None

    for r in range(1, rounds + 1):
        # 1. catch up on what peers have said since last drain
        accumulated_peers.extend(axl.drain())
        # only consider beliefs about THIS market
        market_peers = [b for b in accumulated_peers if b.market_id == market_id]

        # 2. forecast (with whatever peer context we have)
        probs, conf, reasoning = _llm_forecast(
            seed_doc=seed_doc,
            outcomes=outcomes,
            persona=persona,
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
            "%s round=%d probs=%s conf=%.2f peers_seen=%d",
            spec.agent_id, r,
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

    # final drain so the orchestrator can audit who we heard from
    accumulated_peers.extend(axl.drain())
    return last_belief  # type: ignore[return-value]
