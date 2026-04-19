"""PrivateSettlementHook client.

Three operations:
  * `fund_burner(positionId, burner, encrypted_amount)`
  * `mark_resolved(positionId, encrypted_payout)`
  * `settle(positionId)`

Submission goes through KeeperHub when a `KeeperHubClient` is provided
(production path — managed gas/retries/auditable executionId). Otherwise
falls back to direct web3.eth.send_raw_transaction signed by the treasury
EOA (dev / dry-run).

ABI is hand-rolled rather than reading from `forge build` artifacts to
avoid coupling the Python service to the Foundry project layout. The
function fragments must stay in sync with `PrivateSettlementHook.sol`.
"""
from __future__ import annotations

import logging
import os
from dataclasses import dataclass

from eth_account import Account
from web3 import Web3

from .encryptor import Encryptor, SealedInput
from .keeperhub import ExecutionResult, KeeperHubClient

log = logging.getLogger("meridian.execution.hook")

# Minimal ABI fragment. Keep field order in InEuint128 tuple identical to
# the Solidity struct: (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature).
HOOK_ABI = [
    {
        "type": "function",
        "name": "fundBurner",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "burner", "type": "address"},
            {"name": "positionId", "type": "bytes32"},
            {
                "name": "amount",
                "type": "tuple",
                "components": [
                    {"name": "ctHash", "type": "uint256"},
                    {"name": "securityZone", "type": "uint8"},
                    {"name": "utype", "type": "uint8"},
                    {"name": "signature", "type": "bytes"},
                ],
            },
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "markResolved",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "positionId", "type": "bytes32"},
            {
                "name": "payout",
                "type": "tuple",
                "components": [
                    {"name": "ctHash", "type": "uint256"},
                    {"name": "securityZone", "type": "uint8"},
                    {"name": "utype", "type": "uint8"},
                    {"name": "signature", "type": "bytes"},
                ],
            },
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "settle",
        "stateMutability": "nonpayable",
        "inputs": [{"name": "positionId", "type": "bytes32"}],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "positionBurner",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "positionResolved",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "positionSettled",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "bool"}],
    },
]


@dataclass(frozen=True)
class HookTxResult:
    tx_hash: str
    execution_id: str | None  # populated when KeeperHub-wrapped


def _position_id_to_bytes32(position_id: str) -> bytes:
    """Match the on-chain bytes32 layout: keccak256(utf8(positionId))."""
    return Web3.keccak(text=position_id)


