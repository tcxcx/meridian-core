"""Capital allocator: the only thing that knows about all strategies' positions.

Each tick the orchestrator asks the allocator how much budget a strategy
gets, and whether opening a specific size would breach a cap. The
allocator persists nothing — it's reconstructed at boot from the
execution-router's PositionStore (`hydrate_from_router` in loop.py).

Caps enforced (in order):
  1. Per-position max size (per strategy)
  2. Per-strategy notional exposure cap
  3. Global notional exposure cap
  4. Global max-open-position count

Bucket 3 (Risk Engine) layers on top of this with drawdown halts,
heartbeat halts, and correlation caps.
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from decimal import Decimal

log = logging.getLogger("meridian.orchestrator.allocator")


@dataclass
class AllocatorConfig:
    total_capital: Decimal = Decimal("100")
    # name → weight (any non-negative number; allocator normalises)
    per_strategy_weights: dict[str, Decimal] = field(default_factory=dict)
    # name → hard cap on simultaneous notional exposure for this strategy.
    # Defaults to total_capital * weight when missing.
    per_strategy_caps: dict[str, Decimal] = field(default_factory=dict)
    global_max_open_positions: int = 10
    # Sane upper bound on a single position's USDC. Stops a strategy from
    # blowing the whole budget on one signal even if it asks to.
    per_position_max: Decimal = Decimal("25")


@dataclass
class _OpenPosition:
    strategy: str
    size: Decimal


class Allocator:
    def __init__(self, cfg: AllocatorConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        # position_id → _OpenPosition. Tracks notional exposure live.
        self._open: dict[str, _OpenPosition] = {}
        self._normalise_weights()

    def _normalise_weights(self) -> None:
        total = sum(self.cfg.per_strategy_weights.values(), Decimal(0))
        if total <= 0:
            return
        for k in list(self.cfg.per_strategy_weights):
            self.cfg.per_strategy_weights[k] = self.cfg.per_strategy_weights[k] / total

    # ------------------- queries -------------------

    def budget_for(self, strategy: str) -> Decimal:
        """Budget remaining for `strategy` this tick.

        = (per-strategy cap) - (current strategy exposure)
        capped by (global cap) - (current global exposure)
        capped by per_position_max
        Returns 0 if any cap is already exhausted.
        """
        with self._lock:
            strat_open = sum((p.size for p in self._open.values() if p.strategy == strategy), Decimal(0))
            global_open = sum((p.size for p in self._open.values()), Decimal(0))
            strat_cap = self._cap_for(strategy)
            strat_room = max(Decimal(0), strat_cap - strat_open)
            global_room = max(Decimal(0), self.cfg.total_capital - global_open)
            budget = min(strat_room, global_room, self.cfg.per_position_max)
            return budget if budget > 0 else Decimal(0)

    def can_open(self, strategy: str, size: Decimal) -> tuple[bool, str | None]:
        """Final check before dispatching. Returns (ok, reason_if_not)."""
        if size <= 0:
            return False, "zero_size"
        if size > self.cfg.per_position_max:
            return False, f"size>{self.cfg.per_position_max}_per_position_max"
        with self._lock:
            if len(self._open) >= self.cfg.global_max_open_positions:
                return False, "global_max_open_positions"
            strat_open = sum((p.size for p in self._open.values() if p.strategy == strategy), Decimal(0))
            global_open = sum((p.size for p in self._open.values()), Decimal(0))
            if strat_open + size > self._cap_for(strategy):
                return False, f"strategy_cap:{strategy}"
            if global_open + size > self.cfg.total_capital:
                return False, "global_cap"
        return True, None

    def _cap_for(self, strategy: str) -> Decimal:
        if strategy in self.cfg.per_strategy_caps:
            return self.cfg.per_strategy_caps[strategy]
        weight = self.cfg.per_strategy_weights.get(strategy, Decimal(0))
        if weight > 0:
            return self.cfg.total_capital * weight
        # Unknown strategy: zero cap (fail-closed; configure it explicitly).
        return Decimal(0)

    # ------------------- mutations -------------------

    def record_open(self, strategy: str, position_id: str, size: Decimal) -> None:
        with self._lock:
            self._open[position_id] = _OpenPosition(strategy=strategy, size=size)

    def record_close(self, position_id: str, pnl: float | None = None) -> None:
        with self._lock:
            self._open.pop(position_id, None)
        log.debug("close position=%s pnl=%s", position_id, pnl)

    # ------------------- introspection -------------------

    def snapshot(self) -> dict:
        """Cheap status dump for /health + dashboard."""
        with self._lock:
            global_open = sum((p.size for p in self._open.values()), Decimal(0))
            per_strategy: dict[str, dict] = {}
            for strat in {p.strategy for p in self._open.values()} | set(self.cfg.per_strategy_weights):
                strat_open = sum((p.size for p in self._open.values() if p.strategy == strat), Decimal(0))
                per_strategy[strat] = {
                    "open_notional": str(strat_open),
                    "cap": str(self._cap_for(strat)),
                    "weight": str(self.cfg.per_strategy_weights.get(strat, Decimal(0))),
                }
            return {
                "total_capital": str(self.cfg.total_capital),
                "global_open_notional": str(global_open),
                "global_max_open_positions": self.cfg.global_max_open_positions,
                "open_count": len(self._open),
                "per_strategy": per_strategy,
            }

    def hydrate(self, positions: list[tuple[str, str, float]]) -> None:
        """Re-fill from `(position_id, strategy, usdc_amount)` tuples on boot.

        loop.py calls this after pulling /api/execution/positions. Open
        positions count against caps so a restart doesn't cause us to
        exceed limits.
        """
        with self._lock:
            for pid, strat, amount in positions:
                if not pid:
                    continue
                self._open[pid] = _OpenPosition(strategy=strat or "directional", size=Decimal(str(amount)))
        log.info("allocator hydrated with %d positions", len(self._open))
