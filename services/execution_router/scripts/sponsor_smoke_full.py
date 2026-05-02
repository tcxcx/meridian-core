"""Full open->resolve dogfood smoke test for the live Miroshark stack.

Extends sponsor_smoke.py to drive the entire trade lifecycle:

    health -> sponsor readiness -> scan -> signal run -> /open
    -> poll until status='open' -> /resolve -> poll until status='settled'
    -> fetch /audit/<position_id> -> assert event sequence + no dry_run leaks

This is the demo backbone test that /autoplan Phase 3 Eng E1 specified:
  * --require-real flag fails the run if any audit event payload contains
    `dry_run: true`. Use this in pre-demo validation (T-30min) to catch
    silently-degraded sponsor legs before judges see them.
  * Without --require-real the script tolerates dry-run fallbacks so it can
    also serve as a stack-up smoke during local development.

Stdlib only — runs anywhere `uv run` runs. Returns 0 on success, 1 on any
failure with a structured summary.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid
import urllib.error
import urllib.request


SIGNAL_BASE = "http://127.0.0.1:5002"
EXECUTION_BASE = "http://127.0.0.1:5004"
COGITO_BASE = "http://127.0.0.1:5003"

EXPECTED_OPEN_EVENTS = (
    "open.received",
    "fund_burner.ok",
    "bridge_send.ok",
    "clob_submit.ok",
    "open.ok",
)
EXPECTED_RESOLVE_EVENTS = (
    "resolve.received",
    "gateway_deposit.ok",
    "bridge_recv.ok",
    "mark_resolved.ok",
    "settle.ok",
    "settled.ok",
)


def _get_json(url: str, *, timeout: int = 30) -> dict:
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _post_json(url: str, body: dict, *, timeout: int = 180) -> tuple[int, dict]:
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


def _poll_status(position_id: str, target_statuses: tuple[str, ...], *, timeout_s: int) -> dict | None:
    deadline = time.monotonic() + timeout_s
    last: dict | None = None
    while time.monotonic() < deadline:
        try:
            last = _get_json(f"{EXECUTION_BASE}/api/execution/positions/{position_id}", timeout=10)
        except Exception as exc:  # noqa: BLE001
            print(f"  poll error: {exc}")
            time.sleep(2)
            continue
        status = last.get("status") or last.get("position", {}).get("status")
        elapsed = int(timeout_s - (deadline - time.monotonic()))
        print(f"  t+{elapsed:>3}s status={status}")
        if status in target_statuses:
            return last
        if status in ("failed",):
            return last
        time.sleep(2)
    return last


def _check_no_dry_run(events: list[dict]) -> list[str]:
    """Return a list of audit events whose payload signals dry-run/synthetic."""
    leaks: list[str] = []
    for ev in events:
        payload = ev.get("payload") or {}
        if payload.get("dry_run") is True:
            leaks.append(f"{ev.get('event')}: dry_run=true")
            continue
        # CLOB returns clob_status='dry_run' inside fund_burner / clob_submit payloads
        if payload.get("clob_status") == "dry_run":
            leaks.append(f"{ev.get('event')}: clob_status=dry_run")
        # bridge state='success' with synthetic tx hash prefix
        for key in ("tx_hash", "burn_tx_hash", "mint_tx_hash", "transfer_id"):
            value = payload.get(key)
            if isinstance(value, str) and value.startswith("tr_dryrun_"):
                leaks.append(f"{ev.get('event')}: {key}={value}")
    return leaks


def _check_event_sequence(events: list[dict], expected: tuple[str, ...]) -> list[str]:
    """Return a list of expected event names that did not appear in order."""
    seen = [e.get("event") for e in events]
    missing: list[str] = []
    cursor = 0
    for expected_event in expected:
        # tolerate optional events (gateway_deposit may be skipped if treasury-funded)
        try:
            idx = seen.index(expected_event, cursor)
            cursor = idx + 1
        except ValueError:
            missing.append(expected_event)
    return missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--position-usdc", type=float, default=0.1,
                        help="USDC notional for the test position")
    parser.add_argument("--payout-usdc", type=float, default=0.05,
                        help="payout USDC to pass to /resolve")
    parser.add_argument("--scan-limit", type=int, default=3)
    parser.add_argument("--require-real", action="store_true",
                        help="fail if any audit event payload signals dry-run / synthetic")
    parser.add_argument("--open-timeout-s", type=int, default=180,
                        help="max wait for /open to land status=='open'")
    parser.add_argument("--resolve-timeout-s", type=int, default=240,
                        help="max wait for /resolve to land status=='settled'")
    parser.add_argument("--tenant-id", default="default")
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
            if name == "execution":
                wiring = body.get("wiring", {})
                if not wiring.get("audit_healthy", True):
                    failures.append("execution audit DB unhealthy (wiring.audit_healthy=false)")
        except Exception as exc:  # noqa: BLE001
            failures.append(f"{name} health failed: {exc}")
            print(f"{name:<10} ERROR {exc}")
            return 1

    _print_section("Sponsors")
    operator = _get_json(f"{EXECUTION_BASE}/api/execution/operator/status")
    for sponsor in operator.get("sponsors", []):
        blocker = sponsor.get("blocker") or ""
        status = "ready" if sponsor.get("ready") else "blocked"
        detail = f" · {blocker}" if blocker else ""
        print(f"{sponsor['label']:<14} {status:<7} {sponsor.get('mode')}{detail}")

    _print_section("Polymarket scan")
    _, scan = _post_json(
        f"{SIGNAL_BASE}/api/signal/markets/scan",
        {"limit": args.scan_limit, "min_liquidity_usd": 5_000},
        timeout=60,
    )
    markets = scan.get("markets", [])
    print(f"markets={len(markets)}")
    if not markets:
        print("FAIL: no markets returned")
        return 1
    market = markets[0]
    print(f"selected={market['question']}")

    _print_section("Execution open")
    position_id = str(uuid.uuid4())
    open_body = {
        "position_id": position_id,
        "tenant_id": args.tenant_id,
        "strategy": "directional",
        "market_id": market["market_id"],
        "token_id": market["token_ids"][0],
        "side": "BUY",
        "usdc_amount": args.position_usdc,
    }
    open_status, opened = _post_json(
        f"{EXECUTION_BASE}/api/execution/open", open_body, timeout=240,
    )
    print(f"position_id={position_id}")
    print(f"status={open_status}")
    if open_status != 200:
        print(json.dumps(opened, indent=2)[:2000])
        failures.append(f"/open failed: {opened.get('error', opened)}")
        return _summarize(failures)

    _print_section("Wait for status='open'")
    open_state = _poll_status(position_id, ("open",), timeout_s=args.open_timeout_s)
    if not open_state or (open_state.get("status") or open_state.get("position", {}).get("status")) != "open":
        failures.append(f"position never reached status='open' within {args.open_timeout_s}s")
        return _summarize(failures, position_id=position_id)

    _print_section("Execution resolve")
    resolve_status, resolved = _post_json(
        f"{EXECUTION_BASE}/api/execution/resolve",
        {"position_id": position_id, "payout_usdc": args.payout_usdc},
        timeout=240,
    )
    print(f"status={resolve_status}")
    if resolve_status != 200:
        print(json.dumps(resolved, indent=2)[:2000])
        failures.append(f"/resolve failed: {resolved.get('error', resolved)}")
        return _summarize(failures, position_id=position_id)

    _print_section("Wait for status='settled'")
    settled_state = _poll_status(position_id, ("settled",), timeout_s=args.resolve_timeout_s)
    final_status = (settled_state or {}).get("status") or (settled_state or {}).get("position", {}).get("status")
    if final_status != "settled":
        failures.append(f"position never reached status='settled' within {args.resolve_timeout_s}s (last={final_status})")

    _print_section("Audit")
    audit = _get_json(f"{EXECUTION_BASE}/api/execution/audit/{position_id}", timeout=10)
    events = audit.get("events", [])
    print(f"events={len(events)}")
    for ev in events:
        flag = "" if ev.get("status") in ("ok", "info") else f" [{ev.get('status')}]"
        print(f"  {ev.get('event'):<24} {ev.get('status'):<6}{flag}")

    missing_open = _check_event_sequence(events, EXPECTED_OPEN_EVENTS)
    if missing_open:
        failures.append(f"missing /open audit events (in order): {missing_open}")
    missing_resolve = _check_event_sequence(events, EXPECTED_RESOLVE_EVENTS)
    if missing_resolve:
        failures.append(f"missing /resolve audit events (in order): {missing_resolve}")

    if args.require_real:
        leaks = _check_no_dry_run(events)
        if leaks:
            failures.append("--require-real: dry-run leaks detected:")
            failures.extend(f"    {leak}" for leak in leaks)

    return _summarize(failures, position_id=position_id)


def _summarize(failures: list[str], *, position_id: str | None = None) -> int:
    _print_section("Summary")
    if position_id:
        print(f"position_id={position_id}")
    if failures:
        for item in failures:
            print(f"- {item}")
        print(f"\nFAIL ({len(failures)} issue(s))")
        return 1
    print("All open->resolve dogfood steps passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
