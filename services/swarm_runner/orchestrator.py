"""Phase 2 orchestrator: spawn N agents across 3 AXL nodes, aggregate beliefs into a swarm signal.

Public API:
    run_axl_swarm(seed_doc, market_id, outcomes, agents_per_node=7, rounds=2) -> dict

Returns the same shape that meridian_signal.swarm.SwarmOutput expects, with
contributing_agents populated by AXL agent IDs (proves cross-node comms ran).
"""
from __future__ import annotations

import logging
import os
import queue
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Iterator

from .agent import AgentSpec, reset_inboxes, run_agent
from .axl_client import (
    MSG_TYPE_BELIEF,
    PROTO_VERSION,
    AxlClient,
    Belief,
)
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


def _build_specs(
    nodes: list[RunningNode], agents_per_node: int
) -> list[AgentSpec]:
    all_pubs = [n.public_key for n in nodes]
    specs: list[AgentSpec] = []
    for ni, node in enumerate(nodes):
        peer_pubs = [p for p in all_pubs if p != node.public_key]
        for ai in range(agents_per_node):
            specs.append(AgentSpec(
                agent_id=f"node-{node.spec.name}/agent-{ai}",
                node_index=ni,
                api_url=node.api_url,
                node_pubkey=node.public_key,
                peer_pubkeys=peer_pubs,
            ))
    return specs


def stream_axl_swarm(
    *,
    seed_doc: str,
    market_id: str,
    outcomes: list[str],
    agents_per_node: int = 7,
    rounds: int = 2,
    gossip_window_s: float = 2.5,
    mesh: NodeMesh | None = None,
) -> Iterator[dict]:
    """Generator variant of `run_axl_swarm`.

    Yields one event dict per agent completion, then a final aggregate event.
    Event shapes:
        {"type": "start",  "nodes": [...], "specs": N, "rounds": R}
        {"type": "belief", "agent_id": "...", "node_id": "...", "round": R,
                            "probabilities": {...}, "confidence": float,
                            "reasoning": str, "ts": float}
        {"type": "agent_error", "agent_id": "...", "error": str}
        {"type": "result", "result": SwarmRunResult-as-dict}

    The dashboard SSE endpoint adapts these to text/event-stream frames.
    """
    own_mesh = mesh is None
    if own_mesh:
        mesh = NodeMesh()
    nodes: list[RunningNode] = mesh.start() if own_mesh else mesh.running
    if not nodes:
        raise RuntimeError("mesh has no running nodes")
    reset_inboxes()

    t0 = time.perf_counter()
    specs = _build_specs(nodes, agents_per_node)

    yield {
        "type": "start",
        "nodes": [n.public_key for n in nodes],
        "specs": len(specs),
        "rounds": rounds,
        "market_id": market_id,
        "ts": time.time(),
    }
    log.info(
        "streaming %d agents across %d nodes for market %s (rounds=%d)",
        len(specs), len(nodes), market_id, rounds,
    )

    # Agents push to this queue from worker threads as they finalise.
    events: queue.Queue[dict | None] = queue.Queue()

    def _worker(spec: AgentSpec) -> None:
        try:
            b = run_agent(
                spec=spec,
                seed_doc=seed_doc,
                market_id=market_id,
                outcomes=outcomes,
                rounds=rounds,
                gossip_window_s=gossip_window_s,
            )
            if b is not None:
                events.put({
                    "type": "belief",
                    "agent_id": b.agent_id,
                    "node_id": b.node_id,
                    "round": b.round,
                    "probabilities": b.probabilities,
                    "confidence": b.confidence,
                    "reasoning": b.reasoning,
                    "ts": b.timestamp,
                })
        except Exception as e:
            log.warning("agent %s crashed: %s", spec.agent_id, e)
            events.put({
                "type": "agent_error",
                "agent_id": spec.agent_id,
                "error": str(e),
            })

    final_beliefs: list[Belief] = []
    try:
        with ThreadPoolExecutor(max_workers=len(specs)) as pool:
            futures = [pool.submit(_worker, s) for s in specs]
            remaining = len(futures)
            while remaining > 0:
                evt = events.get()
                if evt is None:
                    continue
                yield evt
                if evt["type"] in ("belief", "agent_error"):
                    remaining -= 1
                    if evt["type"] == "belief":
                        # Reconstruct minimal Belief for aggregation.
                        final_beliefs.append(Belief(
                            proto=PROTO_VERSION,
                            type=MSG_TYPE_BELIEF,
                            market_id=market_id,
                            outcomes=outcomes,
                            probabilities=evt["probabilities"],
                            confidence=evt["confidence"],
                            reasoning=evt["reasoning"],
                            agent_id=evt["agent_id"],
                            node_id=evt["node_id"],
                            round=evt["round"],
                            timestamp=evt["ts"],
                        ))
            for fut in as_completed(futures):
                fut.result  # propagate worker exits

        consensus, mean_conf = _aggregate_beliefs(final_beliefs, outcomes)
        reasoning, factors = _summarise_reasoning(final_beliefs)
        elapsed = time.perf_counter() - t0
        result = SwarmRunResult(
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
        yield {"type": "result", "result": {
            "consensus": result.consensus,
            "confidence": result.confidence,
            "reasoning": result.reasoning,
            "key_factors": result.key_factors,
            "contributing_agents": result.contributing_agents,
            "rounds": result.rounds,
            "elapsed_s": result.elapsed_s,
            "node_keys": result.node_keys,
            "raw_beliefs": result.raw_beliefs,
        }, "ts": time.time()}
    finally:
        if own_mesh:
            mesh.stop()


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
    """Spin up the AXL mesh + agents, run rounds, tear down, return aggregate.

    Non-streaming wrapper preserved for existing callers (signal-gateway
    /api/signal/run, orchestrator daemon). For live debate output use
    `stream_axl_swarm` instead.
    """
    own_mesh = mesh is None
    if own_mesh:
        mesh = NodeMesh()
    nodes: list[RunningNode] = mesh.start() if own_mesh else mesh.running
    if not nodes:
        raise RuntimeError("mesh has no running nodes")
    reset_inboxes()

    t0 = time.perf_counter()
    specs = _build_specs(nodes, agents_per_node)

    log.info(
        "running %d agents across %d nodes for market %s (rounds=%d)",
        len(specs), len(nodes), market_id, rounds,
    )

    final_beliefs: list[Belief] = []
    try:
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
