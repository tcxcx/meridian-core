"""Smoke-test KeeperHub by submitting a no-op tx.

What this proves:
    * KEEPERHUB_API_KEY is valid + reachable.
    * KEEPERHUB_NETWORK ("421614" — Arbitrum Sepolia) is enabled on the account.
    * Our request envelope (functionArgs JSON, ABI shape) round-trips.

What it actually submits:
    Multicall3.aggregate3([]) on Arbitrum Sepolia. Multicall3 is canonical
    at `0xcA11bde05977b3631167028862bE2a173976CA11` on every EVM chain that
    matters. Passing an empty `Call3[]` array means: spend gas, mutate
    nothing, succeed. That is the cheapest legal "did the rail fire?"
    proof we can issue without provisioning any project-specific contract.

Output:
    Writes `docs/proof/keeperhub.md` with the executionId + tx hash so the
    submission package can point at one line of evidence.

Exit codes:
    0  — KeeperHub returned an executionId (success path)
    2  — KEEPERHUB_API_KEY missing (env not configured)
    3  — KeeperHub returned a non-2xx (auth/network/quota issue)
"""
from __future__ import annotations

import datetime as _dt
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

from execution_router.keeperhub import (
    KeeperHubError,
    from_env as keeperhub_from_env,
)

MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"
MULTICALL3_AGGREGATE3_ABI = [
    {
        "type": "function",
        "name": "aggregate3",
        "stateMutability": "payable",
        "inputs": [
            {
                "name": "calls",
                "type": "tuple[]",
                "components": [
                    {"name": "target", "type": "address"},
                    {"name": "allowFailure", "type": "bool"},
                    {"name": "callData", "type": "bytes"},
                ],
            }
        ],
        "outputs": [
            {
                "name": "returnData",
                "type": "tuple[]",
                "components": [
                    {"name": "success", "type": "bool"},
                    {"name": "returnData", "type": "bytes"},
                ],
            }
        ],
    }
]


def main() -> int:
    repo_root = Path(__file__).resolve().parents[3]
    env_path = repo_root / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    keeperhub = keeperhub_from_env()
    if keeperhub is None:
        print("[smoke-keeperhub] KEEPERHUB_API_KEY not set — see KEYS_NEEDED.md", file=sys.stderr)
        return 2

    network = os.environ.get("KEEPERHUB_NETWORK", "421614")
    print(f"[smoke-keeperhub] submitting Multicall3.aggregate3([]) on chain {network} …")

    try:
        result = keeperhub.contract_call(
            contract_address=MULTICALL3,
            function_name="aggregate3",
            function_args=[[]],
            abi=MULTICALL3_AGGREGATE3_ABI,
        )
    except KeeperHubError as e:
        print(f"[smoke-keeperhub] FAILED: {e}", file=sys.stderr)
        return 3

    print(f"[smoke-keeperhub] OK execution_id={result.execution_id} status={result.status} tx={result.tx_hash}")

    proof_dir = repo_root / "docs" / "proof"
    proof_dir.mkdir(parents=True, exist_ok=True)
    proof_path = proof_dir / "keeperhub.md"
    ts = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
    explorer_tx = (
        f"https://sepolia.arbiscan.io/tx/{result.tx_hash}" if result.tx_hash else "(pending)"
    )
    proof_path.write_text(
        "# KeeperHub smoke proof\n\n"
        f"- timestamp: `{ts}`\n"
        f"- network: `{network}` (Arbitrum Sepolia)\n"
        f"- contract: `{MULTICALL3}` (Multicall3)\n"
        "- function: `aggregate3([])` — empty batch, no state change\n"
        f"- executionId: `{result.execution_id}`\n"
        f"- status: `{result.status}`\n"
        f"- tx: [{result.tx_hash or '(pending)'}]({explorer_tx})\n"
        "\nRegenerate with `make smoke-keeperhub` after `KEEPERHUB_API_KEY` is set in `.env`.\n"
    )
    print(f"[smoke-keeperhub] wrote proof → {proof_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
