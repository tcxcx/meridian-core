"""Polymarket CLOB submission.

Wraps `py-clob-client` so the rest of the router can place market-style
orders without depending on the SDK directly. The burner wallet is the
EOA that signs CLOB orders (signature_type=0). Each burner needs Polygon
USDC + USDC allowance to the CLOB exchange before it can trade — the
hackathon flow funds burners off-screen and we surface the missing-funds
case as a graceful 'dry run' instead of crashing the API.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from hashlib import sha256
from decimal import Decimal

from py_clob_client.client import ClobClient
from py_clob_client.clob_types import ApiCreds, AssetType, BalanceAllowanceParams, MarketOrderArgs, OrderType
from py_clob_client.constants import POLYGON
from py_clob_client.order_builder.constants import BUY, SELL
from web3 import Web3

log = logging.getLogger("meridian.execution.clob")

DEFAULT_HOST = "https://clob.polymarket.com"


@dataclass(frozen=True)
class ClobOrderResult:
    order_id: str
    status: str  # "submitted" | "dry_run" | "error"
    raw: dict | None = None


@dataclass(frozen=True)
class BurnerBalanceSnapshot:
    shares: float
    usdc_before: float
    usdc_after: float
    exit_usdc: float


def _synthetic_order_id(burner: str, token_id: str, side: str, amount: float) -> str:
    digest = sha256(f"{burner}|{token_id}|{side}|{amount}".encode()).hexdigest()
    return f"DRY_RUN_{digest[:16]}"


class ClobSubmitter:
    """Per-burner CLOB submitter.

    Re-instantiate per position: the SDK binds a single signer per client.
    """

    def __init__(self, burner_private_key: str, host: str = DEFAULT_HOST, chain_id: int = POLYGON) -> None:
        self._client = ClobClient(host=host, key=burner_private_key, chain_id=chain_id, signature_type=0)
        # Derive (or reuse) API key for L2 endpoints — required for placing orders.
        try:
            creds: ApiCreds = self._client.create_or_derive_api_creds()
            self._client.set_api_creds(creds)
        except Exception as e:  # noqa: BLE001 — many failure modes from polymarket APIs
            log.warning("clob api-key derivation failed (continuing in dry-run mode): %s", e)
            self._creds_ok = False
        else:
            self._creds_ok = True
        self._conditional = self._client.get_conditional_address()
        self._collateral = self._client.get_collateral_address()
        self._rpc = (
            os.environ.get("POLYGON_AMOY_RPC_URL")
            or os.environ.get("POLYGON_RPC_URL")
            or "https://rpc-amoy.polygon.technology"
        )
        self._w3 = Web3(Web3.HTTPProvider(self._rpc))

    @property
    def creds_ok(self) -> bool:
        return self._creds_ok

    def market_buy(self, token_id: str, usdc_amount: float) -> ClobOrderResult:
        """USD-on-BUY market order (FOK). Amount is dollar notional, not shares."""
        if not self._creds_ok:
            return ClobOrderResult(
                order_id=_synthetic_order_id(self._client.get_address() or "?", token_id, "BUY", usdc_amount),
                status="dry_run",
            )
        try:
            args = MarketOrderArgs(token_id=token_id, amount=usdc_amount, side=BUY)
            signed = self._client.create_market_order(args)
            resp = self._client.post_order(signed, OrderType.FOK)
            return ClobOrderResult(order_id=str(resp.get("orderID") or resp.get("orderId") or ""), status="submitted", raw=resp)
        except Exception as e:  # noqa: BLE001
            log.warning("clob market_buy failed → dry-run: %s", e)
            return ClobOrderResult(
                order_id=_synthetic_order_id(self._client.get_address() or "?", token_id, "BUY", usdc_amount),
                status="dry_run",
            )

    def market_sell(self, token_id: str, share_amount: float) -> ClobOrderResult:
        """SHARE-denominated market sell."""
        if not self._creds_ok:
            return ClobOrderResult(
                order_id=_synthetic_order_id(self._client.get_address() or "?", token_id, "SELL", share_amount),
                status="dry_run",
            )
        try:
            args = MarketOrderArgs(token_id=token_id, amount=share_amount, side=SELL)
            signed = self._client.create_market_order(args)
            resp = self._client.post_order(signed, OrderType.FOK)
            return ClobOrderResult(order_id=str(resp.get("orderID") or resp.get("orderId") or ""), status="submitted", raw=resp)
        except Exception as e:  # noqa: BLE001
            log.warning("clob market_sell failed → dry-run: %s", e)
            return ClobOrderResult(
                order_id=_synthetic_order_id(self._client.get_address() or "?", token_id, "SELL", share_amount),
                status="dry_run",
            )

    def get_share_balance(self, token_id: str) -> float:
        abi = [{
            "type": "function",
            "name": "balanceOf",
            "stateMutability": "view",
            "inputs": [
                {"name": "account", "type": "address"},
                {"name": "id", "type": "uint256"},
            ],
            "outputs": [{"name": "", "type": "uint256"}],
        }]
        contract = self._w3.eth.contract(address=Web3.to_checksum_address(self._conditional), abi=abi)
        raw = int(contract.functions.balanceOf(
            Web3.to_checksum_address(self._client.get_address()),
            int(token_id),
        ).call())
        return float(Decimal(raw) / Decimal(10**6))

    def get_usdc_balance(self) -> float:
        if self._creds_ok:
            try:
                payload = self._client.get_balance_allowance(
                    BalanceAllowanceParams(asset_type=AssetType.COLLATERAL, signature_type=0)
                )
                balance = payload.get("balance") if isinstance(payload, dict) else None
                if balance is not None:
                    return float(balance)
            except Exception as e:  # noqa: BLE001
                log.warning("clob balance_allowance failed, falling back to onchain balance: %s", e)
        abi = [{
            "type": "function",
            "name": "balanceOf",
            "stateMutability": "view",
            "inputs": [{"name": "account", "type": "address"}],
            "outputs": [{"name": "", "type": "uint256"}],
        }]
        contract = self._w3.eth.contract(address=Web3.to_checksum_address(self._collateral), abi=abi)
        raw = int(contract.functions.balanceOf(
            Web3.to_checksum_address(self._client.get_address())
        ).call())
        return float(Decimal(raw) / Decimal(10**6))


def submit_for_burner(
    burner_private_key: str,
    token_id: str,
    side: str,
    amount: float,
) -> ClobOrderResult:
    """One-shot helper used by the API layer.

    `amount` semantics depend on `side`:
      * BUY  → USDC notional
      * SELL → token shares
    """
    host = os.environ.get("POLYMARKET_CLOB_HOST", DEFAULT_HOST)
    chain_id = int(os.environ.get("POLYMARKET_CHAIN_ID", str(POLYGON)))
    submitter = ClobSubmitter(burner_private_key=burner_private_key, host=host, chain_id=chain_id)
    side_norm = side.upper()
    if side_norm == "BUY":
        return submitter.market_buy(token_id=token_id, usdc_amount=float(amount))
    if side_norm == "SELL":
        return submitter.market_sell(token_id=token_id, share_amount=float(amount))
    raise ValueError(f"unknown side: {side}")


def close_for_burner(
    burner_private_key: str,
    token_id: str,
    share_amount: float | None = None,
) -> tuple[ClobOrderResult, BurnerBalanceSnapshot]:
    host = os.environ.get("POLYMARKET_CLOB_HOST", DEFAULT_HOST)
    chain_id = int(os.environ.get("POLYMARKET_CHAIN_ID", str(POLYGON)))
    submitter = ClobSubmitter(burner_private_key=burner_private_key, host=host, chain_id=chain_id)
    shares = float(share_amount) if share_amount is not None else submitter.get_share_balance(token_id)
    if shares <= 0:
        raise ValueError("burner has no shares to exit for this token")
    usdc_before = submitter.get_usdc_balance()
    result = submitter.market_sell(token_id=token_id, share_amount=shares)
    usdc_after = submitter.get_usdc_balance()
    exit_usdc = max(0.0, usdc_after - usdc_before)
    return result, BurnerBalanceSnapshot(
        shares=shares,
        usdc_before=usdc_before,
        usdc_after=usdc_after,
        exit_usdc=exit_usdc,
    )
