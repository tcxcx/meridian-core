"""Smoke test: Strategy + Allocator wiring.

Run:
    cd meridian-core/services
    uv run python -m orchestrator.test_strategies_smoke

Exit 0 = wiring proven; non-zero = a cap or interface broke.

Does NOT hit signal-gateway. Validates:
  · Allocator enforces per-strategy + global + per-position + max-open caps
  · DirectionalStrategy.size() respects offered budget
  · load_strategies returns the right class for "directional"
  · Allocator.snapshot() reports plausible numbers after a hydrate
"""
from __future__ import annotations

import sys
from decimal import Decimal

from .allocator import Allocator, AllocatorConfig
from .strategies import Signal, load_strategies
from .strategies.directional import DirectionalStrategy


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok  {msg}")


def test_allocator_global_cap() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("10"),
        per_strategy_weights={"x": Decimal(1)},
        per_position_max=Decimal("100"),
    ))
    a.record_open("x", "p1", Decimal("4"))
    a.record_open("x", "p2", Decimal("5"))
    ok, _ = a.can_open("x", Decimal("2"))
    _check(not ok, "global cap blocks 4+5+2 > 10")
    ok, _ = a.can_open("x", Decimal("1"))
    _check(ok, "global cap allows 4+5+1 <= 10")


def test_allocator_per_strategy_cap() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("100"),
        per_strategy_weights={"x": Decimal(1), "y": Decimal(1)},
        per_strategy_caps={"x": Decimal("10"), "y": Decimal("90")},
        per_position_max=Decimal("100"),
    ))
    a.record_open("x", "p1", Decimal("9"))
    ok, reason = a.can_open("x", Decimal("2"))
    _check(not ok and reason == "strategy_cap:x", "per-strategy cap blocks 9+2 > 10")
    ok, _ = a.can_open("y", Decimal("80"))
    _check(ok, "y can still spend up to its 90 cap")


def test_allocator_per_position_max() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("1000"),
        per_strategy_weights={"x": Decimal(1)},
        per_position_max=Decimal("25"),
    ))
    ok, reason = a.can_open("x", Decimal("26"))
    _check(not ok and "per_position_max" in (reason or ""), "per-position max blocks 26 > 25")
    ok, _ = a.can_open("x", Decimal("25"))
    _check(ok, "per-position max allows exactly 25")


def test_allocator_max_open() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("1000"),
        per_strategy_weights={"x": Decimal(1)},
        per_position_max=Decimal("100"),
        global_max_open_positions=2,
    ))
    a.record_open("x", "p1", Decimal("5"))
    a.record_open("x", "p2", Decimal("5"))
    ok, reason = a.can_open("x", Decimal("5"))
    _check(not ok and reason == "global_max_open_positions", "max-open count blocks 3rd")


def test_allocator_budget_for() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("100"),
        per_strategy_weights={"x": Decimal(1), "y": Decimal(1)},  # → 50/50
        per_position_max=Decimal("25"),
    ))
    _check(a.budget_for("x") == Decimal("25"), "budget capped by per_position_max even when strat cap higher")
    a.record_open("x", "p1", Decimal("20"))
    # x cap = 50, used = 20, remaining = 30, but per_position_max = 25
    _check(a.budget_for("x") == Decimal("25"), "budget after partial fill respects per_position_max")
    # Unknown strategy → 0
    _check(a.budget_for("unknown") == Decimal(0), "unknown strategy gets 0 budget (fail-closed)")


def test_directional_size_respects_budget() -> None:
    s = DirectionalStrategy(
        signal_client=None,  # not used by size()
        usdc_per_position=5.0,
    )
    sig = Signal(strategy="directional", market_id="m1", token_id="t1",
                 side="BUY", edge_pp=4.0, confidence=0.7)
    # Plenty of budget → returns the configured per-position USDC.
    _check(s.size(sig, Decimal("100")) == Decimal("5"), "size returns usdc_per_position when budget large")
    # Squeezed budget → caps to budget.
    _check(s.size(sig, Decimal("3")) == Decimal("3"), "size caps to budget when budget tight")
    # Zero budget → declines.
    _check(s.size(sig, Decimal("0")) == Decimal("0"), "size returns 0 when budget zero")


def test_load_strategies_factory() -> None:
    strats = load_strategies(
        ["directional"],
        signal_client=None,
        usdc_per_position=5.0,
    )
    _check(len(strats) == 1, "load_strategies returns one strategy for ['directional']")
    _check(strats[0].name == "directional", "loaded strategy has name='directional'")
    try:
        load_strategies(["nope"], signal_client=None)
    except ValueError as e:
        _check("nope" in str(e), "load_strategies raises ValueError for unknown strategy")
    else:
        _check(False, "load_strategies should have raised for unknown")


def test_hydrate_counts_against_caps() -> None:
    a = Allocator(AllocatorConfig(
        total_capital=Decimal("100"),
        per_strategy_weights={"directional": Decimal(1)},
        per_strategy_caps={"directional": Decimal("10")},
        per_position_max=Decimal("100"),
    ))
    a.hydrate([("p1", "directional", 8.0)])
    snap = a.snapshot()
    _check(snap["open_count"] == 1, "snapshot.open_count==1 after hydrate")
    ok, reason = a.can_open("directional", Decimal("3"))
    _check(not ok and reason == "strategy_cap:directional",
           "hydrated 8 + new 3 = 11 > 10 cap → blocks (restart safety)")


def main() -> int:
    print("Strategy/Allocator smoke...")
    test_allocator_global_cap()
    test_allocator_per_strategy_cap()
    test_allocator_per_position_max()
    test_allocator_max_open()
    test_allocator_budget_for()
    test_directional_size_respects_budget()
    test_load_strategies_factory()
    test_hydrate_counts_against_caps()
    print("OK — wiring proven.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
