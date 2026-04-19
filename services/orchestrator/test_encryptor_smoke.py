"""Smoke test: orchestrator-side CoFHE size encryptor.

Run:
    cd meridian-core/services
    uv run python -m orchestrator.test_encryptor_smoke

Exit 0 = encryptor wiring proven (payload shape, fallback, env gating).

Does NOT hit cogito. Builds a fake httpx client that records calls and
returns a canned `/fhe/encrypt` response, then asserts the resulting
EncryptedSize.to_payload() matches the Solidity `InEuint128` struct
field-by-field.
"""
from __future__ import annotations

import os
import sys
from decimal import Decimal

from .encryptor import (
    CogitoSizeEncryptor,
    EncryptedSize,
    _DisabledEncryptor,
    _to_uint128,
    from_env,
)


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok  {msg}")


class _FakeResponse:
    def __init__(self, data: dict, status: int = 200) -> None:
        self._data = data
        self.status_code = status

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        return self._data


class _FakeClient:
    def __init__(self, data: dict) -> None:
        self._data = data
        self.calls: list[tuple[str, dict]] = []

    def post(self, path: str, json: dict) -> _FakeResponse:  # noqa: A002
        self.calls.append((path, json))
        return _FakeResponse(self._data)


def test_to_uint128_six_decimals() -> None:
    _check(_to_uint128(Decimal("1")) == 1_000_000, "1 USDC → 1e6 uint128")
    _check(_to_uint128(Decimal("12.345678")) == 12_345_678, "fractional USDC preserved at 6dp")
    _check(_to_uint128(Decimal("0")) == 0, "zero USDC → 0 uint128")


def test_encrypt_payload_shape() -> None:
    enc = CogitoSizeEncryptor(base_url="http://x", bearer="t", sender="0xabc")
    enc._client = _FakeClient({  # type: ignore[assignment]
        "ctHash": "0xdeadbeef",
        "securityZone": 0,
        "utype": 8,
        "signature": "0x1234",
    })
    out = enc.encrypt(Decimal("5"))
    _check(isinstance(out, EncryptedSize), "encrypt returns EncryptedSize")
    payload = out.to_payload()
    _check(set(payload.keys()) == {"ctHash", "securityZone", "utype", "signature", "sender"},
           "payload contains exactly the InEuint128 + sender fields")
    _check(payload["ctHash"] == "0xdeadbeef", "ctHash passes through unchanged")
    _check(payload["securityZone"] == 0, "securityZone is int 0")
    _check(payload["utype"] == 8, "utype defaults to 8 (Euint128)")
    _check(payload["signature"] == "0x1234", "signature is 0x-prefixed hex")
    _check(payload["sender"] == "0xabc", "sender echoes encryptor config")
    # Verify the wire call sent the 6dp uint128 + sender + utype.
    call_path, call_body = enc._client.calls[0]  # type: ignore[union-attr]
    _check(call_path == "/fhe/encrypt", "POSTs to /fhe/encrypt")
    _check(call_body["value"] == "5000000", "value = 5 USDC × 1e6 as string")
    _check(call_body["sender"] == "0xabc", "sender forwarded to cogito")
    _check(call_body["utype"] == 8, "utype 8 forwarded to cogito")


def test_signature_normalisation() -> None:
    enc = CogitoSizeEncryptor(base_url="http://x", bearer=None, sender="0xs")
    enc._client = _FakeClient({  # type: ignore[assignment]
        "ctHash": "0x1",
        "securityZone": 0,
        "utype": 8,
        "signature": "abcd",  # bare hex, no 0x
    })
    out = enc.encrypt(Decimal("1"))
    _check(out.signature == "0xabcd", "bare-hex signature gets 0x prefix")


def test_disabled_encryptor_returns_none() -> None:
    d = _DisabledEncryptor()
    _check(d.encrypt(Decimal("5")) is None, "disabled encryptor returns None (cleartext fallback)")


def test_from_env_gating() -> None:
    # Save + restore env so we don't pollute the test process.
    saved = {k: os.environ.get(k) for k in (
        "ORCHESTRATOR_ENCRYPT_SIZES", "COGITO_BASE_URL", "COGITO_URL", "COGITO_TOKEN", "COGITO_BEARER",
        "ORCHESTRATOR_ENCRYPT_SENDER", "TREASURY_ADDRESS",
    )}
    try:
        # Disabled by env flag → no-op.
        os.environ["ORCHESTRATOR_ENCRYPT_SIZES"] = "false"
        os.environ.pop("COGITO_BASE_URL", None)
        os.environ.pop("COGITO_URL", None)
        e = from_env()
        _check(isinstance(e, _DisabledEncryptor),
               "ORCHESTRATOR_ENCRYPT_SIZES=false → _DisabledEncryptor")

        # Enabled but no cogito URL → still falls back to disabled.
        os.environ["ORCHESTRATOR_ENCRYPT_SIZES"] = "true"
        os.environ.pop("COGITO_BASE_URL", None)
        os.environ.pop("COGITO_URL", None)
        e = from_env()
        _check(isinstance(e, _DisabledEncryptor),
               "no COGITO_BASE_URL → _DisabledEncryptor (fail-soft)")

        # Enabled + URL present → real client.
        os.environ["COGITO_BASE_URL"] = "http://127.0.0.1:5003"
        os.environ["TREASURY_ADDRESS"] = "0xfeedface"
        e = from_env()
        _check(isinstance(e, CogitoSizeEncryptor), "URL present → CogitoSizeEncryptor")
        _check(e._sender == "0xfeedface", "sender pulled from TREASURY_ADDRESS when ENCRYPT_SENDER unset")
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def main() -> int:
    print("encryptor smoke...")
    test_to_uint128_six_decimals()
    test_encrypt_payload_shape()
    test_signature_normalisation()
    test_disabled_encryptor_returns_none()
    test_from_env_gating()
    print("OK — orchestrator encryptor wiring proven.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
