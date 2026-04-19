"""Smoke for Bucket 6 — multi-tenant isolation.

No pytest. Verifies the four tenant invariants:

  1. Burner namespace isolation: same (strategy, position_id) under two
     different non-default tenants derives to two different EOAs.
  2. Default tenant aliases the Bucket-4 layout: derive(pid, strat,
     tenant="default") == derive(pid, strat) so existing positions
     re-derive identically after the upgrade.
  3. TenantRegistry from env: parses TENANTS + per-tenant capital, cap,
     strategy whitelist, label.
  4. Daily pack tenant filter: a multi-tenant store filtered by tenant
     only emits that tenant's positions; the envelope carries tenant_id.
"""
from __future__ import annotations

import sys
import tempfile
import time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from services.execution_router.audit import AuditLog  # noqa: E402
from services.execution_router.burner import BurnerFactory  # noqa: E402
from services.execution_router.daily_pack import DailyPackBuilder  # noqa: E402
from services.execution_router.store import PositionRecord, PositionStore  # noqa: E402
from services.execution_router.tenants import (  # noqa: E402
    DEFAULT_TENANT_ID,
    TenantConfig,
    TenantRegistry,
    from_env as tenants_from_env,
)


SEED = "0x" + ("ab" * 32)  # deterministic 32-byte seed for the smoke


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"  FAIL · {msg}")
        sys.exit(1)


def _ts(date: str, hour: int = 12) -> float:
    d = datetime.strptime(date, "%Y-%m-%d").replace(hour=hour, tzinfo=timezone.utc)
    return d.timestamp()


def _put(store: PositionStore, rec: PositionRecord, *, updated_at: float | None = None) -> None:
    target = updated_at if updated_at is not None else rec.updated_at
    store.upsert(rec)
    rec.updated_at = target


def _make_record(pid: str, *, tenant_id: str = "default", strategy: str = "directional",
                 usdc_amount: float = 5.0, payout_usdc: float = 7.5,
                 status: str = "settled") -> PositionRecord:
    return PositionRecord(
        position_id=pid,
        market_id=f"market-{pid}",
        token_id=f"token-{pid}",
        side="BUY",
        usdc_amount=usdc_amount,
        burner_address=f"0x{pid:0>40}",
        strategy=strategy,
        tenant_id=tenant_id,
        status=status,
        payout_usdc=payout_usdc,
    )


def _fresh_env() -> tuple[PositionStore, AuditLog, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="meridian-tenants-"))
    return (
        PositionStore(db_path=tmp / "positions.db"),
        AuditLog(db_path=tmp / "audit.db"),
        tmp,
    )


# ─── 1. Burner namespace isolation ────────────────────────────────────────

def test_burner_namespace_isolated_across_tenants() -> None:
    fac = BurnerFactory(SEED)
    a = fac.derive("p001", strategy_id="arb", tenant_id="fund-a")
    b = fac.derive("p001", strategy_id="arb", tenant_id="fund-b")
    _check(a.address != b.address,
           f"different tenants must produce different burners; got {a.address}")
    _check(a.private_key != b.private_key, "private keys must differ")


def test_default_tenant_aliases_bucket4_layout() -> None:
    """Critical back-compat: pre-Bucket-6 positions hydrate to the same EOA."""
    fac = BurnerFactory(SEED)
    bucket4 = fac.derive("p001", strategy_id="arb")
    bucket6_default = fac.derive("p001", strategy_id="arb", tenant_id="default")
    _check(bucket4.address == bucket6_default.address,
           f"default tenant must alias Bucket-4 layout; "
           f"bucket4={bucket4.address} bucket6_default={bucket6_default.address}")


def test_burner_strategy_within_tenant_still_isolated() -> None:
    """Per-strategy sub-account property survives the tenant extension."""
    fac = BurnerFactory(SEED)
    a = fac.derive("p001", strategy_id="arb", tenant_id="fund-a")
    b = fac.derive("p001", strategy_id="directional", tenant_id="fund-a")
    _check(a.address != b.address,
           "different strategies inside one tenant must produce different burners")


