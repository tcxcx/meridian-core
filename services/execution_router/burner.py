"""Deterministic burner-wallet derivation.

Each Polymarket position gets a fresh EOA derived from
    keccak(BURNER_SEED || positionId)
so that:
  * the same positionId always derives the same burner (idempotent recovery
    after a process restart, no extra secrets storage required), and
  * positions are unlinkable on-chain because the seed lives only on the
    treasury host.
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

    def derive(self, position_id: str) -> Burner:
        position_bytes = position_id.encode("utf-8")
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
