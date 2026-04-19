"""Directional strategy: swarm-edge BUYs on Polymarket.

This is the original Phase-5 logic from loop.py, lifted into a Strategy
class. It scans Polymarket via the signal-gateway, runs the swarm on
each market, and produces BUY signals when |edge_pp| and confidence
both clear thresholds and the swarm leans into (not away from) the
market.

The strategy keeps NO knowledge of capital or open-position counts —
that's the Allocator's job. It only decides "is this signal worth the
budget you offered?"
"""
from __future__ import annotations

import logging
from decimal import Decimal
from typing import Any

import httpx

from .base import Signal, Strategy

log = logging.getLogger("meridian.orchestrator.strategy.directional")


class DirectionalStrategy(Strategy):
    name = "directional"

    @classmethod
    def accepted_deps(cls) -> set[str]:
        return {
            "signal_client",
            "min_edge_pp",
            "min_confidence",
            "scan_limit",
            "scan_min_liquidity_usd",
            "usdc_per_position",
        }

    def __init__(
        self,
        *,
        signal_client: httpx.Client,
        min_edge_pp: float = 3.0,
        min_confidence: float = 0.55,
        scan_limit: int = 10,
        scan_min_liquidity_usd: float = 5_000.0,
        usdc_per_position: float = 5.0,
    ) -> None:
        self._signal = signal_client
        self.min_edge_pp = float(min_edge_pp)
        self.min_confidence = float(min_confidence)
        self.scan_limit = int(scan_limit)
        self.scan_min_liquidity_usd = float(scan_min_liquidity_usd)
        # Bucket 4 will replace this constant with an encrypted-size handle;
        # leave as a float for now so existing /open contract is unchanged.
        self.usdc_per_position = float(usdc_per_position)

    def scan(self) -> list[dict[str, Any]]:
        try:
            r = self._signal.post(
                "/api/signal/markets/scan",
                json={
                    "limit": self.scan_limit,
                    "min_liquidity_usd": self.scan_min_liquidity_usd,
                },
            )
            r.raise_for_status()
            return r.json().get("markets", [])
        except httpx.HTTPError as e:
            log.warning("scan failed: %s", e)
            return []

    def evaluate(self, market: dict[str, Any]) -> Signal | None:
        market_id = market.get("market_id")
        if not market_id:
            return None
        try:
            r = self._signal.post("/api/signal/run", json={"market_id": market_id})
            r.raise_for_status()
        except httpx.HTTPError as e:
            log.warning("run failed for %s: %s", market_id, e)
            return None

        run = r.json()
        edge = run.get("edge") or {}
        edge_pp = float(edge.get("edge_pp") or 0.0)
        confidence = float(run.get("confidence_adjusted") or run.get("confidence") or 0.0)

        if abs(edge_pp) < self.min_edge_pp or confidence < self.min_confidence:
            return None
        # First-pass directional only opens BUYs (positive edge → swarm thinks
        # the market under-prices the outcome). Negative-edge SELLs need short
        # mechanics we don't have on Polymarket today.
        if edge_pp <= 0:
            return None

        token_id = self._token_id_for_outcome(market, edge.get("outcome"))
        if token_id is None:
            return None

        return Signal(
            strategy=self.name,
            market_id=str(market_id),
            token_id=token_id,
            side="BUY",
            edge_pp=edge_pp,
            confidence=confidence,
            venue="polymarket",
            metadata={
                "outcome": edge.get("outcome"),
                "swarm_probability": edge.get("swarm_probability"),
                "market_probability": edge.get("market_probability"),
                "run_id": run.get("run_id"),
                "seed_hash_0g": run.get("seed_hash_0g"),
                "simulation_hash_0g": run.get("simulation_hash_0g"),
            },
        )

    def size(self, signal: Signal, budget: Decimal) -> Decimal:
        # Constant per-position sizing today; Bucket 4 swaps in encrypted
        # Kelly-ish sizing. Cap at the offered budget so the Allocator's
        # per-strategy cap is honoured.
        want = Decimal(str(self.usdc_per_position))
        return min(want, budget) if budget > 0 else Decimal(0)

    @staticmethod
    def _token_id_for_outcome(market: dict[str, Any], outcome: str | None) -> str | None:
        if outcome is None:
            return None
        outcomes = market.get("outcomes") or []
        token_ids = market.get("token_ids") or market.get("clobTokenIds") or []
        if not outcomes or not token_ids:
            return None
        try:
            idx = outcomes.index(outcome)
        except ValueError:
            return None
        return token_ids[idx] if idx < len(token_ids) else None
