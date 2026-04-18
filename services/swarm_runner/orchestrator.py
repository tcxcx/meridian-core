"""Phase 2 orchestrator: spawn N agents across 3 AXL nodes, aggregate beliefs into a swarm signal.

Public API:
    run_axl_swarm(seed_doc, market_id, outcomes, agents_per_node=7, rounds=2) -> dict

Returns the same shape that meridian_signal.swarm.SwarmOutput expects, with
contributing_agents populated by AXL agent IDs (proves cross-node comms ran).
"""
from __future__ import annotations

import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass

from .agent import AgentSpec, run_agent
from .axl_client import AxlClient, Belief
from .nodes import NodeMesh, RunningNode

log = logging.getLogger("meridian.swarm.orchestrator")


def _aggregate_beliefs(
    beliefs: list[Belief],
    outcomes: list[str],
) -> tuple[dict[str, float], float]:
    """Confidence-weighted average of probabilities across all final beliefs.

    Returns (consensus_prediction, mean_confidence).
    """
    if not beliefs:
        return ({o: 1.0 / len(outcomes) for o in outcomes}, 0.0)

    weights = [max(b.confidence, 0.05) for b in beliefs]
    total_w = sum(weights)
    consensus: dict[str, float] = {}
    for o in outcomes:
        weighted = sum(b.probabilities.get(o, 0.0) * w for b, w in zip(beliefs, weights))
        consensus[o] = weighted / total_w
    norm = sum(consensus.values()) or 1.0
    consensus = {o: v / norm for o, v in consensus.items()}
    mean_conf = sum(weights) / len(weights)
    return consensus, mean_conf


def _summarise_reasoning(beliefs: list[Belief]) -> tuple[str, list[str]]:
    """Pick the highest-confidence reasoning + extract distinct factor bullets."""
    if not beliefs:
        return ("", [])
    sorted_b = sorted(beliefs, key=lambda b: b.confidence, reverse=True)
    head = sorted_b[0].reasoning
    # take the first sentence of the next 5 distinct agents as "key factors"
    seen: set[str] = set()
    factors: list[str] = []
    for b in sorted_b[1:6]:
        first_sent = b.reasoning.split(".")[0].strip()
        if first_sent and first_sent not in seen:
            seen.add(first_sent)
            factors.append(first_sent)
    return head, factors


@dataclass
class SwarmRunResult:
    consensus: dict[str, float]
    confidence: float
    reasoning: str
    key_factors: list[str]
    contributing_agents: list[str]
    rounds: int
    elapsed_s: float
    node_keys: list[str]
    raw_beliefs: int


def run_axl_swarm(
    *,
    seed_doc: str,
    market_id: str,
    outcomes: list[str],
    agents_per_node: int = 7,
    rounds: int = 2,
    gossip_window_s: float = 2.5,
    mesh: NodeMesh | None = None,
) -> SwarmRunResult:
    """Spin up the AXL mesh + agents, run rounds, tear down, return aggregate."""
    own_mesh = mesh is None
    if own_mesh:
        mesh = NodeMesh()
    nodes: list[RunningNode] = mesh.start() if own_mesh else mesh.running
    if not nodes:
        raise RuntimeError("mesh has no running nodes")

    t0 = time.perf_counter()
    specs: list[AgentSpec] = []
    for ni, node in enumerate(nodes):
        for ai in range(agents_per_node):
            specs.append(AgentSpec(
                agent_id=f"node-{node.spec.name}/agent-{ai}",
                node_index=ni,
                api_url=node.api_url,
                node_pubkey=node.public_key,
            ))

    log.info(
        "running %d agents across %d nodes for market %s (rounds=%d)",
        len(specs), len(nodes), market_id, rounds,
    )

    final_beliefs: list[Belief] = []
    try:
        # run agents in a thread pool — each is mostly waiting on LLM network IO
        with ThreadPoolExecutor(max_workers=len(specs)) as pool:
            futures = [
                pool.submit(
                    run_agent,
                    spec=s,
                    seed_doc=seed_doc,
                    market_id=market_id,
                    outcomes=outcomes,
                    rounds=rounds,
                    gossip_window_s=gossip_window_s,
                )
                for s in specs
            ]
            for fut in as_completed(futures):
                try:
                    b = fut.result()
                    if b is not None:
                        final_beliefs.append(b)
                except Exception as e:
                    log.warning("agent crashed: %s", e)

        consensus, mean_conf = _aggregate_beliefs(final_beliefs, outcomes)
        reasoning, factors = _summarise_reasoning(final_beliefs)
        elapsed = time.perf_counter() - t0

        return SwarmRunResult(
            consensus=consensus,
            confidence=round(mean_conf, 3),
            reasoning=reasoning,
            key_factors=factors,
            contributing_agents=[b.agent_id for b in final_beliefs],
            rounds=rounds,
            elapsed_s=round(elapsed, 2),
            node_keys=[n.public_key for n in nodes],
            raw_beliefs=len(final_beliefs),
        )
    finally:
        if own_mesh:
            mesh.stop()
