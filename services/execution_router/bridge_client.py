"""Circle Gateway client (talks to cogito's `/bridge` and `/bridge/deposit`).

MERIDIAN runs on two chains:

  - Arbitrum Sepolia (domain 3) — fhUSDC + PrivateSettlementHook live here (CoFHE).
  - Polygon PoS Amoy (domain 7) — Polymarket CLOB + order EOAs live here.

`/open` flow:
  treasury (Arb Sepolia, pre-deposited into Gateway unified balance)
      → bridge with destinationRecipient = burner address (Polygon Amoy)
      → Circle Forwarder mints USDC to burner
      → CLOB submit on Polygon

`/resolve` flow:
  burner (Polygon Amoy)
      → deposit USDC into GatewayWallet on Polygon (creates burner unified balance)
      → bridge with destinationRecipient = treasury address (Arb Sepolia)
      → Circle Forwarder mints USDC to treasury
      → markResolved + settle on Arb Sepolia

Why Gateway? Sub-500ms transfers, unified balance, and with the Forwarding
Service Circle handles the destination mint — cogito doesn't need a hot wallet
or native gas on the destination chain.

Graceful degradation: when cogito `/bridge` is unreachable or returns `ready:
false`, this client falls back to a synthetic dry-run result so the
execution-router end-to-end flow still completes in offline mode.
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass, field
from typing import Literal

import httpx

log = logging.getLogger("meridian.execution.bridge")


SignerKind = Literal["treasury", "burner"]


class BridgeKitError(RuntimeError):
    """Kept under the historical name so callers don't have to re-import."""


# Friendly, lowercase chain keys — must match cogito's `gatewayChains.ts` registry.
DEFAULT_FROM_CHAIN = "arbitrum_sepolia"
DEFAULT_TO_CHAIN = "polygon_amoy"


@dataclass(frozen=True)
class BridgeStep:
    name: str
    state: str
    tx_hash: str | None
    explorer_url: str | None
    detail: str | None = None


@dataclass
class BridgeResult:
    ok: bool
    state: str
    amount: str
    from_chain: str | None
    to_chain: str | None
    transfer_id: str | None = None
    steps: list[BridgeStep] = field(default_factory=list)
    dry_run: bool = False

    @property
    def burn_tx(self) -> str | None:
        """For Gateway, this is the transferId (Circle does the source-side burn)."""
        for s in self.steps:
            if s.name == "burn":
                return s.tx_hash
        return self.transfer_id

    @property
    def mint_tx(self) -> str | None:
        """Destination forwardTxHash from Circle's poll response."""
        for s in self.steps:
            if s.name == "mint":
                return s.tx_hash
        return None


@dataclass
class DepositResult:
    ok: bool
    state: str
    chain: str
    domain: int
    depositor: str
    amount: str
    steps: list[BridgeStep] = field(default_factory=list)
    dry_run: bool = False

    @property
    def approve_tx(self) -> str | None:
        for s in self.steps:
            if s.name == "approve":
                return s.tx_hash
        return None

    @property
    def deposit_tx(self) -> str | None:
        for s in self.steps:
            if s.name == "deposit":
                return s.tx_hash
        return None


