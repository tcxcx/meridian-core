"""Append-only SQLite audit log for the execution-router.

Every state-changing op (and every external-system effect: hook fundBurner,
KeeperHub call, Gateway deposit, Gateway bridge, CLOB submit, markResolved,
settle) writes one row here. The log is the human-readable proof-of-execution
trail behind the dashboard's per-position timeline and is what we'll attach
to the demo as "what actually happened on testnet."

Lives next to `positions.db` in `services/execution_router/var/`. Separate
file so the canonical position table stays small and so we can rotate /
export the audit trail independently.

Writes are wrapped at the call site in try/except so a corrupt or locked
audit DB never breaks /open or /resolve.
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any

_DEFAULT_DB_PATH = Path(__file__).parent / "var" / "audit.db"


class AuditLog:
    """Thread-safe append-only audit trail.

    Append: `log(event, position_id=..., status=..., payload=...)`.
    Read:   `recent(limit=200, position_id=None)`.
    """

    def __init__(self, db_path: str | os.PathLike | None = None) -> None:
        self._lock = threading.Lock()
        self._db_path = Path(db_path) if db_path else _DEFAULT_DB_PATH
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_db()

    def _connect(self) -> sqlite3.Connection:
        # check_same_thread=False is safe because every write goes through self._lock.
        conn = sqlite3.connect(self._db_path, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def _init_db(self) -> None:
        with self._connect() as conn:
            conn.execute(
                "CREATE TABLE IF NOT EXISTS audit_events ("
                "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "  ts REAL NOT NULL,"
                "  position_id TEXT,"
                "  event TEXT NOT NULL,"
                "  status TEXT,"
                "  payload TEXT NOT NULL"
                ")"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS audit_position "
                "ON audit_events (position_id, ts)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS audit_event "
                "ON audit_events (event, ts)"
            )

    def log(
        self,
        event: str,
        *,
        position_id: str | None = None,
        status: str = "ok",
        payload: dict[str, Any] | None = None,
    ) -> int:
        ts = time.time()
        redacted = _redact(payload or {})
        body = json.dumps(redacted, default=str)
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "INSERT INTO audit_events (ts, position_id, event, status, payload) "
                "VALUES (?, ?, ?, ?, ?)",
                (ts, position_id, event, status, body),
            )
            row_id = int(cur.lastrowid or 0)
        # Mirror to Neon. Best-effort — operator-terminal reads from DB on
        # boot, SSE/SQLite remain canonical for live in-flight updates.
        try:
            from services._shared import db as _db
            _db.write_audit(
                event=event, position_id=position_id, status=status,
                payload=redacted, ts=ts,
            )
        except Exception:  # noqa: BLE001
            pass
        return row_id

    def recent(
        self,
        limit: int = 200,
        position_id: str | None = None,
    ) -> list[dict]:
        limit = max(1, min(int(limit), 1000))
        with self._lock, self._connect() as conn:
            if position_id:
                rows = conn.execute(
                    "SELECT id, ts, position_id, event, status, payload "
                    "FROM audit_events WHERE position_id=? "
                    "ORDER BY id DESC LIMIT ?",
                    (position_id, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT id, ts, position_id, event, status, payload "
                    "FROM audit_events ORDER BY id DESC LIMIT ?",
                    (limit,),
                ).fetchall()
        return [_row_to_dict(r) for r in rows]


# Field substrings that must never reach the audit DB. We log testnet-only
# secrets-shouldn't-exist anyway, but defense in depth: redact at the boundary.
_SECRET_KEYS = ("private_key", "privateKey", "seed", "mnemonic", "api_key", "apiKey")


def _redact(payload: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in payload.items():
        if any(s in k for s in _SECRET_KEYS):
            out[k] = "<redacted>"
        elif isinstance(v, dict):
            out[k] = _redact(v)
        else:
            out[k] = v
    return out


def _row_to_dict(row: tuple) -> dict:
    rid, ts, pid, event, status, payload = row
    try:
        body = json.loads(payload)
    except (json.JSONDecodeError, TypeError):
        body = {"_raw": payload}
    return {
        "id": rid,
        "ts": ts,
        "position_id": pid,
        "event": event,
        "status": status,
        "payload": body,
    }


def from_env(db_path: str | os.PathLike | None = None) -> AuditLog:
    return AuditLog(db_path=db_path or os.environ.get("AUDIT_DB_PATH"))
