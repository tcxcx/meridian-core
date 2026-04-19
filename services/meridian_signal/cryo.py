"""C-02 · Cryo scanner: rolling z-score on entropy across many markets.

For each market we keep the last N entropy readings (per process). A market
is "latched" as cryo when:
    1) current H sits below the entropy tier threshold (tier ≥ 1), AND
    2) the z-score of current H vs its own rolling history is ≤ -0.5 (i.e.
       the freeze is a regime change, not just a perpetually thin book).

The history is a deque per token, refreshed every time `scan()` runs.
Reset / cold-start behaviour: with < `MIN_HISTORY` samples we fall back to
the raw entropy tier so the first scan still produces useful output.
"""
from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import asdict, dataclass

from . import entropy as entropy_mod
from . import polymarket

WINDOW = 30                # samples per token kept for z-score
MIN_HISTORY = 5            # below this, skip z-score and use raw tier
Z_LATCH = -0.5             # H must be at least 0.5σ below own mean to latch
SPARK_LEN = 24             # samples returned in `spark` for UI sparkline

_HIST: dict[str, deque[tuple[float, float]]] = {}  # token_id -> deque[(ts, h)]


@dataclass
class CryoRow:
    market_id: str
    slug: str
    question: str
    token_id: str
    outcome: str
    h_bits: float
    h_mean: float | None
    h_sigma: float | None
    z_score: float | None
    tier: int
    latched: bool
    levels: int
    total_size: float
    spread_bps: float | None
    mid: float | None
    volume_usd: float
    liquidity_usd: float
    spark: list[float]

    def to_dict(self) -> dict:
        return asdict(self)


def _push(token_id: str, h: float) -> deque[tuple[float, float]]:
    dq = _HIST.get(token_id)
    if dq is None:
        dq = deque(maxlen=WINDOW)
        _HIST[token_id] = dq
    dq.append((time.time(), h))
    return dq


def _zscore(h: float, hist: deque[tuple[float, float]]) -> tuple[float | None, float | None, float | None]:
    if len(hist) < MIN_HISTORY:
        return None, None, None
    samples = [v for (_, v) in hist]
    mean = sum(samples) / len(samples)
    var = sum((v - mean) ** 2 for v in samples) / max(1, len(samples) - 1)
    sigma = math.sqrt(var)
    if sigma <= 1e-9:
        return mean, sigma, 0.0
    return mean, sigma, (h - mean) / sigma


def _spark(hist: deque[tuple[float, float]]) -> list[float]:
    return [round(v, 3) for (_, v) in list(hist)[-SPARK_LEN:]]


def _row_for_market(m, *, primary_outcome_idx: int = 0) -> CryoRow | None:
    if not m.token_ids or not m.outcomes:
        return None
    idx = primary_outcome_idx if primary_outcome_idx < len(m.token_ids) else 0
    token_id = m.token_ids[idx]
    outcome = m.outcomes[idx] if idx < len(m.outcomes) else "?"
    book = polymarket.get_orderbook(token_id)
    reading = entropy_mod.read(token_id, book=book)
    hist = _push(token_id, reading.h_bits)
    mean, sigma, z = _zscore(reading.h_bits, hist)

    if z is None:
        latched = reading.tier >= 1
    else:
        latched = reading.tier >= 1 and z <= Z_LATCH

    return CryoRow(
        market_id=m.market_id,
        slug=m.slug,
        question=m.question,
        token_id=token_id,
        outcome=outcome,
        h_bits=reading.h_bits,
        h_mean=round(mean, 4) if mean is not None else None,
        h_sigma=round(sigma, 4) if sigma is not None else None,
        z_score=round(z, 3) if z is not None else None,
        tier=reading.tier,
        latched=latched,
        levels=reading.levels,
        total_size=reading.total_size,
        spread_bps=reading.spread_bps,
        mid=reading.mid,
        volume_usd=m.volume_usd,
        liquidity_usd=m.liquidity_usd,
        spark=_spark(hist),
    )


def scan(*, limit: int = 10, min_liquidity_usd: float = 5_000.0) -> list[CryoRow]:
    markets = polymarket.discover_markets(limit=limit, min_liquidity_usd=min_liquidity_usd)
    rows: list[CryoRow] = []
    for m in markets:
        row = _row_for_market(m)
        if row is not None:
            rows.append(row)
    rows.sort(key=lambda r: (-r.tier, (r.z_score if r.z_score is not None else 0.0)))
    return rows


def stats() -> dict:
    """Brief summary of in-memory state for /health and dashboard footers."""
    return {
        "tracked_tokens": len(_HIST),
        "window": WINDOW,
        "min_history": MIN_HISTORY,
        "z_latch": Z_LATCH,
    }
