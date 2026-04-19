"""E-01 · Shannon entropy across a Polymarket CLOB orderbook.

H = -Σ p_i log2(p_i) where p_i = size_i / total_size summed across both
sides of the book. Low H means depth is concentrated on a few price levels
(usually a manipulated/inactive market — what Cryo calls "frozen"). High H
means broad participation across many levels.

Thresholds (calibrated by eye on Polymarket sample books):
    H < 1.60  → tier 2 (deep freeze)
    H < 1.86  → tier 1 (frozen)
    H ≥ 1.86  → tier 0 (active)
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

from . import polymarket

THR_T1 = 1.86
THR_T2 = 1.60
H_FLOOR = 1.30
H_CEIL = 2.20


@dataclass
class EntropyReading:
    token_id: str
    h_bits: float
    tier: int
    frozen: bool
    levels: int
    total_size: float
    bid_depth: float
    ask_depth: float
    spread_bps: float | None
    mid: float | None

    def to_dict(self) -> dict:
        return asdict(self)


def shannon_entropy(book: dict | None) -> tuple[float, int, float]:
    """Returns (H_bits, level_count, total_size). H = 0.0 if book is empty."""
    if not book:
        return 0.0, 0, 0.0
    sizes: list[float] = []
    for side in ("bids", "asks"):
        for row in book.get(side, []) or []:
            s = float(row.get("size") or 0.0)
            if s > 0.0:
                sizes.append(s)
    total = sum(sizes)
    if total <= 0.0 or len(sizes) <= 1:
        return 0.0, len(sizes), total
    h = 0.0
    for s in sizes:
        p = s / total
        h -= p * math.log2(p)
    return h, len(sizes), total


def tier_for(h: float) -> int:
    if h < THR_T2:
        return 2
    if h < THR_T1:
        return 1
    return 0


def _spread_bps(book: dict | None) -> tuple[float | None, float | None]:
    """Returns (spread_bps, mid_price) using best bid + best ask."""
    if not book:
        return None, None
    bids = book.get("bids") or []
    asks = book.get("asks") or []
    if not bids or not asks:
        return None, None
    best_bid = max(float(r.get("price") or 0.0) for r in bids)
    best_ask = min(float(r.get("price") or 0.0) for r in asks if float(r.get("price") or 0.0) > 0.0)
    if best_bid <= 0.0 or best_ask <= 0.0:
        return None, None
    mid = (best_bid + best_ask) / 2.0
    if mid <= 0.0:
        return None, mid
    return ((best_ask - best_bid) / mid) * 10_000.0, mid


def read(token_id: str, *, book: dict | None = None) -> EntropyReading:
    """Compute an EntropyReading for one token. Pass `book` to skip the HTTP fetch."""
    if book is None:
        book = polymarket.get_orderbook(token_id) or {"bids": [], "asks": []}
    h, levels, total = shannon_entropy(book)
    bid_depth = sum(float(r.get("size") or 0.0) for r in (book.get("bids") or []))
    ask_depth = sum(float(r.get("size") or 0.0) for r in (book.get("asks") or []))
    spread, mid = _spread_bps(book)
    t = tier_for(h) if total > 0.0 else 0
    return EntropyReading(
        token_id=token_id,
        h_bits=round(h, 4),
        tier=t,
        frozen=t > 0,
        levels=levels,
        total_size=round(total, 2),
        bid_depth=round(bid_depth, 2),
        ask_depth=round(ask_depth, 2),
        spread_bps=round(spread, 2) if spread is not None else None,
        mid=round(mid, 4) if mid is not None else None,
    )


def confidence_bias(tier: int) -> float:
    """How much to multiply downstream swarm confidence by, given entropy tier.

    Tier 2 = deep-freeze: signal is real but micro liquidity, slight haircut.
    Tier 1 = frozen: low-noise window, modest boost.
    Tier 0 = active: no change.
    """
    if tier >= 2:
        return 0.92
    if tier == 1:
        return 1.10
    return 1.0