class BridgeClient:
    """Thin typed wrapper around cogito's /bridge + /bridge/deposit routes."""

    def __init__(
        self,
        base_url: str,
        token: str | None,
        timeout: float = 300.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        # Long timeout — Gateway forwarder can take 60-120s on testnet round-trip.
        self._client = httpx.Client(
            base_url=self._base_url,
            timeout=timeout,
            headers=self._headers(),
        )

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self._token:
            h["Authorization"] = f"Bearer {self._token}"
        return h

    def deposit(
        self,
        *,
        chain: str,
        amount_usdc: float,
        signer: SignerKind = "treasury",
        burner_private_key: str | None = None,
    ) -> DepositResult:
        if signer == "burner" and not burner_private_key:
            raise BridgeKitError("signer=burner requires burner_private_key")

        signer_payload: dict = {"kind": signer}
        if signer == "burner":
            signer_payload["private_key"] = burner_private_key

        body = {
            "chain": chain,
            "amount": _amount_str(amount_usdc),
            "signer": signer_payload,
        }

        try:
            r = self._client.post("/bridge/deposit", json=body)
        except httpx.HTTPError as e:
            raise BridgeKitError(f"cogito /bridge/deposit network error: {e}") from e

        if r.status_code >= 400:
            raise BridgeKitError(f"cogito /bridge/deposit {r.status_code}: {r.text}")

        data = r.json()
        return DepositResult(
            ok=bool(data.get("ok")),
            state=data.get("state", "unknown"),
            chain=data.get("chain", chain),
            domain=int(data.get("domain", 0)),
            depositor=data.get("depositor", ""),
            amount=data.get("amount", body["amount"]),
            steps=_parse_steps(data.get("steps", [])),
        )

    def bridge(
        self,
        *,
        signer: SignerKind,
        from_chain: str,
        to_chain: str,
        amount_usdc: float,
        burner_private_key: str | None = None,
        recipient: str | None = None,
        use_forwarder: bool = True,
    ) -> BridgeResult:
        if signer == "burner" and not burner_private_key:
            raise BridgeKitError("signer=burner requires burner_private_key")
        if signer == "treasury" and burner_private_key:
            log.debug("burner_private_key ignored when signer=treasury")

        signer_payload: dict = {"kind": signer}
        if signer == "burner":
            signer_payload["private_key"] = burner_private_key

        body = {
            "signer": signer_payload,
            "from_chain": from_chain,
            "to_chain": to_chain,
            "amount": _amount_str(amount_usdc),
            "use_forwarder": use_forwarder,
        }
        if recipient:
            body["recipient"] = recipient

        try:
            r = self._client.post("/bridge", json=body)
        except httpx.HTTPError as e:
            raise BridgeKitError(f"cogito /bridge network error: {e}") from e

        if r.status_code >= 400:
            raise BridgeKitError(f"cogito /bridge {r.status_code}: {r.text}")

        data = r.json()
        return BridgeResult(
            ok=bool(data.get("ok")),
            state=data.get("state", "unknown"),
            amount=data.get("amount", body["amount"]),
            from_chain=(data.get("from") or {}).get("chain"),
            to_chain=(data.get("to") or {}).get("chain"),
            transfer_id=data.get("transferId"),
            steps=_parse_steps(data.get("steps", [])),
        )

    def close(self) -> None:
        self._client.close()


class DryRunBridgeClient:
    """Fallback when cogito /bridge is unavailable. Returns synthetic txs so
    the execution-router demo flow can complete without a live attestation."""

    def deposit(
        self,
        *,
        chain: str,
        amount_usdc: float,
        signer: SignerKind = "treasury",
        burner_private_key: str | None = None,
    ) -> DepositResult:
        del burner_private_key
        return DepositResult(
            ok=True,
            state="success",
            chain=chain,
            domain=3 if chain == "arbitrum_sepolia" else 7,
            depositor="0x" + "00" * 20,
            amount=_amount_str(amount_usdc),
            steps=[
                BridgeStep(name="approve", state="success", tx_hash="0x" + secrets.token_hex(32), explorer_url=None),
                BridgeStep(name="deposit", state="success", tx_hash="0x" + secrets.token_hex(32), explorer_url=None),
            ],
            dry_run=True,
        )

    def bridge(
        self,
        *,
        signer: SignerKind,
        from_chain: str,
        to_chain: str,
        amount_usdc: float,
        burner_private_key: str | None = None,
        recipient: str | None = None,
        use_forwarder: bool = True,
    ) -> BridgeResult:
        del burner_private_key, recipient, use_forwarder
        transfer_id = "tr_dryrun_" + secrets.token_hex(8)
        mint_hash = "0x" + secrets.token_hex(32)
        return BridgeResult(
            ok=True,
            state="success",
            amount=_amount_str(amount_usdc),
            from_chain=from_chain,
            to_chain=to_chain,
            transfer_id=transfer_id,
            steps=[
                BridgeStep(name="estimate", state="success", tx_hash=None, explorer_url=None, detail="dry-run"),
                BridgeStep(name="burnSigned", state="success", tx_hash=None, explorer_url=None),
                BridgeStep(name="burn", state="success", tx_hash=transfer_id, explorer_url=None),
                BridgeStep(name="mint", state="success", tx_hash=mint_hash, explorer_url=None),
            ],
            dry_run=True,
        )

    def close(self) -> None:
        pass


BridgeLike = BridgeClient | DryRunBridgeClient


def _amount_str(amount_usdc: float) -> str:
    """USDC = 6 decimals. Format without trailing zeros so cogito's regex passes."""
    s = f"{amount_usdc:.6f}".rstrip("0").rstrip(".")
    return s or "0"


def _parse_steps(raw: list[dict]) -> list[BridgeStep]:
    return [
        BridgeStep(
            name=s.get("name", ""),
            state=s.get("state", ""),
            tx_hash=s.get("tx_hash"),
            explorer_url=s.get("explorer_url"),
            detail=s.get("detail"),
        )
        for s in raw
    ]


def from_env() -> BridgeLike:
    base_url = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL")
    token = os.environ.get("COGITO_TOKEN")
    if not base_url:
        log.info("bridge_client: COGITO_BASE_URL unset — using DryRunBridgeClient")
        return DryRunBridgeClient()
    return BridgeClient(base_url=base_url, token=token)
