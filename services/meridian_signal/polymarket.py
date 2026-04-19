"""Polymarket read-path: Gamma for discovery + metadata, CLOB for order book."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx

GAMMA_HOST = "https://gamma-api.polymarket.com"
CLOB_HOST = "https://clob.polymarket.com"


@dataclass
class MarketSummary:
    market_id: str          # condition_id (Gamma id)
    slug: str
    question: str
    description: str
    end_date_iso: str | None
    volume_usd: float
    liquidity_usd: float
    outcomes: list[str]
    token_ids: list[str]    # CLOB token IDs, one per outcome
    outcome_prices: list[float]  # current mid prices (0..1) parallel to outcomes


def _to_float(v: Any) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _parse_market(raw: dict) -> MarketSummary | None:
    # Gamma returns clobTokenIds + outcomePrices as JSON-encoded strings on the market.
    import json as _json

    try:
        token_ids = _json.loads(raw.get("clobTokenIds") or "[]")
        outcomes = _json.loads(raw.get("outcomes") or "[]")
        prices = [_to_float(p) for p in _json.loads(raw.get("outcomePrices") or "[]")]
    except (ValueError, TypeError):
        return None

    if not token_ids or not outcomes:
        return None

    return MarketSummary(
        market_id=str(raw.get("conditionId") or raw.get("id") or ""),
        slug=str(raw.get("slug") or ""),
        question=str(raw.get("question") or ""),
        description=str(raw.get("description") or "")[:2000],
        end_date_iso=raw.get("endDate"),
        volume_usd=_to_float(raw.get("volume")),
        liquidity_usd=_to_float(raw.get("liquidity")),
        outcomes=[str(o) for o in outcomes],
        token_ids=[str(t) for t in token_ids],
        outcome_prices=prices,
    )


def discover_markets(
    *,
    limit: int = 20,
    min_liquidity_usd: float = 5000.0,
    closed: bool = False,
    order: str = "volume24hr",
) -> list[MarketSummary]:
    """List active Polymarket markets ranked by 24h volume by default."""
    params = {
        "limit": limit * 3,  # over-fetch, filter, then truncate
        "active": "true",
        "closed": str(closed).lower(),
        "order": order,
        "ascending": "false",
    }
    with httpx.Client(timeout=15.0) as client:
        resp = client.get(f"{GAMMA_HOST}/markets", params=params)
        resp.raise_for_status()
        raws = resp.json()

    parsed: list[MarketSummary] = []
    for raw in raws:
        m = _parse_market(raw)
        if m is None:
            continue
        if m.liquidity_usd < min_liquidity_usd:
            continue
        parsed.append(m)
        if len(parsed) >= limit:
            break
    return parsed


def get_market(market_id: str) -> MarketSummary | None:
    """Fetch one market by condition_id or slug. Tries condition_id first."""
    with httpx.Client(timeout=15.0) as client:
        # condition_id lookup
        resp = client.get(
            f"{GAMMA_HOST}/markets",
            params={"condition_ids": market_id, "limit": 1},
        )
        if resp.status_code == 200:
            data = resp.json()
            if data:
                m = _parse_market(data[0])
                if m:
                    return m
        # fallback: slug
        resp = client.get(
            f"{GAMMA_HOST}/markets",
            params={"slug": market_id, "limit": 1},
        )
        if resp.status_code == 200:
            data = resp.json()
            if data:
                return _parse_market(data[0])
    return None


def get_orderbook_midprice(token_id: str) -> float | None:
    """Get the CLOB mid price for a single outcome token. None if unavailable."""
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(f"{CLOB_HOST}/midpoint", params={"token_id": token_id})
        if resp.status_code != 200:
            return None
        data = resp.json()
        mid = data.get("mid") if isinstance(data, dict) else None
        return _to_float(mid) if mid is not None else None


def get_orderbook(token_id: str) -> dict | None:
    """Fetch the full CLOB orderbook for a single outcome token.

    Returns a dict shaped { 'bids': [{'price','size'},...], 'asks': [...] }
    with prices/sizes as floats. None on failure.
    """
    with httpx.Client(timeout=10.0) as client:
        resp = client.get(f"{CLOB_HOST}/book", params={"token_id": token_id})
        if resp.status_code != 200:
            return None
        try:
            raw = resp.json()
        except ValueError:
            return None
    if not isinstance(raw, dict):
        return None
    bids = [
        {"price": _to_float(r.get("price")), "size": _to_float(r.get("size"))}
        for r in (raw.get("bids") or [])
        if isinstance(r, dict)
    ]
    asks = [
        {"price": _to_float(r.get("price")), "size": _to_float(r.get("size"))}
        for r in (raw.get("asks") or [])
        if isinstance(r, dict)
    ]
    return {"bids": bids, "asks": asks}
