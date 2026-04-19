"""Position state store with SQLite write-through.

Holds the canonical view of MERIDIAN positions while in flight. Persistent
state lives on-chain in `PrivateSettlementHook`; this store mirrors the
off-chain side of each position — burner address, Polymarket order id,
audit trail of tx hashes — so operators (and the dashboard) can see them
without re-querying every dependency, and so a router restart hydrates
prior state instead of resuming blind.

Persistence uses a single JSON column per row. Adding new fields to
`PositionRecord` therefore requires no schema migration.
"""
from __future__ import annotations

import json
import os
import queue
import sqlite3
import threading
import time
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Literal

PositionStatus = Literal["funding", "open", "resolving", "settled", "failed"]


@dataclass
class PositionRecord:
    position_id: str
    market_id: str
    token_id: str
    side: Literal["BUY", "SELL"]
    usdc_amount: float
    burner_address: str
    status: PositionStatus = "funding"
    fund_tx: str | None = None
    clob_order_id: str | None = None
    resolve_tx: str | None = None
    settle_tx: str | None = None
    payout_usdc: float | None = None
    error: str | None = None
    keeperhub_executions: list[str] = field(default_factory=list)
    # Circle Gateway — Arb Sepolia (domain 3) ↔ Polygon Amoy (domain 7).
    # `_burn_tx` holds the Gateway transferId; `_mint_tx` holds the forwarder
    # destination tx hash (forwardTxHash). Names kept for backwards compat with
    # the prior Bridge Kit / CCTP V2 schema and the dashboard column layout.
    bridge_send_burn_tx: str | None = None   # Arb Sepolia → Polygon Amoy on /open
    bridge_send_mint_tx: str | None = None
    bridge_recv_burn_tx: str | None = None   # Polygon Amoy → Arb Sepolia on /resolve
    bridge_recv_mint_tx: str | None = None
    # Burner-side deposit into Polygon Amoy GatewayWallet on /resolve.
    # Treasury's deposit on Arb Sepolia is one-time setup, not per-position.
    gateway_deposit_approve_tx: str | None = None
    gateway_deposit_tx: str | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    def touch(self) -> None:
        self.updated_at = time.time()

    def to_json(self) -> dict:
        return {
            "position_id": self.position_id,
            "market_id": self.market_id,
            "token_id": self.token_id,
            "side": self.side,
            "usdc_amount": self.usdc_amount,
            "burner_address": self.burner_address,
            "status": self.status,
            "fund_tx": self.fund_tx,
            "clob_order_id": self.clob_order_id,
            "resolve_tx": self.resolve_tx,
            "settle_tx": self.settle_tx,
            "payout_usdc": self.payout_usdc,
            "error": self.error,
            "keeperhub_executions": list(self.keeperhub_executions),
            "bridge_send_burn_tx": self.bridge_send_burn_tx,
            "bridge_send_mint_tx": self.bridge_send_mint_tx,
            "bridge_recv_burn_tx": self.bridge_recv_burn_tx,
            "bridge_recv_mint_tx": self.bridge_recv_mint_tx,
            "gateway_deposit_approve_tx": self.gateway_deposit_approve_tx,
            "gateway_deposit_tx": self.gateway_deposit_tx,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_json(cls, data: dict) -> "PositionRecord":
        # Tolerate missing keys (older rows) by passing only known fields.
        known = {f.name for f in fields(cls)}
        kwargs = {k: v for k, v in data.items() if k in known}
        kwargs.setdefault("keeperhub_executions", [])
        return cls(**kwargs)


_DEFAULT_DB_PATH = Path(__file__).parent / "var" / "positions.db"


class PositionStore:
    """Write-through SQLite store with an in-memory cache mirror.

    The cache makes `get`/`list` cheap (operators poll the dashboard); the
    SQLite layer makes restarts safe. Every `upsert` writes both.
    """

    def __init__(self, db_path: str | os.PathLike | None = None) -> None:
        self._lock = threading.Lock()
        self._positions: dict[str, PositionRecord] = {}
        self._db_path = Path(db_path) if db_path else _DEFAULT_DB_PATH
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        # SSE fan-out. Each subscriber owns a bounded queue; we drop oldest
        # rather than block writes if a subscriber falls behind.
        self._sub_lock = threading.Lock()
        self._subscribers: set[queue.Queue] = set()
        self._init_db()
        self._hydrate()

    def _connect(self) -> sqlite3.Connection:
        # check_same_thread=False is safe: we serialise via self._lock.
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS positions ("
                "  position_id TEXT PRIMARY KEY,"
                "  data TEXT NOT NULL,"
                "  updated_at REAL NOT NULL"
                ")"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS positions_updated_at "
                "ON positions (updated_at DESC)"
            )

    def _hydrate(self) -> None:
        with self._connect() as conn:
            rows = conn.execute("SELECT position_id, data FROM positions").fetchall()
        with self._lock:
            for pid, data in rows:
                try:
                    self._positions[pid] = PositionRecord.from_json(json.loads(data))
                except (json.JSONDecodeError, TypeError, ValueError):
                    # Corrupt row — skip rather than crash boot.
                    continue

    def get(self, position_id: str) -> PositionRecord | None:
        with self._lock:
            return self._positions.get(position_id)

    def upsert(self, record: PositionRecord) -> None:
        with self._lock:
            record.touch()
            self._positions[record.position_id] = record
            snapshot = record.to_json()
            payload = json.dumps(snapshot)
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO positions (position_id, data, updated_at) "
                    "VALUES (?, ?, ?) "
                    "ON CONFLICT(position_id) DO UPDATE SET "
                    "  data=excluded.data, updated_at=excluded.updated_at",
                    (record.position_id, payload, record.updated_at),
                )
        # Publish AFTER releasing the main lock so a slow subscriber can never
        # stall an upsert; queues are bounded — full ones drop oldest.
        self._publish(snapshot)

    def list(self) -> list[PositionRecord]:
        with self._lock:
            return list(self._positions.values())

    def subscribe(self, maxsize: int = 256) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=maxsize)
        with self._sub_lock:
            self._subscribers.add(q)
        return q

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._sub_lock:
            self._subscribers.discard(q)

    def _publish(self, snapshot: dict) -> None:
        with self._sub_lock:
            subs = list(self._subscribers)
        for q in subs:
            try:
                q.put_nowait(snapshot)
            except queue.Full:
                # Drop oldest, then enqueue. Lossy on the consumer side is
                # better than blocking the producer and stalling a request.
                try:
                    q.get_nowait()
                except queue.Empty:
                    pass
                try:
                    q.put_nowait(snapshot)
                except queue.Full:
                    pass
