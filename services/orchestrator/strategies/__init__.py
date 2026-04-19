"""Strategy plugins for the MiroShark orchestrator.

Each module exports one Strategy subclass. The loop loads them by name
based on the STRATEGIES env CSV (e.g. "directional,arb").
"""
from .arb import ArbStrategy
from .base import Signal, Strategy
from .directional import DirectionalStrategy

__all__ = ["Signal", "Strategy", "DirectionalStrategy", "ArbStrategy", "load_strategies"]


def load_strategies(names: list[str], **deps) -> list[Strategy]:
    """Instantiate strategies by name.

    Each strategy's `__init__` accepts kwargs from `deps`; unknown kwargs are
    ignored so different strategies can pull different deps from the same dict.
    """
    registry: dict[str, type[Strategy]] = {
        "directional": DirectionalStrategy,
        "arb": ArbStrategy,
    }
    out: list[Strategy] = []
    for n in names:
        n = n.strip()
        if not n:
            continue
        cls = registry.get(n)
        if cls is None:
            raise ValueError(f"unknown strategy: {n!r} (known: {sorted(registry)})")
        out.append(cls(**{k: v for k, v in deps.items() if k in cls.accepted_deps()}))
    return out
