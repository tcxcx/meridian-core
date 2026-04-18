"""Deterministic proof that messages cross AXL node boundaries.

No LLM. Spins up the 3-node mesh, broadcasts one Belief from each node,
drains the other two, asserts at least one delivery from each peer's pubkey.

Run:
    cd meridian-core/services
    uv run python -m swarm_runner.test_cross_node

Exit 0 = mesh proven; non-zero = cross-node delivery failed.
"""
from __future__ import annotations

import logging
import sys
import time

from .axl_client import AxlClient, Belief, MSG_TYPE_BELIEF, PROTO_VERSION
from .nodes import NodeMesh

log = logging.getLogger("meridian.swarm.crosstest")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    mesh = NodeMesh()
    nodes = mesh.start()
    try:
        pubs = [n.public_key for n in nodes]
        names = [n.spec.name for n in nodes]
        clients = [
            AxlClient(api_url=n.api_url, known_peers=[p for p in pubs if p != n.public_key])
            for n in nodes
        ]
        for i, n in enumerate(nodes):
            log.info("node-%s pubkey=%s api=%s", names[i], pubs[i][:16], n.api_url)

        # Wait until every node sees BOTH other peers in its spanning tree.
        # In hub-and-spoke, spokes need a moment to learn each other via the hub.
        deadline = time.time() + 15.0
        while time.time() < deadline:
            visibility = [len(c.all_peer_ids()) for c in clients]
            if all(v >= 2 for v in visibility):
                log.info("spanning tree converged: peer counts = %s", visibility)
                break
            time.sleep(0.5)
        else:
            log.warning("spanning tree didn't fully converge: %s", visibility)

        # Each node broadcasts a unique belief
        broadcasts: list[tuple[str, int]] = []  # (sender_name, peers_delivered)
        for i, c in enumerate(clients):
            belief = Belief(
                proto=PROTO_VERSION,
                type=MSG_TYPE_BELIEF,
                market_id=f"crosstest-from-node-{names[i]}",
                outcomes=["Yes", "No"],
                probabilities={"Yes": 0.42, "No": 0.58},
                confidence=0.99,
                reasoning=f"sentinel from node-{names[i]}",
                agent_id=f"node-{names[i]}/sentinel",
                node_id=pubs[i],
                round=0,
                timestamp=time.time(),
            )
            sent = c.broadcast(belief)
            broadcasts.append((names[i], sent))
            log.info("node-%s broadcast → %d peers", names[i], sent)

        # Give Yggdrasil a beat to deliver
        time.sleep(2.0)

        # Drain each node and check what arrived.
        # NOTE: Yggdrasil's X-From-Peer-Id is a routing ID derived from the
        # ed25519 pubkey; the leading 16 hex chars (64 bits) match the pubkey
        # prefix. Compare by prefix.
        PFX = 16
        verdict_ok = True
        for i, c in enumerate(clients):
            received = c.drain()
            our_pfx = pubs[i][:PFX]
            cross_node = [
                b for b in received
                if b.sender_id and b.sender_id[:PFX] != our_pfx
            ]
            sender_pfxs = sorted({b.sender_id[:PFX] for b in cross_node})
            sentinel_markets = sorted({b.market_id for b in cross_node})
            log.info(
                "node-%s drained=%d cross_node=%d senders=%s markets=%s",
                names[i], len(received), len(cross_node),
                sender_pfxs, sentinel_markets,
            )
            expected = {pubs[j][:PFX] for j in range(3) if j != i}
            actual = {b.sender_id[:PFX] for b in cross_node}
            missing = expected - actual
            if missing:
                log.error(
                    "node-%s MISSING sentinel from peers: %s",
                    names[i], sorted(missing),
                )
                verdict_ok = False

        if verdict_ok:
            print("\nVERDICT: ✓ AXL cross-node message-passing proven")
            print("  every node received a sentinel belief from every other node")
            return 0
        print("\nVERDICT: ✗ at least one cross-node delivery failed")
        return 1
    finally:
        mesh.stop()


if __name__ == "__main__":
    sys.exit(main())
