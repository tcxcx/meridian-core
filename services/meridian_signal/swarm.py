"""Swarm dispatcher.

Phase 1: single-LLM stand-in (`run_swarm_lite`).
Phase 2: multi-agent gossip across 3 AXL nodes (`run_swarm_axl`).

The HTTP contract returned by both is identical — only `phase` and
`contributing_agents` differ. Pick by env: `SWARM_BACKEND=lite|axl`.
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass

from openai import OpenAI

log = logging.getLogger("meridian.swarm")


@dataclass
class SwarmOutput:
    swarm_prediction: dict[str, float]   # outcome → predicted probability (sums to ~1.0)
    confidence: float                    # 0..1, swarm consensus strength
    reasoning: str                       # one paragraph
    key_factors: list[str]               # 3-6 bullets
    contributing_agents: list[str]       # AXL agent IDs in Phase 2; [] in Phase 1
    model: str
    phase: str = "1-swarm-lite"


_SYSTEM_PROMPT = (
    "You are a prediction-market analyst running an internal forecast swarm. "
    "Given a market and its outcomes, return a calibrated probability for each "
    "outcome and your confidence in the forecast. Be specific about which factors "
    "moved your estimate. Do not echo the market's implied price unless you "
    "genuinely have no information differentiating you from the market."
)


def _user_prompt(seed_doc: str, outcomes: list[str]) -> str:
    return (
        f"{seed_doc}\n\n"
        "Return ONLY a JSON object with these exact keys:\n"
        f"- swarm_prediction: object with one key per outcome ({outcomes}) "
        "mapping to a probability 0..1 (must sum to ~1.0)\n"
        "- confidence: number 0..1 indicating how strongly the swarm agrees\n"
        "- reasoning: one short paragraph explaining the forecast\n"
        "- key_factors: array of 3-6 short bullet strings (most-load-bearing factors)"
    )


def run_swarm_lite(
    *,
    seed_doc: str,
    outcomes: list[str],
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> SwarmOutput:
    api_key = api_key or os.environ["LLM_API_KEY"]
    base_url = base_url or os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
    model = model or os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini")

    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": _SYSTEM_PROMPT},
            {"role": "user", "content": _user_prompt(seed_doc, outcomes)},
        ],
        temperature=0.4,
    )
    raw = json.loads(resp.choices[0].message.content or "{}")

    pred = raw.get("swarm_prediction") or {}
    # Normalise probabilities (defensive — LLMs sometimes drift)
    pred = {k: float(v) for k, v in pred.items() if isinstance(v, (int, float))}
    total = sum(pred.values()) or 1.0
    pred = {k: v / total for k, v in pred.items()}

    return SwarmOutput(
        swarm_prediction=pred,
        confidence=float(raw.get("confidence", 0.5)),
        reasoning=str(raw.get("reasoning", "")),
        key_factors=[str(x) for x in (raw.get("key_factors") or [])],
        contributing_agents=[],  # populated in Phase 2 by AXL agent IDs
        model=model,
    )


def run_swarm_axl(
    *,
    seed_doc: str,
    market_id: str,
    outcomes: list[str],
    agents_per_node: int | None = None,
    rounds: int | None = None,
) -> SwarmOutput:
    """Phase 2: multi-agent gossip across 3 AXL nodes.

    Imports lazily so a Phase 1 deployment without `swarm_runner` installed
    still works for `run_swarm_lite`.
    """
    from swarm_runner.orchestrator import run_axl_swarm  # type: ignore

    apn = agents_per_node or int(os.environ.get("SWARM_AGENTS_PER_NODE", "5"))
    rds = rounds or int(os.environ.get("SWARM_ROUNDS", "2"))
    result = run_axl_swarm(
        seed_doc=seed_doc,
        market_id=market_id,
        outcomes=outcomes,
        agents_per_node=apn,
        rounds=rds,
    )
    return SwarmOutput(
        swarm_prediction=result.consensus,
        confidence=result.confidence,
        reasoning=result.reasoning,
        key_factors=result.key_factors,
        contributing_agents=result.contributing_agents,
        model=os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini"),
        phase=f"2-axl-mesh ({len(result.node_keys)}-node, {result.raw_beliefs} beliefs)",
    )


def run(
    *,
    seed_doc: str,
    outcomes: list[str],
    market_id: str | None = None,
) -> SwarmOutput:
    """Dispatch to the configured backend (`SWARM_BACKEND=lite|axl`, default lite)."""
    backend = os.environ.get("SWARM_BACKEND", "lite").lower()
    if backend == "axl":
        if not market_id:
            raise ValueError("market_id required for SWARM_BACKEND=axl")
        return run_swarm_axl(seed_doc=seed_doc, market_id=market_id, outcomes=outcomes)
    return run_swarm_lite(seed_doc=seed_doc, outcomes=outcomes)


def to_dict(out: SwarmOutput) -> dict:
    return asdict(out)
