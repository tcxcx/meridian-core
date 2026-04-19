"""Daily verifiable PnL attestation pack — Bucket 5 of autonomous-fund-arb.

Walks the AuditLog for `attestation.pinned` events within a UTC date window,
joins each pinned position to its current `PositionStore` row, computes
per-position and aggregate PnL (`payout_usdc - usdc_amount`), and emits a
single envelope shaped as `meridian/daily-pack/v1`. The envelope is then
optionally pinned to 0G Storage via the same cogito `/upload` path used for
per-position attestations; the returned root_hash is what the public
`/verifier/<date>` page hands to anyone who wants to recompute the pack
themselves.

The pack is deterministic given a fixed audit + store snapshot: `positions`
is sorted by `updated_at` ascending, JSON keys are written in a stable
order. The local cache in `var/daily_packs/<date>.json` is the same bytes
that get pinned to 0G, so byte-equality verification works without
re-serialising.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from .attestation import CogitoAttestationClient, PinResult
from .audit import AuditLog
from .store import PositionRecord, PositionStore

log = logging.getLogger("meridian.execution.daily_pack")

SCHEMA = "meridian/daily-pack/v1"
_DEFAULT_PACK_DIR = Path(__file__).parent / "var" / "daily_packs"


@dataclass(frozen=True)
class BuildResult:
    pack: dict[str, Any]
    written_path: Path | None
    pinned: PinResult | None


def _date_window_utc(date_str: str) -> tuple[float, float]:
    """Convert YYYY-MM-DD to [start_ts, end_ts) in seconds since epoch (UTC)."""
    d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return d.timestamp(), (d + timedelta(days=1)).timestamp()


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _position_entry(rec: PositionRecord, root_hash: str | None) -> dict[str, Any]:
    payout = float(rec.payout_usdc) if rec.payout_usdc is not None else 0.0
    usdc = float(rec.usdc_amount or 0.0)
    pnl = round(payout - usdc, 6)
    return {
        "position_id": rec.position_id,
        "strategy": rec.strategy,
        "market_id": rec.market_id,
        "token_id": rec.token_id,
        "side": rec.side,
        "burner_address": rec.burner_address,
        "usdc_amount": usdc,
        "payout_usdc": payout,
        "pnl_usdc": pnl,
        "fund_tx": rec.fund_tx,
        "resolve_tx": rec.resolve_tx,
        "settle_tx": rec.settle_tx,
        "bridge_send_burn_tx": rec.bridge_send_burn_tx,
        "bridge_recv_burn_tx": rec.bridge_recv_burn_tx,
        "gateway_deposit_tx": rec.gateway_deposit_tx,
        "clob_order_id": rec.clob_order_id,
        "attestation_root_hash": root_hash,
        "created_at": rec.created_at,
        "updated_at": rec.updated_at,
    }


def _aggregate(entries: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(entries)
    gross = round(sum(e["pnl_usdc"] for e in entries), 6)
    volume = round(sum(e["usdc_amount"] for e in entries), 6)
    winners = sum(1 for e in entries if e["pnl_usdc"] > 0)
    losers = sum(1 for e in entries if e["pnl_usdc"] < 0)
    flat = n - winners - losers

    by_strategy: dict[str, dict[str, float]] = {}
    for e in entries:
        s = by_strategy.setdefault(e["strategy"], {
            "n_positions": 0, "gross_pnl_usdc": 0.0, "total_volume_usdc": 0.0,
        })
        s["n_positions"] += 1
        s["gross_pnl_usdc"] = round(s["gross_pnl_usdc"] + e["pnl_usdc"], 6)
        s["total_volume_usdc"] = round(s["total_volume_usdc"] + e["usdc_amount"], 6)

    return {
        "n_positions": n,
        "n_winners": winners,
        "n_losers": losers,
        "n_flat": flat,
        "gross_pnl_usdc": gross,
        "total_volume_usdc": volume,
        "win_rate": round(winners / n, 4) if n > 0 else 0.0,
        "by_strategy": by_strategy,
    }


class DailyPackBuilder:
    """Build, cache, and pin daily attestation packs.

    Stateless across calls — `build(date)` walks the AuditLog every time, so
    a re-built pack with the same inputs is byte-identical (the schema is
    sorted + serialised with `sort_keys=True, separators=(",",":")`).
    """

    def __init__(
        self,
        *,
        store: PositionStore,
        audit: AuditLog,
        attestation: CogitoAttestationClient | None = None,
        pack_dir: str | os.PathLike | None = None,
        audit_scan_limit: int = 1000,
    ) -> None:
        self._store = store
        self._audit = audit
        self._attestation = attestation
        self._pack_dir = Path(pack_dir) if pack_dir else _DEFAULT_PACK_DIR
        self._pack_dir.mkdir(parents=True, exist_ok=True)
        self._audit_scan_limit = int(audit_scan_limit)
        self._lock = threading.Lock()

    # ----- public API -----

    def build(self, date: str | None = None) -> dict[str, Any]:
        """Compute the pack envelope for the given UTC date (default: today)."""
        date = date or _today_utc()
        start_ts, end_ts = _date_window_utc(date)
        rh_by_pid = self._index_pins_in_window(start_ts, end_ts)

        entries: list[dict[str, Any]] = []
        for rec in self._store.list():
            if rec.status != "settled":
                continue
            if not (start_ts <= rec.updated_at < end_ts):
                continue
            entries.append(_position_entry(rec, rh_by_pid.get(rec.position_id)))

        entries.sort(key=lambda e: (e["updated_at"], e["position_id"]))

        return {
            "schema": SCHEMA,
            "date": date,
            "generated_at": time.time(),
            "positions": entries,
            "aggregate": _aggregate(entries),
        }

    def write_local(self, pack: dict[str, Any]) -> Path:
        """Persist the pack JSON to `var/daily_packs/<date>.json`."""
        date = pack["date"]
        path = self._pack_dir / f"{date}.json"
        body = self._serialise(pack)
        with self._lock:
            tmp = path.with_suffix(".json.tmp")
            tmp.write_bytes(body)
            tmp.replace(path)
        return path

    def load_local(self, date: str) -> dict[str, Any] | None:
        path = self._pack_dir / f"{date}.json"
        if not path.exists():
            return None
        try:
            return json.loads(path.read_bytes())
        except (json.JSONDecodeError, OSError) as e:
            log.warning("daily pack %s unreadable: %s", date, e)
            return None

    def pin(self, pack: dict[str, Any]) -> PinResult | None:
        """Pin the pack to 0G via cogito. Returns None if attestation disabled."""
        if self._attestation is None:
            return None
        meta = {
            "kind": "daily_pack",
            "date": pack["date"],
            "n_positions": pack["aggregate"]["n_positions"],
        }
        return self._attestation.pin(pack, meta=meta)

    def build_and_pin(self, date: str | None = None) -> BuildResult:
        """Build + write local + pin (best-effort) + return the result."""
        pack = self.build(date)
        path = self.write_local(pack)
        pinned: PinResult | None = None
        try:
            pinned = self.pin(pack)
        except Exception as e:  # noqa: BLE001
            log.warning("daily pack %s pin failed: %s", pack["date"], e)
        return BuildResult(pack=pack, written_path=path, pinned=pinned)

    def latest_pin_for(self, date: str) -> dict[str, Any] | None:
        """Look up the most recent `daily_pack.pinned` audit event for date."""
        try:
            events = self._audit.recent(limit=self._audit_scan_limit)
        except Exception as e:  # noqa: BLE001
            log.warning("audit.recent failed: %s", e)
            return None
        for e in events:
            if e.get("event") != "daily_pack.pinned":
                continue
            payload = e.get("payload") or {}
            if payload.get("date") == date:
                return {
                    "root_hash": payload.get("root_hash"),
                    "tx_hash": payload.get("tx_hash"),
                    "size_bytes": payload.get("size_bytes"),
                    "ts": e.get("ts"),
                }
        return None

    # ----- internals -----

    def _index_pins_in_window(self, start_ts: float, end_ts: float) -> dict[str, str]:
        """Return {position_id: root_hash} for `attestation.pinned` events in [start, end)."""
        try:
            events = self._audit.recent(limit=self._audit_scan_limit)
        except Exception as e:  # noqa: BLE001
            log.warning("audit.recent failed: %s", e)
            return {}
        out: dict[str, str] = {}
        # Walk newest→oldest; first hit per position_id wins (most recent pin).
        for e in events:
            if e.get("event") != "attestation.pinned":
                continue
            ts = float(e.get("ts") or 0.0)
            if not (start_ts <= ts < end_ts):
                continue
            pid = e.get("position_id")
            rh = (e.get("payload") or {}).get("root_hash")
            if pid and rh and pid not in out:
                out[pid] = str(rh)
        return out

    @staticmethod
    def _serialise(pack: dict[str, Any]) -> bytes:
        # Stable key order so the bytes we cache match the bytes we pin.
        return json.dumps(pack, sort_keys=True, separators=(",", ":")).encode("utf-8")