class HookClient:
    def __init__(
        self,
        web3: Web3,
        hook_address: str,
        treasury_private_key: str | None,
        encryptor: Encryptor,
        keeperhub: KeeperHubClient | None = None,
    ) -> None:
        self._w3 = web3
        self._hook_address = Web3.to_checksum_address(hook_address)
        self._contract = web3.eth.contract(address=self._hook_address, abi=HOOK_ABI)
        self._encryptor = encryptor
        self._keeperhub = keeperhub
        self._treasury_account = Account.from_key(treasury_private_key) if treasury_private_key else None

    @property
    def treasury_address(self) -> str | None:
        return self._treasury_account.address if self._treasury_account else None

    # --------------------- Encrypted entrypoints ---------------------

    def fund_burner(self, position_id: str, burner_address: str, amount_uint128: int) -> HookTxResult:
        sender = self.treasury_address or burner_address
        sealed = self._encryptor.encrypt_uint128(amount_uint128, sender=sender)
        burner = Web3.to_checksum_address(burner_address)
        pid = _position_id_to_bytes32(position_id)
        return self._submit("fundBurner", [burner, pid, sealed])

    def fund_burner_with_sealed(self, position_id: str, burner_address: str, sealed: SealedInput) -> HookTxResult:
        """Skip re-encryption — caller already has an `InEuint128`.

        Used by Bucket 4: orchestrator pre-encrypts the size so the cleartext
        notional never crosses localhost from orchestrator → execution-router.
        Field order in `sealed` MUST match the on-chain InEuint128 struct.
        """
        burner = Web3.to_checksum_address(burner_address)
        pid = _position_id_to_bytes32(position_id)
        return self._submit("fundBurner", [burner, pid, sealed])

    def mark_resolved(self, position_id: str, payout_uint128: int) -> HookTxResult:
        sender = self.treasury_address or self._hook_address
        sealed = self._encryptor.encrypt_uint128(payout_uint128, sender=sender)
        pid = _position_id_to_bytes32(position_id)
        return self._submit("markResolved", [pid, sealed])

    def settle(self, position_id: str) -> HookTxResult:
        pid = _position_id_to_bytes32(position_id)
        return self._submit("settle", [pid])

    # --------------------- View helpers ---------------------

    def get_burner(self, position_id: str) -> str:
        pid = _position_id_to_bytes32(position_id)
        return self._contract.functions.positionBurner(pid).call()

    def is_resolved(self, position_id: str) -> bool:
        pid = _position_id_to_bytes32(position_id)
        return self._contract.functions.positionResolved(pid).call()

    def is_settled(self, position_id: str) -> bool:
        pid = _position_id_to_bytes32(position_id)
        return self._contract.functions.positionSettled(pid).call()

    # --------------------- Submission ---------------------

    def _submit(self, function_name: str, args: list) -> HookTxResult:
        if self._keeperhub is not None:
            return self._submit_via_keeperhub(function_name, args)
        return self._submit_direct(function_name, args)

    def _submit_via_keeperhub(self, function_name: str, args: list) -> HookTxResult:
        # KeeperHub wants the args as JSON-serializable values. SealedInput becomes its tuple.
        json_args = [self._jsonify(a) for a in args]
        result: ExecutionResult = self._keeperhub.contract_call(  # type: ignore[union-attr]
            contract_address=self._hook_address,
            function_name=function_name,
            function_args=json_args,
            abi=HOOK_ABI,
        )
        log.info("keeperhub.%s execution=%s status=%s tx=%s", function_name, result.execution_id, result.status, result.tx_hash)
        return HookTxResult(tx_hash=result.tx_hash or "", execution_id=result.execution_id)

    def _submit_direct(self, function_name: str, args: list) -> HookTxResult:
        if self._treasury_account is None:
            raise RuntimeError("direct submission requires TREASURY_PRIVATE_KEY")
        fn = self._contract.get_function_by_name(function_name)(*args)
        tx = fn.build_transaction(
            {
                "from": self._treasury_account.address,
                "nonce": self._w3.eth.get_transaction_count(self._treasury_account.address),
                "chainId": self._w3.eth.chain_id,
            }
        )
        signed = self._treasury_account.sign_transaction(tx)
        # web3.py v7 exposes the signed bytes as `raw_transaction`; older v6 used `rawTransaction`.
        raw_tx = getattr(signed, "raw_transaction", None) or signed.rawTransaction
        tx_hash = self._w3.eth.send_raw_transaction(raw_tx)
        log.info("direct.%s tx=%s", function_name, tx_hash.hex())
        return HookTxResult(tx_hash=tx_hash.hex(), execution_id=None)

    @staticmethod
    def _jsonify(arg):
        if isinstance(arg, SealedInput):
            return [
                str(arg.ct_hash),  # uint256 → string for JSON safety
                arg.security_zone,
                arg.utype,
                "0x" + arg.signature.hex(),
            ]
        if isinstance(arg, (bytes, bytearray)):
            return "0x" + bytes(arg).hex()
        return arg


def from_env(encryptor: Encryptor, keeperhub: KeeperHubClient | None) -> HookClient | None:
    # Settlement chain migrated from Base Sepolia → Arbitrum Sepolia to land on
    # a Fhenix CoFHE-supported testnet. Both env names are honored for now so
    # older .env files don't silently regress to offline mode.
    rpc = (
        os.environ.get("ARB_SEPOLIA_RPC_URL")
        or os.environ.get("ARBITRUM_SEPOLIA_RPC_URL")
        or os.environ.get("BASE_SEPOLIA_RPC_URL")
        or os.environ.get("RPC_URL")
    )
    hook_addr = os.environ.get("MERIDIAN_HOOK_ADDRESS")
    if not rpc or not hook_addr:
        return None
    w3 = Web3(Web3.HTTPProvider(rpc))
    return HookClient(
        web3=w3,
        hook_address=hook_addr,
        treasury_private_key=os.environ.get("TREASURY_PRIVATE_KEY"),
        encryptor=encryptor,
        keeperhub=keeperhub,
    )
