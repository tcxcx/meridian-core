"""Polymarket ↔ Kalshi event matcher.

Bucket 2 of autonomous-fund-arb. We need to know, for each Kalshi market
that's roughly the same question as a Polymarket market, what the implied
spread between the two YES prices looks like. The matcher pairs them by
question-text overlap (Jaccard on tokenised words minus stopwords).

The match is intentionally fuzzy and cheap: cross-venue arbs on prediction
markets are uncommon enough that we'd rather over-suggest pairs and let
the arb strategy filter on price-edge than miss a real arb because the
two venues phrased the question slightly differently.

We cache the pair list in-process with a TTL so the orchestrator's
per-tick `/arb/pairs` call doesn't hammer Gamma + Kalshi every minute.
"""
from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass
from threading import Lock

from . import kalshi, polymarket

log = logging.getLogger("meridian.signal.matcher")

# Common English stopwords + prediction-market chrome words that don't
# discriminate between markets ("will", "by", "before", year tokens).
_STOPWORDS: frozenset[str] = frozenset({
    "a", "an", "and", "any", "are", "as", "at", "be", "before", "by",
    "for", "from", "has", "have", "if", "in", "is", "it", "its", "of",
    "on", "or", "than", "that", "the", "this", "to", "until", "was",
    "were", "will", "with",
    # market chrome
    "market", "prediction", "yes", "no", "happen", "occur",
})

_TOKEN_RE = re.compile(r"[a-z0-9]+")

# Minimum Jaccard similarity to call two markets a pair. 0.30 is loose
# enough to catch "Will Trump win 2024" ↔ "Trump wins 2024 election" but
# tight enough to keep "will Lakers win" off "will Celtics win" lists.
DEFAULT_MIN_SCORE = 0.30


def _tokens(s: str) -> set[str]:
    return {t for t in _TOKEN_RE.findall(s.lower()) if t not in _STOPWORDS and len(t) > 1}


def _jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / float(len(a | b))


@dataclass(frozen=True)
class MatchedPair:
    """One Polymarket ↔ Kalshi pair with current best YES prices.

    `implied_edge_pp` is the percentage-point gap between the two YES
    mids; the arb strategy treats |edge| > min_arb_edge_pp as a signal
    and trades the cheap leg on Polymarket while marking the Kalshi
    leg as a paper hedge.
    """
    poly_market_id: str
    poly_slug: str
    poly_question: str
    poly_yes_token_id: str    # CLOB token id for the YES outcome on Polymarket
    poly_yes_price: float     # 0..1, current outcome price
    kalshi_ticker: str
    kalshi_title: str
    kalshi_yes_mid: float     # 0..1, normalised from cents
    score: float              # Jaccard similarity 0..1
    implied_edge_pp: float    # (poly_yes - kalshi_yes) * 100  → percentage points

    def to_dict(self) -> dict:
        return {
            "poly_market_id": self.poly_market_id,
            "poly_slug": self.poly_slug,
            "poly_question": self.poly_question,
            "poly_yes_token_id": self.poly_yes_token_id,
            "poly_yes_price": self.poly_yes_price,
            "kalshi_ticker": self.kalshi_ticker,
            "kalshi_title": self.kalshi_title,
            "kalshi_yes_mid": self.kalshi_yes_mid,
            "score": round(self.score, 4),
            "implied_edge_pp": round(self.implied_edge_pp, 4),
        }


def _yes_index(outcomes: list[str]) -> int | None:
    """Best-effort: locate the YES outcome in a Polymarket outcomes list."""
    for i, o in enumerate(outcomes):
        if str(o).strip().lower() in {"yes", "y"}:
            return i
    return None


def _build_pairs(
    poly_markets: list[polymarket.MarketSummary],
    kalshi_markets: list[kalshi.KalshiMarket],
    *,
    min_score: float,
) -> list[MatchedPair]:
    poly_tokens: list[set[str]] = [_tokens(m.question) for m in poly_markets]
    kalshi_tokens: list[set[str]] = [_tokens(m.title or m.subtitle) for m in kalshi_markets]

    pairs: list[MatchedPair] = []
    for i, p in enumerate(poly_markets):
        yes_idx = _yes_index(p.outcomes)
        if yes_idx is None or yes_idx >= len(p.token_ids) or yes_idx >= len(p.outcome_prices):
            continue
        # Find the Kalshi market with the highest Jaccard for this Polymarket question.
        best_j = -1
        best_score = 0.0
        for j, k in enumerate(kalshi_markets):
            s = _jaccard(poly_tokens[i], kalshi_tokens[j])
            if s > best_score:
                best_score = s
                best_j = j
        if best_j < 0 or best_score < min_score:
            continue
        k = kalshi_markets[best_j]
        poly_yes = float(p.outcome_prices[yes_idx])
        kalshi_yes = float(k.yes_mid)
        pairs.append(MatchedPair(
            poly_market_id=p.market_id,
            poly_slug=p.slug,
            poly_question=p.question,
            poly_yes_token_id=p.token_ids[yes_idx],
            poly_yes_price=poly_yes,
            kalshi_ticker=k.ticker,
            kalshi_title=k.title,
            kalshi_yes_mid=kalshi_yes,
            score=best_score,
            implied_edge_pp=(poly_yes - kalshi_yes) * 100.0,
        ))
    pairs.sort(key=lambda p: abs(p.implied_edge_pp), reverse=True)
    return pairs


# ----- in-process TTL cache -----
_CACHE_TTL_S = 30.0
_cache_lock = Lock()
_cache: dict[tuple, tuple[float, list[MatchedPair]]] = {}


def discover_pairs(
    *,
    poly_limit: int = 20,
    poly_min_liquidity_usd: float = 5_000.0,
    kalshi_limit: int = 50,
    kalshi_min_volume_24h: float = 1_000.0,
    min_score: float = DEFAULT_MIN_SCORE,
    cache: bool = True,
) -> list[MatchedPair]:
    """Discover Polymarket↔Kalshi pairs ranked by |implied_edge_pp|.

    Best-effort: if either venue is unreachable we return whatever we
    have (possibly `[]`). Per-venue failure does NOT raise.
    """
    key = (poly_limit, poly_min_liquidity_usd, kalshi_limit, kalshi_min_volume_24h, round(min_score, 3))
    now = time.time()
    if cache:
        with _cache_lock:
            hit = _cache.get(key)
            if hit and (now - hit[0]) < _CACHE_TTL_S:
                return list(hit[1])

    try:
        poly_markets = polymarket.discover_markets(
            limit=poly_limit, min_liquidity_usd=poly_min_liquidity_usd,
        )
    except Exception as e:  # noqa: BLE001 — Polymarket flake shouldn't kill the route
        log.warning("polymarket discover failed: %s", e)
        poly_markets = []

    kalshi_markets = kalshi.discover_markets(
        limit=kalshi_limit, min_volume_24h=kalshi_min_volume_24h,
    )

    pairs = _build_pairs(poly_markets, kalshi_markets, min_score=min_score)

    if cache:
        with _cache_lock:
            _cache[key] = (now, pairs)
    return pairs
