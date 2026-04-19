"""Smoke for Bucket 5 — daily verifiable PnL attestation pack.

No pytest (matches arb / reconciler smoke style). Each `test_*` exits
non-zero on failure; main runs them all and prints PASS/FAIL.

Covers:
  - date-window filtering (UTC day boundaries, exclusive end)
  - status filtering (only `settled` rows in the pack)
  - audit→position root_hash join via `attestation.pinned` events
  - PnL aggregation (winners / losers / by_strategy / volume)
  - deterministic byte-equality between cache and pin payload
  - load_local round-trip
  - latest_pin_for picks the most recent matching `daily_pack.pinned`
  - pin() short-circuits when attestation is None
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

# Allow running as `python services/execution_router/test_daily_pack_smoke.py`.
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from services.execution_router.audit import AuditLog  # noqa: E402
from services.execution_router.daily_pack import (  # noqa: E402
    DailyPackBuilder,
    SCHEMA,
    _date_window_utc,
)
from services.execution_router.store import PositionRecord, PositionStore  # noqa: E402


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  FAIL · {msg}")
        sys.exit(1)


def _ts(date: str, hour: int = 12) -> float:
    d = datetime.strptime(date, "%Y-%m-%d").replace(hour=hour, tzinfo=timezone.utc)
    return d.timestamp()


def _make_record(
    pid: str,
    *,
    strategy: str = "directional",
    usdc_amount: float = 5.0,
    payout_usdc: float = 7.5,
    status: str = "settled",
    updated_at: float | None = None,
) -> PositionRecord:
    rec = PositionRecord(
        position_id=pid,
        market_id=f"market-{pid}",
        token_id=f"token-{pid}",
        side="BUY",
        usdc_amount=usdc_amount,
        burner_address=f"0x{pid:0>40}",
        strategy=strategy,
        status=status,
        fund_tx=f"0xfund_{pid}",
        resolve_tx=f"0xresolve_{pid}",
        settle_tx=f"0xsettle_{pid}",
        bridge_send_burn_tx=f"0xbsend_{pid}",
        bridge_recv_burn_tx=f"0xbrecv_{pid}",
        payout_usdc=payout_usdc,
    )
    if updated_at is not None:
        rec.updated_at = updated_at
    return rec


def _put(store: PositionStore, rec: PositionRecord, *, updated_at: float | None = None) -> None:
    """Insert into store, then restore updated_at (upsert calls touch())."""
    target_ts = updated_at if updated_at is not None else rec.updated_at
    store.upsert(rec)
    # `store._positions[pid]` is the same object as `rec`; mutate in place
    # so subsequent `store.list()` reads our intended timestamp.
    rec.updated_at = target_ts


class _FakePinResult:
    def __init__(self, root: str, tx: str, size: int) -> None:
        self.root_hash = root
        self.tx_hash = tx
        self.size_bytes = size


class _FakeAttestation:
    def __init__(self) -> None:
        self.calls: list[tuple[dict, dict]] = []
        self._n = 0

    def pin(self, payload: dict, *, meta: dict | None = None) -> _FakePinResult:
        self._n += 1
        self.calls.append((payload, dict(meta or {})))
        return _FakePinResult(
            root=f"0xroot{self._n:04d}",
            tx=f"0xtx{self._n:04d}",
            size=len(json.dumps(payload).encode("utf-8")),
        )


def _fresh_env() -> tuple[PositionStore, AuditLog, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="meridian-pack-"))
    store = PositionStore(db_path=tmp / "positions.db")
    audit = AuditLog(db_path=tmp / "audit.db")
    return store, audit, tmp


def _builder(store: PositionStore, audit: AuditLog, tmp: Path,
             attestation: _FakeAttestation | None = None) -> DailyPackBuilder:
    """Construct a DailyPackBuilder with isolated pack_dir under tmp."""
    return DailyPackBuilder(store=store, audit=audit,
                            attestation=attestation,
                            pack_dir=tmp / "daily_packs")


def test_date_window_utc_is_exclusive_end() -> None:
    start, end = _date_window_utc("2026-04-19")
    _check(start == datetime(2026, 4, 19, tzinfo=timezone.utc).timestamp(),
           "start should be 2026-04-19 00:00 UTC")
    _check(end == datetime(2026, 4, 20, tzinfo=timezone.utc).timestamp(),
           "end should be 2026-04-20 00:00 UTC (exclusive)")
    _check(end - start == 86400, f"window should be exactly 86400s, got {end - start}")


def test_build_filters_by_date_and_status() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)

    _put(store, _make_record("p_inside"), updated_at=_ts("2026-04-19", 12))
    _put(store, _make_record("p_edge_start"), updated_at=_ts("2026-04-19", 0))
    _put(store, _make_record("p_prev"), updated_at=_ts("2026-04-18", 23))
    _put(store, _make_record("p_next"), updated_at=_ts("2026-04-20", 0))
    _put(store, _make_record("p_open", status="open"), updated_at=_ts("2026-04-19", 14))

    pack = builder.build("2026-04-19")
    pids = sorted(e["position_id"] for e in pack["positions"])
    _check(pids == ["p_edge_start", "p_inside"],
           f"expected only inside+edge_start in window, got {pids}")
    _check(pack["schema"] == SCHEMA, f"schema mismatch: {pack['schema']}")
    _check(pack["aggregate"]["n_positions"] == 2, "aggregate count should be 2")


def test_audit_join_attaches_root_hash() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)

    # AuditLog uses time.time() at insert; build for "today" so audit ts
    # falls inside the window.
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    _put(store, _make_record("p_today"), updated_at=time.time())
    audit.log("attestation.pinned", position_id="p_today",
              payload={"root_hash": "0xrootABC", "tx_hash": "0xtxABC", "size_bytes": 123})

    pack = builder.build(today)
    entry = next((e for e in pack["positions"] if e["position_id"] == "p_today"), None)
    _check(entry is not None, "p_today should be in the pack")
    _check(entry["attestation_root_hash"] == "0xrootABC",
           f"root_hash should match the audit event, got {entry['attestation_root_hash']}")


def test_aggregate_pnl_winners_losers_volume() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)

    # Three winners, two losers, one flat — same date.
    ts0 = _ts("2026-04-19", 12)
    cases = [
        ("w1", "directional", 5.0, 7.0),   # +2
        ("w2", "directional", 5.0, 8.0),   # +3
        ("w3", "arb",         5.0, 6.5),   # +1.5
        ("l1", "directional", 5.0, 3.0),   # -2
        ("l2", "arb",         5.0, 4.5),   # -0.5
        ("f1", "directional", 5.0, 5.0),   # 0
    ]
    for i, (pid, strat, usdc, payout) in enumerate(cases):
        _put(store, _make_record(pid, strategy=strat,
                                 usdc_amount=usdc, payout_usdc=payout),
             updated_at=ts0 + i)

    pack = builder.build("2026-04-19")
    agg = pack["aggregate"]
    _check(agg["n_positions"] == 6, f"n_positions should be 6, got {agg['n_positions']}")
    _check(agg["n_winners"] == 3, f"n_winners should be 3, got {agg['n_winners']}")
    _check(agg["n_losers"] == 2, f"n_losers should be 2, got {agg['n_losers']}")
    _check(agg["n_flat"] == 1, f"n_flat should be 1, got {agg['n_flat']}")
    _check(abs(agg["gross_pnl_usdc"] - 4.0) < 1e-6,
           f"gross_pnl should be 4.0 (2+3+1.5-2-0.5), got {agg['gross_pnl_usdc']}")
    _check(abs(agg["total_volume_usdc"] - 30.0) < 1e-6,
           f"volume should be 30.0, got {agg['total_volume_usdc']}")
    _check(abs(agg["win_rate"] - 0.5) < 1e-6,
           f"win_rate should be 0.5, got {agg['win_rate']}")
    _check(set(agg["by_strategy"].keys()) == {"directional", "arb"},
           f"by_strategy keys mismatch: {agg['by_strategy'].keys()}")
    _check(abs(agg["by_strategy"]["arb"]["gross_pnl_usdc"] - 1.0) < 1e-6,
           f"arb gross should be 1.0, got {agg['by_strategy']['arb']['gross_pnl_usdc']}")
    _check(agg["by_strategy"]["arb"]["n_positions"] == 2, "arb n should be 2")


def test_serialise_is_deterministic_and_byte_equal_to_cache() -> None:
    store, audit, _tmp = _fresh_env()
    fake_pin = _FakeAttestation()
    builder = _builder(store, audit, _tmp, attestation=fake_pin)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    _put(store, _make_record("dpa"), updated_at=time.time())
    _put(store, _make_record("dpb"), updated_at=time.time())

    pack = builder.build(today)
    body_a = DailyPackBuilder._serialise(pack)
    body_b = DailyPackBuilder._serialise(pack)
    _check(body_a == body_b, "two serialisations of same pack should be byte-equal")

    path = builder.write_local(pack)
    on_disk = Path(path).read_bytes()
    _check(on_disk == body_a, "cached file must equal serialised payload (byte-equal)")


def test_load_local_round_trip() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    _put(store, _make_record("rt1"), updated_at=time.time())
    pack = builder.build(today)
    builder.write_local(pack)

    loaded = builder.load_local(today)
    _check(loaded is not None, "load_local should return cached pack")
    _check(loaded["date"] == today, "loaded date matches")
    _check(loaded["aggregate"]["n_positions"] == 1, "loaded aggregate matches")
    _check(builder.load_local("1999-01-01") is None, "missing date returns None")


def test_pin_short_circuits_when_disabled() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)
    pack = builder.build("2026-04-19")
    _check(builder.pin(pack) is None, "pin() with no attestation client must return None")


def test_build_and_pin_writes_cache_and_pins() -> None:
    store, audit, _tmp = _fresh_env()
    fake_pin = _FakeAttestation()
    builder = _builder(store, audit, _tmp, attestation=fake_pin)

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    _put(store, _make_record("bp1"), updated_at=time.time())
    result = builder.build_and_pin(today)
    _check(result.pack["date"] == today, "result.pack should be for today")
    _check(result.written_path is not None and result.written_path.exists(),
           "result.written_path should exist")
    _check(result.pinned is not None, "should pin when attestation client is set")
    _check(result.pinned.root_hash.startswith("0xroot"),
           f"pin returned a root hash: {result.pinned.root_hash}")
    _check(len(fake_pin.calls) == 1, "pin called exactly once")
    _, meta = fake_pin.calls[0]
    _check(meta.get("kind") == "daily_pack" and meta.get("date") == today,
           f"meta should tag kind+date, got {meta}")


def test_latest_pin_for_returns_most_recent_match() -> None:
    store, audit, _tmp = _fresh_env()
    builder = _builder(store, audit, _tmp)

    audit.log("daily_pack.pinned", payload={
        "date": "2026-04-19", "root_hash": "0xold", "tx_hash": "0xoldtx", "size_bytes": 10,
    })
    time.sleep(0.005)
    audit.log("daily_pack.pinned", payload={
        "date": "2026-04-19", "root_hash": "0xnew", "tx_hash": "0xnewtx", "size_bytes": 20,
    })
    audit.log("daily_pack.pinned", payload={
        "date": "2026-04-20", "root_hash": "0xother", "tx_hash": "0xothertx", "size_bytes": 30,
    })

    found = builder.latest_pin_for("2026-04-19")
    _check(found is not None and found["root_hash"] == "0xnew",
           f"should return the newest 04-19 pin, got {found}")
    _check(builder.latest_pin_for("1999-01-01") is None,
           "missing date returns None")


_TESTS = [
    test_date_window_utc_is_exclusive_end,
    test_build_filters_by_date_and_status,
    test_audit_join_attaches_root_hash,
    test_aggregate_pnl_winners_losers_volume,
    test_serialise_is_deterministic_and_byte_equal_to_cache,
    test_load_local_round_trip,
    test_pin_short_circuits_when_disabled,
    test_build_and_pin_writes_cache_and_pins,
    test_latest_pin_for_returns_most_recent_match,
]


def main() -> int:
    failed = 0
    for t in _TESTS:
        name = t.__name__
        print(f"· {name}")
        try:
            t()
        except SystemExit as e:
            failed += 1
            if e.code:
                print(f"  exited {e.code}")
            continue
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  FAIL · raised {type(e).__name__}: {e}")
            continue
        print("  PASS")
    print(f"\n{len(_TESTS) - failed}/{len(_TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
