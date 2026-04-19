"""Smoke test: RiskEngine.

Run:
    cd meridian-core/services
    uv run python -m orchestrator.test_risk_smoke

Exit 0 = halts/drawdown/cluster/persistence wiring proven.

Does NOT hit signal-gateway. The cluster-cap test stubs the topology lookup
by overriding `_count_correlated`. The heartbeat test does not start the
watchdog — instead it pokes `_halts` to mimic a tripped heartbeat halt and
verifies clearing semantics.
"""
from __future__ import annotations

import sys
import tempfile
from decimal import Decimal
from pathlib import Path

from .risk import RiskConfig, RiskEngine


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok  {msg}")


def _engine(tmpdir: Path, **overrides) -> RiskEngine:
    cfg = RiskConfig(
        state_path=tmpdir / "risk_state.json",
        daily_dd_stop_pct=overrides.get("daily_dd_stop_pct", 2.0),
        cluster_max=overrides.get("cluster_max", 2),
        cluster_threshold=overrides.get("cluster_threshold", 0.7),
        heartbeat_interval_s=999.0,  # never tick during tests
        heartbeat_max_miss=overrides.get("heartbeat_max_miss", 3),
        services=[],
        signal_url="http://127.0.0.1:0",  # never reached; cluster check is stubbed below
        total_capital=overrides.get("total_capital", Decimal("100")),
    )
    return RiskEngine(cfg)


def test_check_open_clean() -> None:
    with tempfile.TemporaryDirectory() as td:
        e = _engine(Path(td))
        e._count_correlated = lambda token_id: 0  # type: ignore[method-assign]
        ok, reason = e.check_open(strategy="x", size=Decimal("5"), token_id="t1")
        _check(ok and reason is None, "no halts + no cluster → check_open passes")


def test_drawdown_halt_trips() -> None:
    with tempfile.TemporaryDirectory() as td:
        e = _engine(Path(td), total_capital=Decimal("100"), daily_dd_stop_pct=2.0)
        e._count_correlated = lambda token_id: 0  # type: ignore[method-assign]
        # Realize -3 PnL today → exceeds -2% of 100 = -2 limit.
        e.record_close(position_id="p1", pnl=-3.0)
        ok, reason = e.check_open(strategy="x", size=Decimal("5"), token_id="t1")
        _check(not ok and reason == "halted:drawdown",
               "drawdown beyond -dd_stop_pct trips halt and blocks opens")


def test_halt_persists_across_restart() -> None:
    with tempfile.TemporaryDirectory() as td:
        e1 = _engine(Path(td))
        e1.halt("manual")
        # Re-instantiate from same state dir → halt restored.
        e2 = _engine(Path(td))
        e2._count_correlated = lambda token_id: 0  # type: ignore[method-assign]
        ok, reason = e2.check_open(strategy="x", size=Decimal("1"), token_id="t1")
        _check(not ok and reason == "halted:manual",
               "manual halt persists across re-instantiation (sticky on disk)")
        cleared = e2.clear("manual")
        _check(cleared, "clear() removes the halt")
        ok, _ = e2.check_open(strategy="x", size=Decimal("1"), token_id="t1")
        _check(ok, "after clear, opens resume")


def test_cluster_cap_blocks() -> None:
    with tempfile.TemporaryDirectory() as td:
        e = _engine(Path(td), cluster_max=2)
        # Two positions in cluster {tA, tB}; new signal also correlates → block.
        e.record_open(position_id="p1", strategy="x", size=Decimal("5"), token_id="tA")
        e.record_open(position_id="p2", strategy="x", size=Decimal("5"), token_id="tB")
        e._count_correlated = lambda token_id: 2  # type: ignore[method-assign]
        ok, reason = e.check_open(strategy="x", size=Decimal("5"), token_id="tC")
        _check(not ok and reason and reason.startswith("cluster_cap:"),
               "≥cluster_max correlated positions blocks new open")
        # If unrelated → allowed.
        e._count_correlated = lambda token_id: 0  # type: ignore[method-assign]
        ok, _ = e.check_open(strategy="x", size=Decimal("5"), token_id="tZ")
        _check(ok, "uncorrelated token clears the cluster gate")


def test_heartbeat_clear_semantics() -> None:
    with tempfile.TemporaryDirectory() as td:
        e = _engine(Path(td))
        # Mimic the watchdog tripping a heartbeat halt directly.
        e._halts["heartbeat:cogito"] = 1.0
        e._save_state_unlocked()
        e._count_correlated = lambda token_id: 0  # type: ignore[method-assign]
        ok, reason = e.check_open(strategy="x", size=Decimal("1"), token_id="t1")
        _check(not ok and reason == "halted:heartbeat:cogito",
               "active heartbeat halt blocks opens")
        _check(e.clear("heartbeat:cogito"), "operator can clear heartbeat halt")
        ok, _ = e.check_open(strategy="x", size=Decimal("1"), token_id="t1")
        _check(ok, "after clearing heartbeat halt, opens resume")


def test_snapshot_shape() -> None:
    with tempfile.TemporaryDirectory() as td:
        e = _engine(Path(td))
        snap = e.snapshot()
        _check(isinstance(snap.get("halts"), dict), "snapshot has halts dict")
        _check("config" in snap, "snapshot has config block")
        _check(snap["config"]["cluster_max"] == 2, "snapshot reports cluster_max")


def main() -> int:
    print("RiskEngine smoke...")
    test_check_open_clean()
    test_drawdown_halt_trips()
    test_halt_persists_across_restart()
    test_cluster_cap_blocks()
    test_heartbeat_clear_semantics()
    test_snapshot_shape()
    print("OK — risk wiring proven.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
