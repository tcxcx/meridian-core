"""Stdlib HTTP client for the cogito 0G anchor sidecar.

cogito runs on 127.0.0.1:5003 by default and pins JSON payloads to 0G Storage.
This module wraps it so the signal-gateway can stay pure-Python.
"""
from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Optional

log = logging.getLogger("meridian.zg")


class CogitoError(RuntimeError):
    """Raised when cogito returns a non-2xx or is unreachable."""


@dataclass
class PinResult:
    root_hash: str
    tx_hash: Optional[str]
    size_bytes: int
    kind: str


class CogitoClient:
    """One client instance per gateway process."""

    def __init__(
        self,
        base_url: str | None = None,
        token: str | None = None,
        timeout: float = 60.0,
    ) -> None:
        self.base_url = (base_url or os.environ.get("COGITO_URL", "http://127.0.0.1:5003")).rstrip("/")
        self.token = token or os.environ.get("COGITO_TOKEN") or ""
        self.timeout = timeout

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.token:
            h["Authorization"] = f"Bearer {self.token}"
        return h

    def health(self) -> dict[str, Any] | None:
        try:
            with urllib.request.urlopen(f"{self.base_url}/health", timeout=3) as r:
                return json.loads(r.read())
        except Exception as e:
            log.warning("cogito /health failed: %s", e)
            return None

    def upload(self, *, kind: str, payload: Any, meta: dict[str, Any] | None = None) -> PinResult:
        body = json.dumps({"kind": kind, "payload": payload, "meta": meta or {}}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/upload",
            data=body,
            method="POST",
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                d = json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise CogitoError(f"cogito /upload {e.code}: {e.read()[:200].decode(errors='replace')}") from e
        except urllib.error.URLError as e:
            raise CogitoError(f"cogito unreachable: {e.reason}") from e
        return PinResult(
            root_hash=str(d["root_hash"]),
            tx_hash=d.get("tx_hash"),
            size_bytes=int(d.get("size_bytes", 0)),
            kind=str(d.get("kind", kind)),
        )

    def download(self, root_hash: str) -> Any:
        req = urllib.request.Request(
            f"{self.base_url}/download/{root_hash}",
            method="GET",
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise CogitoError(f"cogito /download {e.code}: {e.read()[:200].decode(errors='replace')}") from e
        except urllib.error.URLError as e:
            raise CogitoError(f"cogito unreachable: {e.reason}") from e

    def inference(
        self,
        *,
        messages: list[dict[str, str]],
        model: str | None = None,
        provider: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        """Call cogito /compute/inference (0G DeAIOS).

        Returns the raw envelope: {content, model, provider, chat_id, valid, ...}.
        Raises CogitoError on transport / 4xx / 5xx.
        """
        body: dict[str, Any] = {"messages": messages}
        if model is not None:
            body["model"] = model
        if provider is not None:
            body["provider"] = provider
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        req = urllib.request.Request(
            f"{self.base_url}/compute/inference",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers=self._headers(),
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise CogitoError(f"cogito /compute/inference {e.code}: {e.read()[:200].decode(errors='replace')}") from e
        except urllib.error.URLError as e:
            raise CogitoError(f"cogito unreachable: {e.reason}") from e


_singleton: CogitoClient | None = None


def get_client() -> CogitoClient:
    global _singleton
    if _singleton is None:
        _singleton = CogitoClient()
    return _singleton


def is_enabled() -> bool:
    """0G anchoring is on iff a token is configured AND cogito is reachable.

    We do NOT require this for /api/signal/run to succeed — the response
    just falls back to seed_hash_0g=null, simulation_hash_0g=null.
    """
    if not os.environ.get("COGITO_TOKEN"):
        return False
    return get_client().health() is not None
