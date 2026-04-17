"""Phase 1 swarm-lite: single-LLM stand-in for the full multi-agent swarm.

The HTTP contract returned here is the same one Phase 2 (AXL multi-agent) and
Phase 3 (0G inference) will produce — only the *implementation* changes.
"""
from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass

from openai import OpenAI


@dataclass
class SwarmOutput:
    swarm_prediction: dict[str, float]   # outcome → predicted probability (sums to ~1.0)
    confidence: float                    # 0..1, swarm consensus strength
    reasoning: str                       # one paragraph
    key_factors: list[str]               # 3-6 bullets
    contributing_agents: list[str]       # placeholder until Phase 2 (AXL agents)
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


def to_dict(out: SwarmOutput) -> dict:
    return asdict(out)
