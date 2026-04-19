"""CoFHE input-encryptor.

InEuint128 is the sealed-input struct that the on-chain hook decodes via
`FHE.asEuint128(InEuint128)`. Generating one requires cofhejs — which is a
TypeScript library — so the Python execution-router can't produce them
directly. Two paths:

  * `CogitoEncryptor` calls the Bun sidecar's `/fhe/encrypt` route which
    wraps cofhejs.
  * `DryRunEncryptor` returns a clearly-bogus placeholder so demo flows
    can run end-to-end without a CoFHE round-trip; chain submission will
    revert (the mock zkVerifier rejects the bogus signature) but the
    off-chain orchestration stays exercisable.

Pick the encryptor in `from_env()` based on `COGITO_BASE_URL` or `COGITO_URL`
(accept either — bridge_client and zg_client use the short form; the longer
form is kept for older deploys).
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from typing import Protocol

import httpx

log = logging.getLogger("meridian.execution.encryptor")


@dataclass(frozen=True)
class SealedInput:
    """Mirrors `InEuint128` on-chain. Field order matches the Solidity struct."""

    ct_hash: int
    security_zone: int
    utype: int
    signature: bytes

    def as_tuple(self) -> tuple:
        return (self.ct_hash, self.security_zone, self.utype, self.signature)


class Encryptor(Protocol):
    def encrypt_uint128(self, value: int, sender: str) -> SealedInput: ...


class DryRunEncryptor:
    """Returns a deterministic but invalid sealed input.

    Useful for wiring tests where we want to confirm payload shape and
    routing without a live CoFHE setup. Will revert at the chain.
    """

    def encrypt_uint128(self, value: int, sender: str) -> SealedInput:
        log.warning("dry-run encryptor in use; on-chain submission will revert")
        return SealedInput(
            ct_hash=value,
            security_zone=0,
            utype=8,  # Utype.Euint128 in cofhe-contracts
            signature=b"",
        )


class CogitoEncryptor:
    def __init__(self, base_url: str, bearer: str | None, timeout: float = 30.0) -> None:
        headers = {"Content-Type": "application/json"}
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"
        self._client = httpx.Client(base_url=base_url.rstrip("/"), headers=headers, timeout=timeout)

    def encrypt_uint128(self, value: int, sender: str) -> SealedInput:
        r = self._client.post("/fhe/encrypt", json={"value": str(value), "sender": sender, "utype": 8})
        r.raise_for_status()
        data = r.json()
        return SealedInput(
            ct_hash=int(data["ctHash"], 0) if isinstance(data["ctHash"], str) else int(data["ctHash"]),
            security_zone=int(data.get("securityZone", 0)),
            utype=int(data.get("utype", 8)),
            signature=bytes.fromhex(data["signature"][2:] if data["signature"].startswith("0x") else data["signature"]),
        )


def from_env() -> Encryptor:
    base = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL")
    if not base:
        return DryRunEncryptor()
    # Prefer COGITO_TOKEN (the canonical name used by bridge_client + zg_client);
    # fall back to COGITO_BEARER for older configs.
    bearer = os.environ.get("COGITO_TOKEN") or os.environ.get("COGITO_BEARER")
    return CogitoEncryptor(base_url=base, bearer=bearer)
