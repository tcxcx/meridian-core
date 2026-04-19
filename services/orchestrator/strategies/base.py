"""Strategy interface — the contract every strategy plugin honours.

A Strategy produces `Signal`s the orchestrator may act on. The strategy
does not size in absolute USDC; the central Allocator hands it a budget
each tick and the strategy's `size()` decides how much of that budget
to deploy on the given signal.

Lifecycle:
    every tick:
        markets = strategy.scan()
        for m in markets:
            sig = strategy.evaluate(m)        # may return None
            if sig: candidates.append(sig)
        ranked = sort(candidates)
        for sig in ranked:
            budget = allocator.budget_for(strategy.name)
            size = strategy.size(sig, budget)
            if allocator.can_open(strategy.name, size):
                execution_router.open(...)
                allocator.record_open(...)
                strategy.on_open(sig, position_id, size)

    on close (Bucket 2 reconciler / Bucket 3 risk kill):
        strategy.on_close(position_id, pnl)
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Literal

Side = Literal["BUY", "SELL"]
Venue = Literal["polymarket", "kalshi"]


@dataclass
class Signal:
    """A trade idea a strategy wants to open.

    `metadata` carries strategy-specific hints (e.g. arb pair id, hedge
    leg id). The orchestrator passes it back to `on_open` and into the
    audit log untouched.
    """
    strategy: str
    market_id: str
    token_id: str
    side: Side
    edge_pp: float                    # signed; positive = take
    confidence: float                 # 0..1
    venue: Venue = "polymarket"
    metadata: dict[str, Any] = field(default_factory=dict)

    def rank_key(self) -> tuple[float, float]:
        """Higher is better. Used by the loop to sort candidates."""
        return (abs(self.edge_pp), self.confidence)


class Strategy(ABC):
    """Base class for all strategy plugins.

    Strategies must be **stateless across ticks** for the inputs the
    Allocator owns (capital, open positions). They MAY hold internal
    state for their own purposes (e.g. arb pair caches).
    """

    name: str = "abstract"

    @classmethod
    def accepted_deps(cls) -> set[str]:
        """Names of constructor kwargs this strategy understands.

        Loaders pass a superset; we filter so unrelated strategies don't
        fight over the same kwarg names.
        """
        return set()

    @abstractmethod
    def scan(self) -> list[dict[str, Any]]:
        """Discover candidate markets. Return whatever shape `evaluate`
        expects. The loop does not inspect these dicts.
        """

    @abstractmethod
    def evaluate(self, market: dict[str, Any]) -> Signal | None:
        """Turn a candidate market into a Signal, or None to skip."""

    @abstractmethod
    def size(self, signal: Signal, budget: Decimal) -> Decimal:
        """Pick a USDC notional for `signal`, capped by `budget`.

        The Allocator already enforces global + per-strategy caps; this
        method only decides *within* the offered budget. Return 0 to
        decline (e.g. confidence too low to deploy any capital).
        """

    def on_open(self, signal: Signal, position_id: str, size: Decimal) -> None:
        """Hook fired AFTER the orchestrator successfully opens a position.

        Default: no-op. Strategies can override to track per-strategy
        state (e.g. arb pair → leg map).
        """
        return None

    def on_close(self, position_id: str, pnl: float | None) -> None:
        """Hook fired when a position closes (settled or killed).

        Default: no-op. PnL is in USDC; None if unknown (e.g. risk kill
        before settlement).
        """
        return None
