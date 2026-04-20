"""Preflight readiness check for `make e2e-real`.

What this does:
    Probes every env var, every sidecar, every RPC, and prints a green/red
    matrix grouped by tier (T0 dry-run → T6 full FHE). Exits non-zero if
    any tier the operator claims to have reached is incomplete.

Usage:
    uv run python -m execution_router.scripts.preflight
    uv run python -m execution_router.scripts.preflight --target T3   # require ≥ T3 ready

Exit codes:
    0  — every required tier is GREEN
    1  — at least one required tier is RED
    2  — preflight itself crashed (network, parse, etc.)

Design:
    No dependencies on `web3`, `py-clob-client`, or `cofhejs` — just stdlib
    `urllib` + tier-by-tier env probing. Cheap to run, hard to fool.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable

# ── ANSI colors (degrade if not a tty) ───────────────────────────────────────
_TTY = sys.stdout.isatty()
def _c(s: str, code: str) -> str:
    return f"\033[{code}m{s}\033[0m" if _TTY else s
GREEN = lambda s: _c(s, "32")
RED   = lambda s: _c(s, "31")
YEL   = lambda s: _c(s, "33")
DIM   = lambda s: _c(s, "2")
BOLD  = lambda s: _c(s, "1")


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""

    def render(self) -> str:
        mark = GREEN("✓") if self.ok else RED("✗")
        body = f"{mark} {self.name}"
        if self.detail:
            body += f"  {DIM(self.detail)}"
        return body


@dataclass
class Tier:
    code: str          # "T0", "T1", ...
    label: str
    checks: list[Callable[[], CheckResult]]

    def run(self) -> tuple[bool, list[CheckResult]]:
        results = [c() for c in self.checks]
        return all(r.ok for r in results), results


# ── primitives ────────────────────────────────────────────────────────────────

def _has_env(key: str, *, min_len: int = 1) -> tuple[bool, str]:
    v = os.environ.get(key, "").strip()
    if not v:
        return False, f"{key} not set"
    if len(v) < min_len:
        return False, f"{key} too short ({len(v)} < {min_len})"
    redacted = v[:6] + "…" + v[-4:] if len(v) > 12 else "***"
    return True, f"{key}={redacted}"


def _hex_key(key: str) -> tuple[bool, str]:
    ok, detail = _has_env(key, min_len=64)
    if not ok:
        return False, detail
    raw = os.environ[key].strip().lower()
    if raw.startswith("0x"):
        raw = raw[2:]
    if len(raw) != 64:
        return False, f"{key} must be 32 bytes hex (got {len(raw)} chars)"
    try:
        int(raw, 16)
    except ValueError:
        return False, f"{key} is not valid hex"
    return True, f"{key} OK ({len(raw)} hex chars)"


def _http_json(url: str, *, timeout: float = 4.0, headers: dict | None = None,
               method: str = "GET", body: bytes | None = None) -> tuple[int, dict | str]:
    req = urllib.request.Request(url, method=method, data=body)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", errors="replace")
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", errors="replace"))
        except Exception:
            return e.code, str(e)
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        return 0, str(e)


def _service_health(name: str, url: str) -> CheckResult:
    status, body = _http_json(f"{url.rstrip('/')}/health")
    if status == 200:
        return CheckResult(f"{name} reachable", True, f"GET {url}/health → 200")
    if status == 0:
        return CheckResult(f"{name} reachable", False, f"connection failed: {body}")
    return CheckResult(f"{name} reachable", False, f"HTTP {status}")


def _rpc_chain_id(name: str, url: str, expected: int) -> CheckResult:
    if not url:
        return CheckResult(f"{name} RPC", False, "URL not set")
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode()
    status, payload = _http_json(url, method="POST", body=body,
                                 headers={"content-type": "application/json"})
    if status != 200 or not isinstance(payload, dict):
        return CheckResult(f"{name} RPC", False, f"HTTP {status} · {str(payload)[:80]}")
    result = payload.get("result")
    try:
        chain_id = int(result, 16) if isinstance(result, str) else None
    except ValueError:
        chain_id = None
    if chain_id != expected:
        return CheckResult(f"{name} RPC", False, f"chainId={chain_id} expected {expected}")
    return CheckResult(f"{name} RPC", True, f"chainId={chain_id} ({url})")


# ── tier check builders ──────────────────────────────────────────────────────

def t0_always_on() -> list[CheckResult]:
    out: list[CheckResult] = []
    ok, det = _has_env("COGITO_TOKEN", min_len=16)
    out.append(CheckResult("COGITO_TOKEN ≥ 16 chars", ok, det))
    out.append(_service_health("execution-router", os.environ.get("EXECUTION_ROUTER_URL", "http://127.0.0.1:5004")))
    out.append(_service_health("signal-gateway",   os.environ.get("SIGNAL_GATEWAY_URL", "http://127.0.0.1:5002")))
    out.append(_service_health("cogito",           os.environ.get("COGITO_URL", "http://127.0.0.1:5003")))
    return out


def t1_real_swarm() -> list[CheckResult]:
    out: list[CheckResult] = []
    ok, det = _has_env("LLM_API_KEY", min_len=20)
    out.append(CheckResult("LLM_API_KEY", ok, det))
    backend = os.environ.get("SWARM_BACKEND", "lite").lower()
    out.append(CheckResult("SWARM_BACKEND", backend in {"lite", "axl"},
                          f"SWARM_BACKEND={backend}"))
    return out


def t2_real_clob() -> list[CheckResult]:
    out: list[CheckResult] = []
    ok, det = _hex_key("BURNER_SEED")
    out.append(CheckResult("BURNER_SEED valid hex", ok, det))
    ok, det = _hex_key("POLYMARKET_PRIVATE_KEY")
    out.append(CheckResult("POLYMARKET_PRIVATE_KEY valid hex", ok, det))
    chain = os.environ.get("POLYMARKET_CHAIN_ID", "")
    out.append(CheckResult("POLYMARKET_CHAIN_ID == 80002 (Amoy)",
                           chain == "80002",
                           f"POLYMARKET_CHAIN_ID={chain or '<unset>'}"))
    return out


def t3_real_settlement() -> list[CheckResult]:
    out: list[CheckResult] = []
    ok, det = _hex_key("TREASURY_PRIVATE_KEY")
    out.append(CheckResult("TREASURY_PRIVATE_KEY valid hex", ok, det))
    out.append(_rpc_chain_id("ARB_SEPOLIA", os.environ.get("ARB_SEPOLIA_RPC_URL", ""), 421614))
    addr = os.environ.get("MERIDIAN_HOOK_ADDRESS", "").strip()
    addr_ok = addr.startswith("0x") and len(addr) == 42
    out.append(CheckResult("MERIDIAN_HOOK_ADDRESS deployed",
                           addr_ok,
                           f"MERIDIAN_HOOK_ADDRESS={addr or '<unset>'}"))
    return out


def t4_real_bridge() -> list[CheckResult]:
    out: list[CheckResult] = []
    base = os.environ.get("COGITO_URL", "http://127.0.0.1:5003").rstrip("/")
    token = os.environ.get("COGITO_TOKEN", "")
    status, body = _http_json(f"{base}/health",
                              headers={"authorization": f"Bearer {token}"} if token else None)
    if status != 200 or not isinstance(body, dict):
        out.append(CheckResult("cogito /health.gateway", False,
                               f"cogito unreachable (HTTP {status})"))
        return out
    gw = body.get("gateway") if isinstance(body, dict) else None
    if not gw:
        out.append(CheckResult("cogito /health.gateway", False,
                               "no `gateway` key in /health response"))
        return out
    bal = gw.get("treasuryBalance") or gw.get("balance") or 0
    try:
        bal_n = float(bal)
    except (TypeError, ValueError):
        bal_n = 0.0
    out.append(CheckResult("Gateway treasury pre-deposited",
                           bal_n > 0,
                           f"GatewayWallet treasury balance = {bal_n} USDC"))
    return out


def t5_real_0g() -> list[CheckResult]:
    out: list[CheckResult] = []
    ok, det = _hex_key("ZG_PRIVATE_KEY")
    out.append(CheckResult("ZG_PRIVATE_KEY valid hex", ok, det))
    out.append(_rpc_chain_id("ZG_RPC", os.environ.get("ZG_RPC_URL", ""), 16601))
    base = os.environ.get("COGITO_URL", "http://127.0.0.1:5003").rstrip("/")
    token = os.environ.get("COGITO_TOKEN", "")
    status, body = _http_json(f"{base}/health",
                              headers={"authorization": f"Bearer {token}"} if token else None)
    storage_ok = isinstance(body, dict) and bool((body.get("storage") or {}).get("ok"))
    out.append(CheckResult("cogito /health.storage.ok",
                           storage_ok,
                           f"storage={body.get('storage') if isinstance(body, dict) else body}"))
    return out


def t6_real_fhe() -> list[CheckResult]:
    out: list[CheckResult] = []
    fhe_explicit = os.environ.get("FHE_PRIVATE_KEY", "").strip()
    treasury     = os.environ.get("TREASURY_PRIVATE_KEY", "").strip()
    if fhe_explicit:
        detail = "FHE_PRIVATE_KEY set"
        has_key = True
    elif treasury:
        detail = "FHE_PRIVATE_KEY not set — falling back to TREASURY_PRIVATE_KEY"
        has_key = True
    else:
        detail = "neither FHE_PRIVATE_KEY nor TREASURY_PRIVATE_KEY is set"
        has_key = False
    out.append(CheckResult("FHE_PRIVATE_KEY (or TREASURY fallback)", has_key, detail))
    base = os.environ.get("COGITO_URL", "http://127.0.0.1:5003").rstrip("/")
    token = os.environ.get("COGITO_TOKEN", "")
    headers = {"authorization": f"Bearer {token}", "content-type": "application/json"} if token else {}
    body = json.dumps({"value": "1", "sender": "0x0000000000000000000000000000000000000001"}).encode()
    status, payload = _http_json(f"{base}/fhe/encrypt", method="POST", body=body, headers=headers)
    encrypt_ok = status == 200 and isinstance(payload, dict) and "ctHash" in payload
    out.append(CheckResult("cogito POST /fhe/encrypt mints InEuint128",
                           encrypt_ok,
                           f"HTTP {status} · {str(payload)[:80]}"))
    return out


# ── orchestration ────────────────────────────────────────────────────────────

TIERS: list[Tier] = [
    Tier("T0", "Always-on (dry-run baseline)",     [lambda: t0_always_on()]),  # type: ignore[list-item]
    Tier("T1", "Real swarm (LLM)",                 [lambda: t1_real_swarm()]),  # type: ignore[list-item]
    Tier("T2", "Real Polymarket CLOB",             [lambda: t2_real_clob()]),  # type: ignore[list-item]
    Tier("T3", "Real settlement (Arb Sepolia)",    [lambda: t3_real_settlement()]),  # type: ignore[list-item]
    Tier("T4", "Real Circle Gateway bridge",       [lambda: t4_real_bridge()]),  # type: ignore[list-item]
    Tier("T5", "Real 0G Storage anchor",           [lambda: t5_real_0g()]),  # type: ignore[list-item]
    Tier("T6", "Real Fhenix CoFHE encrypt",        [lambda: t6_real_fhe()]),  # type: ignore[list-item]
]


def _flatten(checks: list) -> list[CheckResult]:
    out: list[CheckResult] = []
    for c in checks:
        r = c()
        out.extend(r if isinstance(r, list) else [r])
    return out


def run(target: str | None) -> int:
    print(BOLD("\n  MERIDIAN preflight\n"))
    highest_green = None
    failed_required = False
    for tier in TIERS:
        results = _flatten(tier.checks)
        ok = all(r.ok for r in results)
        if ok:
            highest_green = tier.code
        head = GREEN(f"  {tier.code} READY  ") if ok else YEL(f"  {tier.code} GAP    ")
        print(f"{head}{tier.label}")
        for r in results:
            print(f"      {r.render()}")
        print()
        if target and tier.code <= target and not ok:
            failed_required = True

    summary_line = f"  Highest green tier: {GREEN(highest_green) if highest_green else RED('none')}"
    if target:
        summary_line += f"   ·  required: {target}"
    print(BOLD(summary_line))
    print()

    if failed_required:
        print(RED(f"  ✗ preflight failed — required tier {target} is incomplete\n"))
        return 1
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="MERIDIAN demo readiness preflight")
    p.add_argument("--target", choices=[t.code for t in TIERS], default=None,
                   help="Exit non-zero if this tier (or any below) is incomplete.")
    args = p.parse_args()
    try:
        return run(args.target)
    except Exception as exc:  # noqa: BLE001 — preflight should never crash silently
        print(RED(f"\n  preflight crashed: {exc}\n"))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
