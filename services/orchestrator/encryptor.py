"""Orchestrator-side CoFHE size encryption.

Pre-encrypts position sizes at the orchestrator boundary so the cleartext
USDC notional never crosses the localhost wire to the execution-router.
The router's existing CogitoEncryptor (on the router side) becomes a
fallback for its own paths (e.g. settlement payouts that originate from
hook flow), not the only path.

Calls cogito's `/fhe/encrypt` (HTTP, bearer-auth, localhost-only) and
returns a JSON-serialisable dict matching the Solidity `InEuint128`
struct field-by-field, so the router can pass it through to
`HookClient.fund_burner_with_sealed(...)` without re-encrypting.

Bucket 4 of the autonomous-fund-arb plan.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

import httpx

log = logging.getLogger("meridian.orchestrator.encryptor")


@dataclass(frozen=True)
class EncryptedSize:
    """JSON-serialisable wrapper around an `InEuint128` sealed input.

    `to_payload()` produces the dict the execution-router accepts as
    `encrypted_size_handle`. Field names match the Solidity struct
    (camelCase) so cofhejs output flows through unchanged.
    """
    ct_hash: str          # hex-encoded uint256
    security_zone: int
    utype: int
    signature: str        # hex-encoded bytes (with 0x prefix)
    sender: str

    def to_payload(self) -> dict[str, Any]:
        return {
            "ctHash": self.ct_hash,
            "securityZone": self.security_zone,
            "utype": self.utype,
            "signature": self.signature,
            "sender": self.sender,
        }


def _to_uint128(amount: Decimal, decimals: int = 6) -> int:
    return int(amount * (Decimal(10) ** decimals))


class CogitoSizeEncryptor:
    def __init__(self, base_url: str, bearer: str | None, sender: str, timeout: float = 15.0) -> None:
        headers = {"Content-Type": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        self._client = httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout)
        self._sender = sender

    def encrypt(self, amount: Decimal) -> EncryptedSize:
        value = _to_uint128(amount)
        r = self._client.post(
            "/fhe/encrypt",
            json={"value": str(value), "sender": self._sender, "utype": 8},
        )
        r.raise_for_status()
        data = r.json()
        ct = data["ctHash"]
        ct_hex = ct if isinstance(ct, str) and ct.startswith("0x") else hex(int(ct))
        sig = data["signature"]
        if not sig.startswith("0x"):
            sig = "0x" + sig
        return EncryptedSize(
            ct_hash=ct_hex,
            security_zone=int(data.get("securityZone", 0)),
            utype=int(data.get("utype", 8)),
            signature=sig,
            sender=self._sender,
        )


class _DisabledEncryptor:
    """Placeholder when ORCHESTRATOR_ENCRYPT_SIZES=false."""

    def encrypt(self, amount: Decimal) -> EncryptedSize | None:
        return None


def from_env() -> "CogitoSizeEncryptor | _DisabledEncryptor":
    if os.environ.get("ORCHESTRATOR_ENCRYPT_SIZES", "true").strip().lower() in {"0", "false", "no", "off"}:
        log.warning("ORCHESTRATOR_ENCRYPT_SIZES disabled — sizes cross the wire in cleartext")
        return _DisabledEncryptor()
    base = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL")
    if not base:
        log.warning("cogito unreachable (no COGITO_BASE_URL); orchestrator falls back to cleartext sizes")
        return _DisabledEncryptor()
    bearer = os.environ.get("COGITO_TOKEN") or os.environ.get("COGITO_BEARER")
    sender = os.environ.get("ORCHESTRATOR_ENCRYPT_SENDER") or os.environ.get("TREASURY_ADDRESS") or "0x0000000000000000000000000000000000000000"
    return CogitoSizeEncryptor(base_url=base, bearer=bearer, sender=sender)
