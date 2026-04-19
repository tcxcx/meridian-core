"""T-03 · Topology: cross-market coordination detector.

Tracks rolling mid-price history per scanned Polymarket token. Each `scan()`
recomputes log returns over the window and Pearson-correlates every pair
with enough history. Pairs above `R_LATCH` are graph edges; connected
components (union-find) are clusters.

Why this matters:
    · risk · don't open positions in two markets that are highly correlated
      (the swarm sees them as independent edges; the venue does not)
    · alarm · independent markets coordinating in lockstep is unusual and
      worth re-running the swarm with the cluster as a single asset

Cold-start: with < MIN_HISTORY samples per token we skip pair correlations
rather than report noise. The first few scans only fill history.
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import asdict, dataclass

from . import polymarket

WINDOW = 30          # mid-price samples kept per token
MIN_HISTORY = 6      # samples needed before a token is included in pair correlations
R_LATCH = 0.70       # |Pearson r| above which a pair becomes an edge
TOP_EDGES = 12       # cap on returned edges (sorted by |r|)

_HIST: dict[str, deque[tuple[float, float]]] = {}   # token_id → deque[(ts, mid)]
_META: dict[str, dict] = {}                          # token_id → label cache


@dataclass
class TopologyEdge:
    a_token: str
    b_token: str
    a_market: str
    b_market: str
    a_label: str
    b_label: str
    r: float
    n: int

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class TopologyCluster:
    members: list[str]   # token_ids
    labels: list[str]
    market_ids: list[str]
    size: int

    def to_dict(self) -> dict:
        return asdict(self)


def _push(token_id: str, mid: float) -> deque[tuple[float, float]]:
    dq = _HIST.get(token_id)
    if dq is None:
        dq = deque(maxlen=WINDOW)
        _HIST[token_id] = dq
    dq.append((time.time(), mid))
    return dq


def _returns(hist: deque[tuple[float, float]]) -> list[float]:
    """Log returns between consecutive mids."""
    series = [v for (_, v) in hist if v > 0.0]
    if len(series) < 2:
        return []
    out: list[float] = []
    for prev, cur in zip(series, series[1:]):
        if prev > 0.0 and cur > 0.0:
            out.append(math.log(cur / prev))
        else:
            out.append(0.0)
    return out


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = min(len(xs), len(ys))
    if n < 3:
        return None
    xs, ys = xs[-n:], ys[-n:]
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx <= 1e-12 or syy <= 1e-12:
        return None
    return sxy / math.sqrt(sxx * syy)


class _UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def add(self, x: str) -> None:
        if x not in self.parent:
            self.parent[x] = x

    def find(self, x: str) -> str:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        self.add(a)
        self.add(b)
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra

    def groups(self) -> dict[str, list[str]]:
        out: dict[str, list[str]] = {}
        for x in self.parent:
            out.setdefault(self.find(x), []).append(x)
        return out


def _label_for(token_id: str) -> tuple[str, str]:
    meta = _META.get(token_id)
    if not meta:
        return "?", token_id[:10]
    q = meta.get("question") or meta.get("slug") or "?"
    o = meta.get("outcome") or "?"
    if len(q) > 60:
        q = q[:57] + "…"
    return meta.get("market_id", "?"), f"{q} · {o}"


def scan(*, limit: int = 10, min_liquidity_usd: float = 5_000.0) -> dict:
    """Discover, refresh per-token mid history, recompute edges + clusters."""
    markets = polymarket.discover_markets(limit=limit, min_liquidity_usd=min_liquidity_usd)

    fresh_tokens: list[str] = []
    for m in markets:
        if not m.token_ids or not m.outcomes:
            continue
        token_id = m.token_ids[0]
        outcome = m.outcomes[0]
        mid = polymarket.get_orderbook_midprice(token_id)
        if mid is None and m.outcome_prices:
            mid = m.outcome_prices[0]
        if mid is None or mid <= 0.0:
            continue
        _push(token_id, float(mid))
        _META[token_id] = {
            "market_id": m.market_id,
            "slug": m.slug,
            "question": m.question,
            "outcome": outcome,
        }
        fresh_tokens.append(token_id)

    eligible = [t for t in fresh_tokens if len(_HIST[t]) >= MIN_HISTORY]
    returns_cache = {t: _returns(_HIST[t]) for t in eligible}

    edges: list[TopologyEdge] = []
    uf = _UnionFind()
    for t in eligible:
        uf.add(t)
    for i, a in enumerate(eligible):
        for b in eligible[i + 1:]:
            xs, ys = returns_cache[a], returns_cache[b]
            r = _pearson(xs, ys)
            if r is None or abs(r) < R_LATCH:
                continue
            n = min(len(xs), len(ys))
            a_market, a_label = _label_for(a)
            b_market, b_label = _label_for(b)
            edges.append(TopologyEdge(
                a_token=a, b_token=b,
                a_market=a_market, b_market=b_market,
                a_label=a_label, b_label=b_label,
                r=round(r, 3), n=n,
            ))
            uf.union(a, b)

    edges.sort(key=lambda e: abs(e.r), reverse=True)
    edges = edges[:TOP_EDGES]

    clusters: list[TopologyCluster] = []
    for _root, members in uf.groups().items():
        if len(members) < 2:
            continue
        labels: list[str] = []
        market_ids: list[str] = []
        for t in members:
            mid_, lab = _label_for(t)
            labels.append(lab)
            market_ids.append(mid_)
        clusters.append(TopologyCluster(
            members=members, labels=labels, market_ids=market_ids, size=len(members),
        ))
    clusters.sort(key=lambda c: c.size, reverse=True)

    return {
        "scanned": len(markets),
        "tracked": len(eligible),
        "edges": [e.to_dict() for e in edges],
        "clusters": [c.to_dict() for c in clusters],
        "stats": stats(),
    }


def correlated_with(token_id: str, threshold: float = R_LATCH) -> list[dict]:
    """Risk lookup: tokens correlated with `token_id` above threshold.

    Uses cached history only — no network calls. Returns [] if cold.
    """
    if token_id not in _HIST or len(_HIST[token_id]) < MIN_HISTORY:
        return []
    base = _returns(_HIST[token_id])
    out: list[dict] = []
    for other, hist in _HIST.items():
        if other == token_id or len(hist) < MIN_HISTORY:
            continue
        r = _pearson(base, _returns(hist))
        if r is None or abs(r) < threshold:
            continue
        m_id, label = _label_for(other)
        out.append({
            "token_id": other,
            "market_id": m_id,
            "label": label,
            "r": round(r, 3),
        })
    out.sort(key=lambda e: abs(e["r"]), reverse=True)
    return out


def stats() -> dict:
    return {
        "tracked_tokens": len(_HIST),
        "window": WINDOW,
        "min_history": MIN_HISTORY,
        "r_latch": R_LATCH,
    }
