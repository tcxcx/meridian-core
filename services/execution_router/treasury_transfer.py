"""Treasury → trading-wallet transfers with multisig coordination.

The vault holds reserve capital. Moving USDC from vault → trading wallet (the
"agent wallet" in UI vocabulary) is the only mutating action the multisig
gates: outbound funding for the autonomous trader.

This module owns the coordination state (pending transfers, signatures
collected, threshold) and triggers the on-chain transfer once the threshold
is reached. The signing itself happens client-side per signer — clients post
the signature blob; the backend tracks who has signed.

Storage is in-memory + JSONL append for crash-recovery. No DB.

Env contract:
  MIROSHARK_MULTISIG_THRESHOLD   default "1" (no multisig — for solo demo)
  MIROSHARK_MULTISIG_COSIGNERS   comma-separated addresses; treasury signer
                                 always counts as one regardless of this list
  MIROSHARK_MULTISIG_PRIMARY     primary signer address (defaults to derived
                                 from TREASURY_PRIVATE_KEY)
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid
from dataclasses import dataclass, asdict, field
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)


@dataclass
class TransferSigner:
    address: str
    label: str = ""
    signed: bool = False
    signed_at: Optional[float] = None


@dataclass
class TreasuryTransfer:
    transfer_id: str
    from_label: str           # "treasury"
    to_label: str             # "agent" / tenant-id
    tenant_id: str
    amount_usdc: float
    chain: str                # funding_mode chain
    threshold: int
    signers: list[TransferSigner]
    initiator: str            # address that initiated
    created_at: float
    status: str = "pending"   # pending | executing | executed | failed | cancelled
    tx_hash: Optional[str] = None
    error: Optional[str] = None
    notified: bool = False    # telegram channel notified?

    def signatures_received(self) -> int:
        return sum(1 for s in self.signers if s.signed)

    def threshold_met(self) -> bool:
        return self.signatures_received() >= self.threshold

    def to_dict(self) -> dict:
        d = asdict(self)
        d["signatures_received"] = self.signatures_received()
        d["threshold_met"] = self.threshold_met()
        return d


class TreasuryTransferStore:
    def __init__(self, *, journal_path: Optional[Path] = None) -> None:
        self._lock = threading.Lock()
        self._transfers: dict[str, TreasuryTransfer] = {}
        self._journal = journal_path
        if self._journal:
            self._journal.parent.mkdir(parents=True, exist_ok=True)
            self._replay()

    def _replay(self) -> None:
        if not self._journal or not self._journal.exists():
            return
        try:
            for line in self._journal.read_text().splitlines():
                if not line.strip():
                    continue
                payload = json.loads(line)
                tid = payload.get("transfer_id")
                if not tid:
                    continue
                signers = [TransferSigner(**s) for s in payload.get("signers", [])]
                payload["signers"] = signers
                # asdict-friendly fields only
                allowed = {f for f in TreasuryTransfer.__dataclass_fields__}
                payload = {k: v for k, v in payload.items() if k in allowed}
                self._transfers[tid] = TreasuryTransfer(**payload)
        except Exception as e:  # noqa: BLE001
            log.warning("treasury_transfer journal replay failed: %s", e)

    def _persist(self, transfer: TreasuryTransfer) -> None:
        if not self._journal:
            return
        try:
            with self._journal.open("a") as fp:
                fp.write(json.dumps(transfer.to_dict()) + "\n")
        except Exception as e:  # noqa: BLE001
            log.warning("treasury_transfer persist failed: %s", e)

    def init(
        self,
        *,
        amount_usdc: float,
        tenant_id: str,
        chain: str,
        threshold: int,
        signers: list[TransferSigner],
        initiator: str,
    ) -> TreasuryTransfer:
        transfer = TreasuryTransfer(
            transfer_id=f"tx-{uuid.uuid4().hex[:12]}",
            from_label="treasury",
            to_label="agent",
            tenant_id=tenant_id,
            amount_usdc=amount_usdc,
            chain=chain,
            threshold=threshold,
            signers=signers,
            initiator=initiator,
            created_at=time.time(),
        )
        with self._lock:
            self._transfers[transfer.transfer_id] = transfer
        self._persist(transfer)
        self._mirror_to_db(transfer)
        return transfer

    def get(self, transfer_id: str) -> Optional[TreasuryTransfer]:
        with self._lock:
            return self._transfers.get(transfer_id)

    def pending(self, *, signer_address: Optional[str] = None) -> list[TreasuryTransfer]:
        with self._lock:
            items = [t for t in self._transfers.values() if t.status == "pending"]
        if signer_address:
            sa = signer_address.lower()
            items = [
                t for t in items
                if any(s.address.lower() == sa and not s.signed for s in t.signers)
            ]
        return sorted(items, key=lambda t: t.created_at, reverse=True)

    def add_signature(self, transfer_id: str, *, signer_address: str) -> Optional[TreasuryTransfer]:
        sa = signer_address.lower()
        with self._lock:
            t = self._transfers.get(transfer_id)
            if t is None or t.status != "pending":
                return t
            for s in t.signers:
                if s.address.lower() == sa and not s.signed:
                    s.signed = True
                    s.signed_at = time.time()
                    break
            else:
                return t  # signer not in list or already signed — no change
        self._persist(t)
        self._mirror_to_db(t)
        return t

    def mark_executed(self, transfer_id: str, *, tx_hash: str) -> None:
        with self._lock:
            t = self._transfers.get(transfer_id)
            if t is None:
                return
            t.status = "executed"
            t.tx_hash = tx_hash
        self._persist(t)
        self._mirror_to_db(t)

    def mark_failed(self, transfer_id: str, *, error: str) -> None:
        with self._lock:
            t = self._transfers.get(transfer_id)
            if t is None:
                return
            t.status = "failed"
            t.error = error
        self._persist(t)
        self._mirror_to_db(t)

    def mark_notified(self, transfer_id: str) -> None:
        with self._lock:
            t = self._transfers.get(transfer_id)
            if t is None:
                return
            t.notified = True
        self._mirror_to_db(t)

    def _mirror_to_db(self, transfer: TreasuryTransfer) -> None:
        """Best-effort DB write so the operator-terminal sees pending transfers
        on boot/refresh. Failures are swallowed inside the writer."""
        try:
            from services._shared import db as _db
            _db.write_treasury_transfer(transfer)
        except Exception:  # noqa: BLE001
            pass


def build_signer_set(*, primary_address: str, primary_label: str = "you · passkey") -> list[TransferSigner]:
    """Resolve the multisig signer set from env. Always includes the primary."""
    raw_cosigners = os.environ.get("MIROSHARK_MULTISIG_COSIGNERS", "").strip()
    cosigners = [c.strip() for c in raw_cosigners.split(",") if c.strip()] if raw_cosigners else []
    signers: list[TransferSigner] = [
        TransferSigner(address=primary_address, label=primary_label),
    ]
    for i, c in enumerate(cosigners):
        signers.append(TransferSigner(address=c, label=f"cosigner {i + 1}"))
    return signers


def resolve_threshold(default: int = 1) -> int:
    raw = os.environ.get("MIROSHARK_MULTISIG_THRESHOLD", str(default)).strip()
    try:
        n = int(raw)
        return max(1, n)
    except ValueError:
        return default


def from_env() -> TreasuryTransferStore:
    """Build a store with on-disk JSONL journal under MIROSHARK_DATA_DIR."""
    data_dir = os.environ.get("MIROSHARK_DATA_DIR", "").strip()
    if data_dir:
        journal = Path(data_dir) / "treasury-transfers.jsonl"
    else:
        journal = None
    return TreasuryTransferStore(journal_path=journal)
