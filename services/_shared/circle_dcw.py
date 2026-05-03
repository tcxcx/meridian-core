"""Python client for the Next.js Circle DCW bridge.

Phase 2 migration: Python services that previously signed with TREASURY_PRIVATE_KEY
can now route through Circle Developer-Controlled Wallets via the
/api/circle/execute Next.js route. The route handles entity-secret encryption
+ idempotency + state polling on our behalf.

Why bridge through Next.js instead of calling Circle directly:
- The Circle DCW SDK has first-class JS support (entity secret encryption is
  done client-side); the Python equivalent requires manual EC P256 + ECC
  ciphertext generation per request.
- Co-locating Circle calls in the Next.js process keeps secret management
  (CIRCLE_API_KEY + ENTITY_SECRET) in one runtime — Python only needs the
  bridge token.

Environment:
    MIROSHARK_APP_URL          base URL for the Next.js app (default http://127.0.0.1:3301)
    CIRCLE_BRIDGE_TOKEN        bearer token shared with the bridge route
    CIRCLE_DEFAULT_BLOCKCHAIN  default blockchain id (ETH-SEPOLIA, ARB-SEPOLIA, MATIC-AMOY, etc.)

This module raises CircleBridgeError on non-2xx responses so callers can
fall back to local-key signing.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

import httpx

log = logging.getLogger(__name__)


class CircleBridgeError(RuntimeError):
    """Raised when the Circle bridge returns an error or is unreachable."""

    def __init__(self, message: str, *, status_code: int | None = None,
                 body: dict | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.body = body or {}


def _bridge_url() -> str:
    base = (os.environ.get("MIROSHARK_APP_URL") or "http://127.0.0.1:3301").rstrip("/")
    return f"{base}/api/circle/execute"


def _bridge_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    token = (os.environ.get("CIRCLE_BRIDGE_TOKEN") or "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _resolve_blockchain(explicit: str | None) -> str:
    if explicit:
        return explicit.upper()
    return (os.environ.get("CIRCLE_DEFAULT_BLOCKCHAIN") or "ETH-SEPOLIA").upper()


def is_configured() -> bool:
    """True iff the bridge URL is reachable. Best-effort — we don't ping it
    here, just check that the env required by callers is present."""
    return bool(os.environ.get("MIROSHARK_APP_URL")
                and os.environ.get("CIRCLE_BRIDGE_TOKEN"))


def _post(payload: dict, *, timeout_s: float = 60.0) -> dict:
    url = _bridge_url()
    headers = _bridge_headers()
    try:
        resp = httpx.post(url, headers=headers, json=payload, timeout=timeout_s)
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        raise CircleBridgeError(f"bridge unreachable at {url}: {e}") from e
    body: dict
    try:
        body = resp.json()
    except json.JSONDecodeError:
        body = {"raw": resp.text}
    if resp.status_code >= 400:
        raise CircleBridgeError(
            f"bridge returned {resp.status_code}: {body.get('error') or body.get('message') or 'unknown'}",
            status_code=resp.status_code, body=body,
        )
    return body


def transfer_usdc(
    *,
    from_wallet_id: str,
    to_address: str,
    amount: float | str,
    blockchain: Optional[str] = None,
    token_address: Optional[str] = None,
) -> dict:
    """Transfer USDC (or any ERC-20 if token_address is set) from a Circle wallet.

    Returns the bridge response: {id, state, txHash, blockchain, polledStates, complete}.
    Raises CircleBridgeError on failure so the caller can fall back to local
    signing.
    """
    payload = {
        "operation": "transfer",
        "walletId": from_wallet_id,
        "destinationAddress": to_address,
        "amount": str(amount),
        "blockchain": _resolve_blockchain(blockchain),
    }
    if token_address:
        payload["tokenAddress"] = token_address
    log.info("circle_dcw.transfer_usdc from=%s to=%s amount=%s chain=%s",
             from_wallet_id[:12], to_address[:10], amount, payload["blockchain"])
    return _post(payload)


def execute_contract(
    *,
    from_wallet_id: str,
    contract_address: str,
    abi_function_signature: str,
    abi_parameters: list,
    amount: float | str = 0,
    blockchain: Optional[str] = None,
) -> dict:
    """Call a contract function from a Circle wallet.

    abi_function_signature must use the format 'name(type1,type2,...)' with no
    spaces (per Circle's ABI signature spec).
    abi_parameters is the list of values, in the exact order/types matching
    the signature.
    """
    payload = {
        "operation": "contract",
        "walletId": from_wallet_id,
        "contractAddress": contract_address,
        "abiFunctionSignature": abi_function_signature,
        "abiParameters": abi_parameters,
        "amount": str(amount),
        "blockchain": _resolve_blockchain(blockchain),
    }
    log.info("circle_dcw.execute_contract from=%s contract=%s fn=%s chain=%s",
             from_wallet_id[:12], contract_address[:10],
             abi_function_signature, payload["blockchain"])
    return _post(payload, timeout_s=90.0)