# ─── 2. TenantRegistry from env ───────────────────────────────────────────

def test_registry_default_when_unset() -> None:
    reg = tenants_from_env(env={})
    _check(reg.ids() == [DEFAULT_TENANT_ID],
           f"empty env should produce single default tenant, got {reg.ids()}")
    cfg = reg.require(DEFAULT_TENANT_ID)
    _check(cfg.allows("anything"), "default tenant should permit any strategy")


def test_registry_parses_multi_tenant_env() -> None:
    env = {
        "TENANTS": "fund-a,fund-b",
        "TENANT_FUND_A_CAPITAL": "250",
        "TENANT_FUND_A_PER_POSITION_MAX": "20",
        "TENANT_FUND_A_STRATEGIES": "arb,directional",
        "TENANT_FUND_A_LABEL": "Fund A",
        "TENANT_FUND_B_CAPITAL": "100",
        "TENANT_FUND_B_STRATEGIES": "arb",
    }
    reg = tenants_from_env(env=env)
    _check(reg.ids() == ["fund-a", "fund-b"], f"declaration order preserved, got {reg.ids()}")

    a = reg.require("fund-a")
    _check(a.capital_usdc == Decimal("250"), f"fund-a capital, got {a.capital_usdc}")
    _check(a.per_position_max_usdc == Decimal("20"), "fund-a per-position cap")
    _check(a.label == "Fund A", "fund-a label")
    _check(a.allows("arb") and a.allows("directional"), "fund-a allows whitelisted strategies")
    _check(not a.allows("rumour"), "fund-a rejects non-whitelisted strategy")

    b = reg.require("fund-b")
    _check(b.capital_usdc == Decimal("100"), "fund-b capital default override")
    _check(b.per_position_max_usdc == Decimal("25"), "fund-b uses default per-position cap")
    _check(b.allows("arb") and not b.allows("directional"),
           "fund-b only allows arb")


def test_registry_unknown_tenant_raises() -> None:
    reg = TenantRegistry([TenantConfig(tenant_id="solo")])
    try:
        reg.require("ghost")
    except KeyError:
        return
    _check(False, "require(ghost) should have raised KeyError")


# ─── 3. Daily pack tenant filter ──────────────────────────────────────────

def test_daily_pack_filters_by_tenant() -> None:
    store, audit, tmp = _fresh_env()
    builder = DailyPackBuilder(
        store=store, audit=audit, attestation=None,
        pack_dir=tmp / "daily_packs",
    )

    ts = _ts("2026-04-19", 12)
    _put(store, _make_record("a1", tenant_id="fund-a", payout_usdc=8.0), updated_at=ts)
    _put(store, _make_record("a2", tenant_id="fund-a", payout_usdc=4.0), updated_at=ts + 1)
    _put(store, _make_record("b1", tenant_id="fund-b", payout_usdc=9.0), updated_at=ts + 2)
    _put(store, _make_record("d1", tenant_id="default", payout_usdc=6.0), updated_at=ts + 3)

    pack_a = builder.build("2026-04-19", tenant_id="fund-a")
    pids_a = sorted(e["position_id"] for e in pack_a["positions"])
    _check(pids_a == ["a1", "a2"], f"fund-a pack should hold only a1+a2, got {pids_a}")
    _check(pack_a["tenant_id"] == "fund-a", "envelope carries tenant_id")
    # 3.0 + (-1.0) = 2.0
    _check(abs(pack_a["aggregate"]["gross_pnl_usdc"] - 2.0) < 1e-6,
           f"fund-a gross should be 2.0, got {pack_a['aggregate']['gross_pnl_usdc']}")
    _check(all(e["tenant_id"] == "fund-a" for e in pack_a["positions"]),
           "every entry carries fund-a tenant_id")

    pack_b = builder.build("2026-04-19", tenant_id="fund-b")
    pids_b = [e["position_id"] for e in pack_b["positions"]]
    _check(pids_b == ["b1"], f"fund-b pack should hold only b1, got {pids_b}")
    _check(pack_b["tenant_id"] == "fund-b", "envelope carries tenant_id fund-b")

    # Unfiltered build returns everyone but tags envelope as default.
    pack_all = builder.build("2026-04-19")
    pids_all = sorted(e["position_id"] for e in pack_all["positions"])
    _check(pids_all == ["a1", "a2", "b1", "d1"],
           f"unfiltered pack should hold all 4 settled positions, got {pids_all}")


