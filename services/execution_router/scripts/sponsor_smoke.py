"""End-to-end sponsor smoke test for the live Miroshark stack.

This script is intentionally stdlib-only so it can run anywhere `uv run` can.
It exercises the sponsor-backed path in this order:

  1. health checks for signal / execution / cogito
  2. operator sponsor readiness snapshot
  3. Polymarket universe scan
  4. AXL-backed signal run
  5. execution /open micro-position

The final open step is expected to fail loudly while any sponsor leg is still
misconfigured. We surface the exact error so iteration stays fast.
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
import urllib.error
import urllib.parse
import urllib.request


SIGNAL_BASE = "http://127.0.0.1:5002"
EXECUTION_BASE = "http://127.0.0.1:5004"
COGITO_BASE = "http://127.0.0.1:5003"


def _get_json(url: str, *, timeout: int = 30) -> dict:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, body: dict, *, timeout: int = 120) -> tuple[int, dict]:
    raw = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=raw,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8")
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            data = {"error": payload}
        return exc.code, data


def _print_section(title: str) -> None:
    print(f"\n== {title} ==")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--position-usdc", type=float, default=0.1)
    parser.add_argument("--scan-limit", type=int, default=3)
    args = parser.parse_args()

    failures: list[str] = []

    _print_section("Health")
    for name, url in (
        ("signal", f"{SIGNAL_BASE}/health"),
        ("execution", f"{EXECUTION_BASE}/health"),
        ("cogito", f"{COGITO_BASE}/health"),
    ):
        try:
            body = _get_json(url)
            print(f"{name:<10} {body.get('status', 'unknown')}")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name} health failed: {exc}")
            print(f"{name:<10} ERROR {exc}")

    _print_section("Sponsors")
    operator = _get_json(f"{EXECUTION_BASE}/api/execution/operator/status")
    for sponsor in operator.get("sponsors", []):
        blocker = sponsor.get("blocker")
        status = "ready" if sponsor.get("ready") else "blocked"
        detail = f" · {blocker}" if blocker else ""
        print(f"{sponsor['label']:<14} {status:<7} {sponsor.get('mode')}{detail}")
    wallets = operator.get("wallets", {})
    capital_plane = operator.get("capital_plane", {})
    if wallets or capital_plane:
        print(
            "wallets"
            f" gateway={wallets.get('gateway_treasury_balance')}"
            f" polygon_usdc={wallets.get('direct_polygon_balance_usdc')}"
            f" polygon_native={wallets.get('direct_polygon_native_balance')}"
            f" deployable={capital_plane.get('balances', {}).get('available_to_deploy')}"
        )

    _print_section("Polymarket scan")
    _, scan = _post_json(
        f"{SIGNAL_BASE}/api/signal/markets/scan",
        {"limit": args.scan_limit, "min_liquidity_usd": 5_000},
        timeout=60,
    )
    markets = scan.get("markets", [])
    print(f"markets={len(markets)}")
    if not markets:
        failures.append("market scan returned zero markets")
        print("\nFAIL: no markets returned")
        return 1

    market = markets[0]
    print(f"selected={market['question']}")

    _print_section("AXL signal run")
    run_status, run = _post_json(
        f"{SIGNAL_BASE}/api/signal/run",
        {"market_id": market["market_id"]},
        timeout=180,
    )
    print(f"status={run_status}")
    if run_status != 200:
        failures.append(f"signal run failed: {run}")
    else:
        print(
            json.dumps(
                {
                    "phase": run.get("phase"),
                    "confidence": run.get("confidence"),
                    "attestation_envelope": bool(run.get("attestation_envelope")),
                    "seed_hash_0g": run.get("seed_hash_0g"),
                },
                indent=2,
            )
        )
        if not str(run.get("phase", "")).startswith("2-axl-mesh"):
            failures.append(f"signal phase not axl-backed: {run.get('phase')}")

    _print_section("Execution open")
    open_body = {
        "position_id": str(uuid.uuid4()),
        "tenant_id": "fund-a",
        "strategy": "directional",
        "market_id": market["market_id"],
        "token_id": market["token_ids"][0],
        "side": "BUY",
        "usdc_amount": args.position_usdc,
    }
    open_status, opened = _post_json(
        f"{EXECUTION_BASE}/api/execution/open",
        open_body,
        timeout=180,
    )
    print(f"status={open_status}")
    print(json.dumps(opened, indent=2)[:4000])
    if open_status != 200:
        failures.append(f"execution open failed: {opened.get('error', opened)}")
        if "insufficient funds for gas" in json.dumps(opened):
            failures.append("polygon donor has USDC path configured but lacks native gas for the transfer")

    _print_section("Summary")
    if failures:
        for item in failures:
            print(f"- {item}")
        return 1

    print("All sponsor-backed smoke steps passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
