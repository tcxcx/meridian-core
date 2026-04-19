"""KeeperHub Direct Execution wrapper.

Every on-chain tx that MERIDIAN sends in production goes through KeeperHub
so we get managed gas, retries, nonce coordination, and an auditable
`executionId` per tx. The submission framing in the BUILD_PLAN explicitly
calls out: "real fund using KeeperHub for every onchain tx", not "we
wrapped one tx for the demo".

The execution-router falls back to direct web3 sends when
`KEEPERHUB_API_KEY` is unset (dev / dry-run flows).
"""
from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass

import httpx

log = logging.getLogger("meridian.execution.keeperhub")

DEFAULT_BASE_URL = "https://app.keeperhub.com/api"
DEFAULT_GAS_LIMIT_MULTIPLIER = "1.2"


class KeeperHubError(RuntimeError):
    pass


@dataclass(frozen=True)
class ExecutionResult:
    execution_id: str
    status: str
    tx_hash: str | None


class KeeperHubClient:
    def __init__(
        self,
        api_key: str,
        network: str,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = 30.0,
    ) -> None:
        self._api_key = api_key
        self._network = network
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
        )

    def contract_call(
        self,
        contract_address: str,
        function_name: str,
        function_args: list,
        abi: list | None = None,
        value: str = "0",
        gas_limit_multiplier: str = DEFAULT_GAS_LIMIT_MULTIPLIER,
    ) -> ExecutionResult:
        payload = {
            "contractAddress": contract_address,
            "network": self._network,
            "functionName": function_name,
            "functionArgs": json.dumps(function_args),
            "value": value,
            "gasLimitMultiplier": gas_limit_multiplier,
        }
        if abi is not None:
            payload["abi"] = json.dumps(abi)

        try:
            r = self._client.post("/execute/contract-call", json=payload)
        except httpx.HTTPError as e:
            raise KeeperHubError(f"keeperhub network error: {e}") from e
        if r.status_code >= 400:
            raise KeeperHubError(f"keeperhub {r.status_code}: {r.text}")
        data = r.json()
        return ExecutionResult(
            execution_id=data.get("executionId", ""),
            status=data.get("status", "unknown"),
            tx_hash=data.get("txHash") or data.get("transactionHash"),
        )

    def close(self) -> None:
        self._client.close()


def from_env() -> KeeperHubClient | None:
    api_key = os.environ.get("KEEPERHUB_API_KEY")
    # Arbitrum Sepolia (421614) — CoFHE-supported testnet where the hook lives.
    network = os.environ.get("KEEPERHUB_NETWORK", "421614")
    if not api_key:
        return None
    return KeeperHubClient(api_key=api_key, network=network)