def test_daily_pack_write_local_uses_tenant_subdir() -> None:
    store, audit, tmp = _fresh_env()
    builder = DailyPackBuilder(
        store=store, audit=audit, attestation=None,
        pack_dir=tmp / "daily_packs",
    )
    ts = _ts("2026-04-19", 12)
    _put(store, _make_record("a1", tenant_id="fund-a"), updated_at=ts)
    _put(store, _make_record("d1", tenant_id="default"), updated_at=ts)

    pack_a = builder.build("2026-04-19", tenant_id="fund-a")
    pack_d = builder.build("2026-04-19")
    path_a = builder.write_local(pack_a)
    path_d = builder.write_local(pack_d)

    _check(path_a == tmp / "daily_packs" / "fund-a" / "2026-04-19.json",
           f"fund-a pack should land under fund-a/, got {path_a}")
    _check(path_d == tmp / "daily_packs" / "2026-04-19.json",
           f"default pack should keep legacy flat path, got {path_d}")
    _check(path_a.exists() and path_d.exists(), "both files should exist")

    loaded_a = builder.load_local("2026-04-19", tenant_id="fund-a")
    loaded_d = builder.load_local("2026-04-19")
    _check(loaded_a is not None and loaded_a["tenant_id"] == "fund-a",
           "load_local(tenant=fund-a) returns the fund-a envelope")
    _check(loaded_d is not None and loaded_d["tenant_id"] == "default",
           "load_local() returns the default envelope")


def test_latest_pin_for_filters_by_tenant() -> None:
    store, audit, tmp = _fresh_env()
    builder = DailyPackBuilder(
        store=store, audit=audit, attestation=None,
        pack_dir=tmp / "daily_packs",
    )

    audit.log("daily_pack.pinned", payload={
        "date": "2026-04-19", "tenant_id": "fund-a",
        "root_hash": "0xrootA", "tx_hash": "0xtxA", "size_bytes": 10,
    })
    time.sleep(0.005)
    audit.log("daily_pack.pinned", payload={
        "date": "2026-04-19", "tenant_id": "fund-b",
        "root_hash": "0xrootB", "tx_hash": "0xtxB", "size_bytes": 12,
    })

    pin_a = builder.latest_pin_for("2026-04-19", tenant_id="fund-a")
    pin_b = builder.latest_pin_for("2026-04-19", tenant_id="fund-b")
    _check(pin_a is not None and pin_a["root_hash"] == "0xrootA",
           f"fund-a pin lookup should return rootA, got {pin_a}")
    _check(pin_b is not None and pin_b["root_hash"] == "0xrootB",
           f"fund-b pin lookup should return rootB, got {pin_b}")
    _check(builder.latest_pin_for("2026-04-19", tenant_id="ghost") is None,
           "unknown tenant returns no pin")


_TESTS = [
    test_burner_namespace_isolated_across_tenants,
    test_default_tenant_aliases_bucket4_layout,
    test_burner_strategy_within_tenant_still_isolated,
    test_registry_default_when_unset,
    test_registry_parses_multi_tenant_env,
    test_registry_unknown_tenant_raises,
    test_daily_pack_filters_by_tenant,
    test_daily_pack_write_local_uses_tenant_subdir,
    test_latest_pin_for_filters_by_tenant,
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
