"""Multi-tenant config registry — Bucket 6 of autonomous-fund-arb.

A "tenant" is an isolated capital + strategy unit running inside the same
execution-router process. Forks of this kit run N tenants on one box
(fund-a, fund-b, internal-treasury, ...). Isolation guarantees:

  * Burner namespace: `keccak(BURNER_SEED ‖ tenant_id ‖ strategy_id ‖ position_id)`
    — same (strategy, position_id) under different tenants derives to
    different EOAs. See `burner.BurnerFactory.derive`.
  * Position rows carry `tenant_id`; the API's list/positions endpoints
    accept `?tenant_id=…` to filter.
  * Daily packs are tenant-scoped: cached at
    `var/daily_packs/<tenant_id>/<date>.json` and pinned with
    `meta={kind:"daily_pack", tenant_id, date}`.
  * Per-tenant capital + per-position cap + strategy whitelist are checked
    at /open time so a misconfigured tenant can't trade a strategy it
    doesn't own.

Configuration is env-driven so a fork just edits `.env`:

    TENANTS=fund-a,fund-b
    TENANT_FUND_A_CAPITAL=250
    TENANT_FUND_A_PER_POSITION_MAX=20
    TENANT_FUND_A_STRATEGIES=directional,arb
    TENANT_FUND_B_CAPITAL=100
    TENANT_FUND_B_STRATEGIES=arb

When `TENANTS` is unset (or empty), a single `default` tenant is auto-created
with permissive caps so existing single-tenant deployments keep working
without any env changes.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from decimal import Decimal


DEFAULT_TENANT_ID = "default"


@dataclass(frozen=True)
class TenantConfig:
    tenant_id: str
    capital_usdc: Decimal = Decimal("100")
    per_position_max_usdc: Decimal = Decimal("25")
    # Strategy whitelist. Empty set ⇒ allow all (permissive default tenant).
    strategies: frozenset[str] = field(default_factory=frozenset)
    # Free-form label for the verifier UI ("Internal Treasury", "Fund A").
    label: str = ""

    def allows(self, strategy: str) -> bool:
        if not self.strategies:
            return True
        return strategy in self.strategies

    def to_json(self) -> dict:
        return {
            "tenant_id": self.tenant_id,
            "label": self.label or self.tenant_id,
            "capital_usdc": str(self.capital_usdc),
            "per_position_max_usdc": str(self.per_position_max_usdc),
            "strategies": sorted(self.strategies),
        }


class TenantRegistry:
    """Process-wide tenant lookup. Built once at app boot from env."""

    def __init__(self, tenants: list[TenantConfig]) -> None:
        if not tenants:
            tenants = [TenantConfig(tenant_id=DEFAULT_TENANT_ID, label="Default")]
        # Preserve declaration order so `list()` is deterministic for the API.
        self._order: list[str] = []
        self._by_id: dict[str, TenantConfig] = {}
        for t in tenants:
            if t.tenant_id in self._by_id:
                continue
            self._by_id[t.tenant_id] = t
            self._order.append(t.tenant_id)

    def __contains__(self, tenant_id: str) -> bool:
        return tenant_id in self._by_id

    def get(self, tenant_id: str) -> TenantConfig | None:
        return self._by_id.get(tenant_id)

    def require(self, tenant_id: str) -> TenantConfig:
        cfg = self._by_id.get(tenant_id)
        if cfg is None:
            raise KeyError(f"unknown tenant: {tenant_id}")
        return cfg

    def list(self) -> list[TenantConfig]:
        return [self._by_id[t] for t in self._order]

    def ids(self) -> list[str]:
        return list(self._order)


def _split_csv(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [s.strip() for s in raw.split(",") if s.strip()]


def from_env(env: dict[str, str] | None = None) -> TenantRegistry:
    """Build a TenantRegistry from `TENANTS` + `TENANT_<UID>_*` env vars.

    Tenant ids are normalised to env-key form by uppercasing and
    replacing `-` with `_` (so `fund-a` reads `TENANT_FUND_A_*`).
    """
    src = env if env is not None else os.environ
    ids = _split_csv(src.get("TENANTS"))
    if not ids:
        return TenantRegistry([])
    tenants: list[TenantConfig] = []
    for tid in ids:
        key = tid.upper().replace("-", "_")
        capital = src.get(f"TENANT_{key}_CAPITAL")
        per_pos = src.get(f"TENANT_{key}_PER_POSITION_MAX")
        strats = _split_csv(src.get(f"TENANT_{key}_STRATEGIES"))
        label = src.get(f"TENANT_{key}_LABEL", "")
        tenants.append(TenantConfig(
            tenant_id=tid,
            capital_usdc=Decimal(capital) if capital else Decimal("100"),
            per_position_max_usdc=Decimal(per_pos) if per_pos else Decimal("25"),
            strategies=frozenset(strats),
            label=label,
        ))
    return TenantRegistry(tenants)
