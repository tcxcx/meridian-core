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
    # 0G TeeML attestation envelope from cogito /compute/inference. None when
    # LLM_PROVIDER != "0g" (no TEE attestation available from OpenAI etc.).
    # Shape: {chat_id, valid, provider, model, ...}
    attestation_envelope: dict | None = None


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


def _chat_json(
    *,
    messages: list[dict[str, str]],
    temperature: float = 0.4,
) -> tuple[str, str, dict | None]:
    """Run a chat completion and return (raw_json_text, model_used, envelope).

    `envelope` is the 0G TeeML attestation dict (chat_id, valid, provider, model)
    when LLM_PROVIDER=0g; None for OpenAI-compatible providers.

    Picks backend by env `LLM_PROVIDER`:
      - "0g"      → cogito /compute/inference (DeAIOS, TeeML-verifiable)
      - anything else (default "openai") → OpenAI-compatible endpoint
    """
    provider = os.environ.get("LLM_PROVIDER", "openai").lower()

    if provider == "0g":
        from . import zg_client

        model = os.environ.get("COGITO_LLM_MODEL", "openai/gpt-oss-20b")
        res = zg_client.get_client().inference(
            messages=messages,
            model=model,
            temperature=temperature,
        )
        envelope = {
            "provider": "0g",
            "model": str(res.get("model") or model),
            "chat_id": res.get("chat_id"),
            "valid": res.get("valid"),
        }
        return str(res.get("content") or "{}"), str(res.get("model") or model), envelope

    api_key = os.environ["LLM_API_KEY"]
    base_url = os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1")
    model = os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini")
    client = OpenAI(api_key=api_key, base_url=base_url)
    resp = client.chat.completions.create(
        model=model,
        response_format={"type": "json_object"},
        messages=messages,
        temperature=temperature,
    )
    return resp.choices[0].message.content or "{}", model, None


def run_swarm_lite(
    *,
    seed_doc: str,
    outcomes: list[str],
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> SwarmOutput:
    # Keyword args preserved for call-site compat, but LLM_PROVIDER=0g overrides.
    messages = [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": _user_prompt(seed_doc, outcomes)},
    ]
    raw_text, model_used, envelope = _chat_json(messages=messages, temperature=0.4)
    try:
        raw = json.loads(raw_text)
    except json.JSONDecodeError:
        # 0G providers don't all honour response_format=json_object — scrape.
        log.warning("chat returned non-JSON; attempting object extraction")
        import re
        m = re.search(r"\{.*\}", raw_text, re.DOTALL)
        raw = json.loads(m.group(0)) if m else {}

    pred = raw.get("swarm_prediction") or {}
    pred = {k: float(v) for k, v in pred.items() if isinstance(v, (int, float))}
    total = sum(pred.values()) or 1.0
    pred = {k: v / total for k, v in pred.items()}

    return SwarmOutput(
        swarm_prediction=pred,
        confidence=float(raw.get("confidence", 0.5)),
        reasoning=str(raw.get("reasoning", "")),
        key_factors=[str(x) for x in (raw.get("key_factors") or [])],
        contributing_agents=[],
        model=model_used,
        attestation_envelope=envelope,
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
    # AXL attestation surface = the node mesh (signed beliefs across N nodes).
    # If LLM_PROVIDER=0g each agent also produces TEE chat_ids, but we don't
    # plumb per-agent envelopes through SwarmRunResult yet — topology only.
    axl_envelope = {
        "provider": "axl-mesh",
        "model": os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini"),
        "nodes": result.node_keys,
        "beliefs": result.raw_beliefs,
        "rounds": result.rounds,
    }
    return SwarmOutput(
        swarm_prediction=result.consensus,
        confidence=result.confidence,
        reasoning=result.reasoning,
        key_factors=result.key_factors,
        contributing_agents=result.contributing_agents,
        model=os.environ.get("LLM_MODEL_NAME", "gpt-4o-mini"),
        phase=f"2-axl-mesh ({len(result.node_keys)}-node, {result.raw_beliefs} beliefs)",
        attestation_envelope=axl_envelope,
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
