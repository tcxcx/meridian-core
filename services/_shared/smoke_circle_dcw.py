"""Smoke test for the Circle DCW bridge.

Run AFTER the Next.js dev server is up + CIRCLE_API_KEY/ENTITY_SECRET are set
in apps/app/.env.local + a wallet has been provisioned via /api/funds.

Usage:
    cd services
    uv run python _shared/smoke_circle_dcw.py

Stages:
    1. Verify bridge route is reachable (GET 200/405 vs ConnectError)
    2. Without auth — expect 401 if CIRCLE_BRIDGE_TOKEN set, else open
    3. Without CIRCLE_API_KEY — expect 503 with circle_not_configured
    4. With invalid wallet ID — expect 502 from Circle SDK
    5. (Optional, requires real CIRCLE wallet) — actual transfer test
"""
from __future__ import annotations

import os
import sys

import httpx

BRIDGE_URL = (os.environ.get("MIROSHARK_APP_URL") or "http://127.0.0.1:3301").rstrip("/") + "/api/circle/execute"


def step(name: str) -> None:
    print(f"\n▸ {name}")


def info(msg: str) -> None:
    print(f"  {msg}")


def main() -> int:
    print(f"Bridge URL: {BRIDGE_URL}")
    bridge_token = (os.environ.get("CIRCLE_BRIDGE_TOKEN") or "").strip()
    info(f"CIRCLE_BRIDGE_TOKEN: {'set' if bridge_token else 'unset (bridge open in dev)'}")

    step("1. Reachability — POST without body should return 400 (or 401 if token gate active)")
    try:
        r = httpx.post(BRIDGE_URL, json={}, timeout=10.0)
        info(f"HTTP {r.status_code}: {r.text[:120]}")
    except (httpx.ConnectError, httpx.TimeoutException) as e:
        info(f"✗ unreachable: {e}")
        info("  → start the Next.js dev server: cd apps/app && bun dev")
        return 1

    step("2. Unauthorized — wrong bearer token (only meaningful if CIRCLE_BRIDGE_TOKEN is set)")
    if bridge_token:
        r = httpx.post(BRIDGE_URL, headers={"Authorization": "Bearer wrong"},
                       json={"operation": "transfer", "walletId": "x", "destinationAddress": "0x0", "amount": "1"},
                       timeout=10.0)
        info(f"HTTP {r.status_code}: expected 401, got {'✓' if r.status_code == 401 else '✗'}")
    else:
        info("skipped — no CIRCLE_BRIDGE_TOKEN configured")

    step("3. Circle not configured — expect 503 if CIRCLE_API_KEY/ENTITY_SECRET unset")
    headers = {"Authorization": f"Bearer {bridge_token}"} if bridge_token else {}
    headers["Content-Type"] = "application/json"
    r = httpx.post(BRIDGE_URL, headers=headers,
                   json={"operation": "transfer", "walletId": "test-wallet-id",
                         "destinationAddress": "0x0000000000000000000000000000000000000001",
                         "amount": "1"},
                   timeout=15.0)
    info(f"HTTP {r.status_code}: {r.text[:160]}")
    if r.status_code == 503:
        info("  ✓ correctly reports circle_not_configured — set CIRCLE_API_KEY + ENTITY_SECRET to proceed")
        return 0
    if r.status_code == 502:
        info("  ✓ Circle SDK was loaded but rejected the test wallet ID (expected for fake walletId)")
        info("  → integration is wired correctly; supply a real wallet ID for end-to-end")
        return 0
    if r.status_code == 200:
        info("  ⚠ unexpected 200 with a fake wallet ID — check that the route is the new one")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
