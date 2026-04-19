"""Per-position attestation pinning to 0G Storage via cogito.

Bucket 4 of autonomous-fund-arb. After /resolve runs to completion the
execution-router pins a small JSON envelope describing the position's
encrypted lifecycle (size handle, payout, strategy, timestamps) to 0G
Storage. The returned root_hash anchors the daily attestation pack
(Bucket 5) and the public verifier page.

Pinning is best-effort: failure logs + records an audit event but does not
fail the /resolve request. cogito unreachable = `from_env` returns None
(disabled) and the api treats pinning as a no-op.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

log = logging.getLogger("meridian.execution.attestation")


@dataclass(frozen=True)
class PinResult:
    root_hash: str
    tx_hash: str | None
    size_bytes: int


class CogitoAttestationClient:
    def __init__(self, base_url: str, token: str | None, timeout: float = 30.0) -> None:
        self._base = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def pin(self, payload: dict[str, Any], *, meta: dict[str, Any] | None = None) -> PinResult:
        body = json.dumps({"kind": "other", "payload": payload, "meta": meta or {}}).encode("utf-8")
        req = urllib.request.Request(
            f"{self._base}/upload",
            data=body,
            method="POST",
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as r:
                d = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"cogito /upload {e.code}: {e.read()[:200].decode(errors='replace')}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"cogito unreachable: {e.reason}") from e
        return PinResult(
            root_hash=str(d["root_hash"]),
            tx_hash=d.get("tx_hash"),
            size_bytes=int(d.get("size_bytes", 0)),
        )


def from_env() -> CogitoAttestationClient | None:
    base = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL")
    if not base:
        return None
    token = os.environ.get("COGITO_TOKEN") or os.environ.get("COGITO_BEARER")
    return CogitoAttestationClient(base_url=base, token=token)
