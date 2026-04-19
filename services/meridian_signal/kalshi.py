"""Kalshi REST read-path: discover open markets + fetch one by ticker.

Bucket 2 of autonomous-fund-arb. Kalshi is the second venue source
alongside Polymarket. We use **public** endpoints only here (markets,
order book metadata) so no auth is strictly required, but if
`KALSHI_API_KEY` is set we send it as a Bearer token to get the higher
rate-limit tier.

Kalshi API base: https://api.elections.kalshi.com/trade-api/v2
Prices are quoted in **cents** (1..99). We normalise to 0..1 floats so
the matcher / arb strategy can compare against Polymarket's 0..1 mids.

Trade-side execution against Kalshi is intentionally NOT wired here.
The arb strategy treats the Kalshi leg as a *paper hedge* for the
hackathon and the reconciler closes the live Polymarket leg when the
implied spread captures or inverts. Real Kalshi order submission is a
post-hackathon item.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("meridian.signal.kalshi")

KALSHI_HOST = os.environ.get("KALSHI_HOST", "https://api.elections.kalshi.com")
_API_PREFIX = "/trade-api/v2"


@dataclass
class KalshiMarket:
    ticker: str               # e.g. "PRES-2024-DJT"
    event_ticker: str
    title: str                # short human title (matches against Polymarket question)
    subtitle: str
    yes_bid: float            # 0..1
    yes_ask: float            # 0..1
    no_bid: float
    no_ask: float
    volume_24h: float
    open_interest: float
    close_time: str | None    # ISO8601
    status: str               # "active" | "closed" | etc.

    @property
    def yes_mid(self) -> float:
        if self.yes_bid > 0 and self.yes_ask > 0:
            return (self.yes_bid + self.yes_ask) / 2.0
        return self.yes_ask or self.yes_bid


def _cents_to_unit(v: Any) -> float:
    try:
        c = float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0
    return max(0.0, min(1.0, c / 100.0))


def _to_float(v: Any) -> float:
    try:
        return float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        return 0.0


def _headers() -> dict[str, str]:
    h = {"Accept": "application/json"}
    key = os.environ.get("KALSHI_API_KEY")
    if key:
        h["Authorization"] = f"Bearer {key}"
    return h


def _parse_market(raw: dict) -> KalshiMarket | None:
    ticker = raw.get("ticker")
    if not ticker:
        return None
    return KalshiMarket(
        ticker=str(ticker),
        event_ticker=str(raw.get("event_ticker") or ""),
        title=str(raw.get("title") or raw.get("subtitle") or ""),
        subtitle=str(raw.get("subtitle") or ""),
        yes_bid=_cents_to_unit(raw.get("yes_bid")),
        yes_ask=_cents_to_unit(raw.get("yes_ask")),
        no_bid=_cents_to_unit(raw.get("no_bid")),
        no_ask=_cents_to_unit(raw.get("no_ask")),
        volume_24h=_to_float(raw.get("volume_24h")),
        open_interest=_to_float(raw.get("open_interest")),
        close_time=raw.get("close_time"),
        status=str(raw.get("status") or ""),
    )


def discover_markets(
    *,
    limit: int = 50,
    min_volume_24h: float = 1_000.0,
    status: str = "open",
) -> list[KalshiMarket]:
    """List active Kalshi markets ranked by volume.

    Returns `[]` on transport / API failure rather than raising; callers
    treat Kalshi unreachability as "no arb opportunities this tick"
    rather than as a halt condition.
    """
    params: dict[str, Any] = {"limit": min(max(limit, 1), 1000), "status": status}
    try:
        with httpx.Client(timeout=15.0, headers=_headers()) as client:
            resp = client.get(f"{KALSHI_HOST}{_API_PREFIX}/markets", params=params)
            resp.raise_for_status()
            data = resp.json() or {}
    except (httpx.HTTPError, ValueError) as e:
        log.warning("kalshi discover_markets failed: %s", e)
        return []

    parsed: list[KalshiMarket] = []
    for raw in data.get("markets") or []:
        m = _parse_market(raw)
        if m is None:
            continue
        if m.volume_24h < min_volume_24h:
            continue
        parsed.append(m)
    parsed.sort(key=lambda m: m.volume_24h, reverse=True)
    return parsed[:limit]


def get_market(ticker: str) -> KalshiMarket | None:
    """Fetch one Kalshi market by ticker."""
    try:
        with httpx.Client(timeout=10.0, headers=_headers()) as client:
            resp = client.get(f"{KALSHI_HOST}{_API_PREFIX}/markets/{ticker}")
            if resp.status_code != 200:
                return None
            data = resp.json() or {}
    except (httpx.HTTPError, ValueError) as e:
        log.warning("kalshi get_market(%s) failed: %s", ticker, e)
        return None
    return _parse_market(data.get("market") or {})
