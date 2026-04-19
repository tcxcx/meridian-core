"""Cross-venue arbitrage strategy: Polymarket ↔ Kalshi YES-price spread.

Bucket 2 of autonomous-fund-arb. We pull matched pairs from
`/api/signal/arb/pairs` (Polymarket Gamma question text ↔ Kalshi market
title, Jaccard similarity) and emit a Signal whenever the implied
YES-price spread between the two venues exceeds `min_arb_edge_pp`.

Trade direction:
    poly_yes < kalshi_yes  →  BUY YES on Polymarket (the cheap leg)
                              and (paper) SELL YES on Kalshi.
    poly_yes > kalshi_yes  →  We can't short YES on Polymarket cheaply;
                              skip for the hackathon. (Real prod would
                              SELL YES on Kalshi + BUY NO on Polymarket.)

The Kalshi leg is **paper** for the hackathon — the reconciler tracks
an implied hedge mark and closes the Polymarket leg when the spread
captures or inverts. Real Kalshi order submission is post-hackathon.
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

import httpx

from .base import Signal, Strategy

log = logging.getLogger("meridian.orchestrator.strategy.arb")


class ArbStrategy(Strategy):
    name = "arb"

    @classmethod
    def accepted_deps(cls) -> set[str]:
        return {
            "signal_client",
            "min_arb_edge_pp",
            "min_arb_score",
            "usdc_per_position",
            "scan_limit",
        }

    def __init__(
        self,
        *,
        signal_client: httpx.Client,
        min_arb_edge_pp: float = 2.0,
        min_arb_score: float = 0.30,
        usdc_per_position: float = 5.0,
        scan_limit: int = 20,
    ) -> None:
        self._signal = signal_client
        # Min |poly_yes - kalshi_yes| in percentage points to call it an arb.
        # Polymarket CLOB taker fee + Kalshi spread eats ~1pp; default 2pp.
        self.min_arb_edge_pp = float(min_arb_edge_pp)
        # Min Jaccard score on the matched pair. Anything below this is
        # likely a question-text false positive (different elections, etc).
        self.min_arb_score = float(min_arb_score)
        self.usdc_per_position = float(usdc_per_position)
        self.scan_limit = int(scan_limit)

    def scan(self) -> list[dict[str, Any]]:
        try:
            r = self._signal.get(
                "/api/signal/arb/pairs",
                params={
                    "poly_limit": self.scan_limit,
                    "min_score": self.min_arb_score,
                },
            )
            r.raise_for_status()
            return r.json().get("pairs", [])
        except httpx.HTTPError as e:
            log.warning("arb scan failed: %s", e)
            return []

    def evaluate(self, market: dict[str, Any]) -> Signal | None:
        # `market` here is one MatchedPair dict from /api/signal/arb/pairs.
        try:
            edge_pp = float(market.get("implied_edge_pp") or 0.0)
            score = float(market.get("score") or 0.0)
            poly_market_id = market.get("poly_market_id")
            poly_token_id = market.get("poly_yes_token_id")
            poly_yes = float(market.get("poly_yes_price") or 0.0)
            kalshi_yes = float(market.get("kalshi_yes_mid") or 0.0)
            kalshi_ticker = market.get("kalshi_ticker")
        except (TypeError, ValueError):
            return None
        if not poly_market_id or not poly_token_id or not kalshi_ticker:
            return None
        if score < self.min_arb_score:
            return None
        if abs(edge_pp) < self.min_arb_edge_pp:
            return None
        # We can only BUY YES on Polymarket today, so we need
        # poly_yes < kalshi_yes (the Polymarket YES is the cheap leg).
        if edge_pp >= 0:
            return None
        if poly_yes <= 0.0 or poly_yes >= 1.0:
            # Already at or past the bound — no headroom for the trade.
            return None

        # Confidence is a function of (1) similarity score and (2) edge size.
        # Scaled so a 5pp edge with score 0.5 lands ~0.7.
        confidence = round(min(1.0, max(0.0, 0.5 * score + 0.05 * abs(edge_pp))), 4)

        return Signal(
            strategy=self.name,
            market_id=str(poly_market_id),
            token_id=str(poly_token_id),
            side="BUY",
            edge_pp=abs(edge_pp),     # always positive (signed direction is implicit in BUY YES)
            confidence=confidence,
            venue="polymarket",
            metadata={
                "arb_pair": {
                    "kalshi_ticker": kalshi_ticker,
                    "kalshi_title": market.get("kalshi_title"),
                    "poly_question": market.get("poly_question"),
                    "poly_yes_price": poly_yes,
                    "kalshi_yes_mid": kalshi_yes,
                    "implied_edge_pp": edge_pp,
                    "score": score,
                },
                "hedge_leg": {
                    "venue": "kalshi",
                    "ticker": kalshi_ticker,
                    "side": "SELL",         # paper hedge SELLs YES on Kalshi
                    "mark_price": kalshi_yes,
                    "paper": True,
                },
            },
        )

    def size(self, signal: Signal, budget: Decimal) -> Decimal:
        want = Decimal(str(self.usdc_per_position))
        return min(want, budget) if budget > 0 else Decimal(0)
