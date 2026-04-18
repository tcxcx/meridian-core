"""Stdlib HTTP wrapper for an AXL node's local API.

Modeled on `gensyn-ai/collaborative-autoresearch-demo/skills/autoresearch-network/research_network.py`,
specialised for MERIDIAN belief gossip. One client = one local node.
"""
from __future__ import annotations

import json
import logging
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Optional

PROTO_VERSION = 1
MSG_TYPE_BELIEF = "belief"

log = logging.getLogger("meridian.axl")


@dataclass
class Belief:
    """One agent's probability estimate for a market's outcomes."""

    proto: int
    type: str
    market_id: str
    outcomes: list[str]
    probabilities: dict[str, float]   # outcome → probability (sums to ~1.0)
    confidence: float                 # 0..1
    reasoning: str
    agent_id: str                     # local id like "node-a/agent-3"
    node_id: str                      # AXL public key of the node it ran on
    round: int
    timestamp: float
    sender_id: str = ""               # filled by transport layer on receive

    def to_dict(self) -> dict:
        return {
            "proto": self.proto,
            "type": self.type,
            "market_id": self.market_id,
            "outcomes": self.outcomes,
            "probabilities": self.probabilities,
            "confidence": self.confidence,
            "reasoning": self.reasoning,
            "agent_id": self.agent_id,
            "node_id": self.node_id,
            "round": self.round,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Belief":
        return cls(
            proto=int(d.get("proto", PROTO_VERSION)),
            type=str(d.get("type", MSG_TYPE_BELIEF)),
            market_id=str(d["market_id"]),
            outcomes=[str(o) for o in d["outcomes"]],
            probabilities={str(k): float(v) for k, v in d["probabilities"].items()},
            confidence=float(d.get("confidence", 0.5)),
            reasoning=str(d.get("reasoning", "")),
            agent_id=str(d.get("agent_id", "")),
            node_id=str(d.get("node_id", "")),
            round=int(d.get("round", 0)),
            timestamp=float(d.get("timestamp", time.time())),
        )


def _get(url: str, timeout: int = 5) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, {}, b""
    except Exception as e:
        log.debug("GET %s failed: %s", url, e)
        return 0, {}, b""


def _post(url: str, data: bytes, headers: dict, timeout: int = 10) -> tuple[int, dict, bytes]:
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        return e.code, {}, body
    except Exception as e:
        log.debug("POST %s failed: %s", url, e)
        return 0, {}, b""


@dataclass
class AxlClient:
    api_url: str = "http://127.0.0.1:9002"
    _our_id: Optional[str] = field(default=None, repr=False)

    def topology(self) -> Optional[dict]:
        code, _, body = _get(f"{self.api_url.rstrip('/')}/topology")
        if code != 200:
            return None
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            return None

    def our_id(self) -> Optional[str]:
        if self._our_id is None:
            t = self.topology()
            if t:
                self._our_id = t.get("our_public_key")
        return self._our_id

    def all_peer_ids(self) -> list[str]:
        """Direct peers + everyone in the spanning tree, minus ourselves."""
        t = self.topology() or {}
        our = t.get("our_public_key", "")
        ids: set[str] = set()
        for p in t.get("peers", []) or []:
            if p.get("up") and p.get("public_key"):
                ids.add(p["public_key"])
        for n in t.get("tree", []) or []:
            if n.get("public_key"):
                ids.add(n["public_key"])
        ids.discard(our)
        return sorted(ids)

    def broadcast(self, belief: Belief) -> int:
        """POST /send to every reachable peer. Returns count successfully delivered."""
        peers = self.all_peer_ids()
        if not peers:
            log.warning("[%s] no peers reachable, belief not broadcast", self.api_url)
            return 0
        payload = json.dumps(belief.to_dict()).encode("utf-8")
        sent = 0
        for pid in peers:
            code, _, body = _post(
                f"{self.api_url.rstrip('/')}/send",
                data=payload,
                headers={
                    "X-Destination-Peer-Id": pid,
                    "Content-Type": "application/octet-stream",
                },
            )
            if code == 200:
                sent += 1
            else:
                log.debug("send to %s returned %s: %s", pid[:12], code, body[:120])
        log.info(
            "[%s] %s round=%s broadcast %d/%d peers",
            self.api_url, belief.agent_id, belief.round, sent, len(peers),
        )
        return sent

    def drain(self) -> list[Belief]:
        """Pop everything pending on /recv. Skips messages that aren't beliefs."""
        out: list[Belief] = []
        while True:
            code, headers, body = _get(f"{self.api_url.rstrip('/')}/recv", timeout=3)
            if code == 204:
                break
            if code != 200:
                if code != 0:
                    log.warning("recv returned %s", code)
                break
            sender = headers.get("X-From-Peer-Id") or headers.get("x-from-peer-id") or ""
            try:
                d = json.loads(body)
            except json.JSONDecodeError:
                continue
            if d.get("type") != MSG_TYPE_BELIEF:
                continue
            try:
                b = Belief.from_dict(d)
            except (KeyError, TypeError, ValueError) as e:
                log.warning("malformed belief from %s: %s", sender[:12], e)
                continue
            if sender:
                b.sender_id = sender
            out.append(b)
        return out
