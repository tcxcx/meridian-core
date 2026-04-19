"""Deterministic burner-wallet derivation.

Each Polymarket position gets a fresh EOA derived from
    keccak(BURNER_SEED || tenantId || strategyId || positionId)
so that:
  * the same (tenantId, strategyId, positionId) always derives the same burner
    (idempotent recovery after a process restart, no extra secrets storage),
  * positions are unlinkable on-chain because the seed lives only on the
    treasury host,
  * different strategies running on the same market produce different burner
    addresses (per-strategy sub-accounts — Bucket 4), and
  * different tenants on the same fork produce different burner addresses
    even with identical (strategy, positionId) — the multi-tenant isolation
    guarantee from Bucket 6.

Backwards-compat is layered:
  * `(strategy=None, tenant=None)`     → keccak(seed || positionId)             (pre-Bucket-4)
  * `(strategy=X,    tenant=None)`     → keccak(seed || X || positionId)        (Bucket 4)
  * `(strategy=X,    tenant="default")`→ keccak(seed || X || positionId)        (Bucket 6 — `default` aliases Bucket 4 so existing rows re-derive)
  * `(strategy=X,    tenant=Y!=default)`→ keccak(seed || Y || X || positionId)  (Bucket 6)

so hydrated positions from earlier phases re-derive identically.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from hashlib import sha3_256

from eth_account import Account


@dataclass(frozen=True)
class Burner:
    address: str
    private_key: str
    position_id: str

    @property
    def private_key_bytes(self) -> bytes:
        pk = self.private_key
        if pk.startswith("0x"):
            pk = pk[2:]
        return bytes.fromhex(pk)


class BurnerFactory:
    def __init__(self, seed_hex: str) -> None:
        seed = seed_hex[2:] if seed_hex.startswith("0x") else seed_hex
        if len(seed) != 64:
            raise ValueError("BURNER_SEED must be a 32-byte hex string")
        self._seed = bytes.fromhex(seed)

    def derive(
        self,
        position_id: str,
        strategy_id: str | None = None,
        tenant_id: str | None = None,
    ) -> Burner:
        position_bytes = position_id.encode("utf-8")
        # `default` tenant aliases the Bucket-4 layout so existing positions
        # under the implicit "default" tenant re-derive to the same burner.
        effective_tenant = (
            tenant_id if tenant_id and tenant_id != "default" else None
        )
        if effective_tenant and strategy_id:
            digest = sha3_256(
                self._seed
                + effective_tenant.encode("utf-8")
                + strategy_id.encode("utf-8")
                + position_bytes
            ).digest()
        elif strategy_id:
            digest = sha3_256(self._seed + strategy_id.encode("utf-8") + position_bytes).digest()
        else:
            # Pre-Bucket-4 layout — kept so hydrated positions re-derive identically.
            digest = sha3_256(self._seed + position_bytes).digest()
        acct = Account.from_key(digest)
        return Burner(
            address=acct.address,
            private_key="0x" + digest.hex(),
            position_id=position_id,
        )


def from_env() -> BurnerFactory | None:
    seed = os.environ.get("BURNER_SEED")
    if not seed:
        return None
    return BurnerFactory(seed)
