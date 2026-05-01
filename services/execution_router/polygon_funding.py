from __future__ import annotations

import os
from dataclasses import dataclass
from decimal import Decimal

from eth_account import Account
from web3 import Web3
from web3.middleware.proof_of_authority import ExtraDataToPOAMiddleware

POLYGON_AMOY_USDC = Web3.to_checksum_address("0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582")
POLYGON_AMOY_PUBLIC_RPC = "https://rpc-amoy.polygon.technology"
ERC20_ABI = [
    {
        "type": "function",
        "name": "balanceOf",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "decimals",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint8"}],
    },
    {
        "type": "function",
        "name": "transfer",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "to", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


@dataclass(frozen=True)
class PolygonTransferResult:
    tx_hash: str
    recipient: str
    amount_usdc: float


class PolygonFundingClient:
    def __init__(self, rpc_url: str, private_key: str, token_address: str = str(POLYGON_AMOY_USDC)) -> None:
        self._w3 = Web3(Web3.HTTPProvider(rpc_url))
        self._w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self._account = Account.from_key(private_key)
        self._token = self._w3.eth.contract(address=Web3.to_checksum_address(token_address), abi=ERC20_ABI)
        self._decimals = 6

    @property
    def address(self) -> str:
        return self._account.address

    def balance_usdc(self, address: str | None = None) -> float:
        holder = Web3.to_checksum_address(address or self._account.address)
        raw = int(self._token.functions.balanceOf(holder).call())
        return float(Decimal(raw) / (Decimal(10) ** self._decimals))

    def native_balance(self, address: str | None = None) -> float:
        holder = Web3.to_checksum_address(address or self._account.address)
        raw = int(self._w3.eth.get_balance(holder))
        return float(Decimal(raw) / (Decimal(10) ** 18))

    def transfer_usdc(self, recipient: str, amount_usdc: float) -> PolygonTransferResult:
        recipient_ck = Web3.to_checksum_address(recipient)
        value = int((Decimal(str(amount_usdc)) * (Decimal(10) ** self._decimals)).to_integral_value())
        nonce = self._w3.eth.get_transaction_count(self._account.address)
        tx = self._token.functions.transfer(recipient_ck, value).build_transaction(
            {
                "from": self._account.address,
                "nonce": nonce,
                "chainId": self._w3.eth.chain_id,
            }
        )
        signed = self._account.sign_transaction(tx)
        raw_tx = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = self._w3.eth.send_raw_transaction(raw_tx)
        return PolygonTransferResult(
            tx_hash=tx_hash.hex(),
            recipient=recipient_ck,
            amount_usdc=amount_usdc,
        )


def funding_mode() -> str:
    if os.environ.get("MIROSHARK_TREASURY_WALLET_ADDRESS") or os.environ.get("TREASURY_ADDRESS"):
        return "polygon-modular"
    if os.environ.get("TREASURY_VIEM_ADDRESS") or os.environ.get("TREASURY_PRIVATE_KEY"):
        return "polygon-direct"
    if os.environ.get("CIRCLE_TREASURY_ADDRESS"):
        return "legacy-circle"
    return "unconfigured"


def from_env() -> PolygonFundingClient | None:
    rpc_candidates = [
        os.environ.get("POLYGON_AMOY_RPC_URL"),
        os.environ.get("POLYGON_RPC_URL"),
        POLYGON_AMOY_PUBLIC_RPC,
    ]
    private_key = os.environ.get("TREASURY_PRIVATE_KEY")
    if not private_key:
        return None
    for rpc in rpc_candidates:
        if not rpc:
            continue
        try:
            client = PolygonFundingClient(rpc_url=rpc, private_key=private_key)
            _ = client._w3.eth.chain_id
            _ = client.native_balance()
            _ = client.balance_usdc()
            return client
        except Exception:
            continue
    return None
