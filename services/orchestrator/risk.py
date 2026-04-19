"""24/7 Risk Engine — sticky halts, drawdown stop, cluster cap, heartbeat watchdog.

Layers on top of the Allocator. The Allocator owns capital math (per-strategy
caps + global notional + per-position max + max-open-count). The Risk Engine
owns *halts*: conditions under which we refuse to open ANY new position
regardless of the Allocator's view.

Halts are sticky: once tripped they persist to disk so a restart honours them.
The operator clears them explicitly via `RiskEngine.clear(reason)`. The
heartbeat watchdog clears its own halt when sidecars come back, but a
drawdown halt or a manual halt requires explicit clearing.

Checks (in order, all must pass for `check_open` to return ok):
  1. No active halts
  2. Daily drawdown still within ORCHESTRATOR_DAILY_DD_STOP_PCT of total_capital
  3. Cluster cap: count of currently-open positions correlated with the new
     token_id (signal-gateway /api/signal/topology/correlated) is below
     ORCHESTRATOR_CLUSTER_MAX

Bucket 3 of the autonomous-fund-arb plan.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

log = logging.getLogger("meridian.orchestrator.risk")


@dataclass
class RiskConfig:
    state_path: Path
    daily_dd_stop_pct: float = 2.0  # halt opens at -2% of total_capital
    cluster_max: int = 2
    cluster_threshold: float = 0.7
    heartbeat_interval_s: float = 30.0
    heartbeat_max_miss: int = 3
    # services to ping; (name, url). Empty url skips the check.
    services: list[tuple[str, str]] = field(default_factory=list)
    signal_url: str = "http://127.0.0.1:5002"
    total_capital: Decimal = Decimal("100")

    @classmethod
    def from_env(cls, *, state_dir: Path, total_capital: Decimal) -> "RiskConfig":
        def _f(key: str, default: float) -> float:
            v = os.environ.get(key)
            return float(v) if v is not None else default

        def _i(key: str, default: int) -> int:
            v = os.environ.get(key)
            return int(v) if v is not None else default

        signal = os.environ.get("SIGNAL_GATEWAY_URL", "http://127.0.0.1:5002")
        cogito = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL", "http://127.0.0.1:5003")
        execu = os.environ.get("EXECUTION_ROUTER_URL", "http://127.0.0.1:5004")
        return cls(
            state_path=state_dir / "risk_state.json",
            daily_dd_stop_pct=_f("ORCHESTRATOR_DAILY_DD_STOP_PCT", 2.0),
            cluster_max=_i("ORCHESTRATOR_CLUSTER_MAX", 2),
            cluster_threshold=_f("ORCHESTRATOR_CLUSTER_THRESHOLD", 0.7),
            heartbeat_interval_s=_f("ORCHESTRATOR_HEARTBEAT_INTERVAL_S", 30.0),
            heartbeat_max_miss=_i("ORCHESTRATOR_HEARTBEAT_MAX_MISS", 3),
            services=[
                ("signal-gateway", f"{signal}/health"),
                ("cogito", f"{cogito}/health"),
                ("execution-router", f"{execu}/health"),
            ],
            signal_url=signal,
            total_capital=total_capital,
        )


def _today_utc_key() -> str:
    return time.strftime("%Y-%m-%d", time.gmtime())


class RiskEngine:
    def __init__(self, cfg: RiskConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        # halt_reason → epoch ts
        self._halts: dict[str, float] = {}
        # date_utc → realized PnL Decimal
        self._daily_realized: dict[str, Decimal] = {}
        # position_id → (strategy, size_decimal, token_id)
        self._open: dict[str, tuple[str, Decimal, str]] = {}
        self._heartbeat_misses: dict[str, int] = {n: 0 for n, _ in cfg.services}
        self._stop_evt = threading.Event()
        self._hb_thread: threading.Thread | None = None
        self._signal_client = httpx.Client(base_url=cfg.signal_url, timeout=5.0)
        self.cfg.state_path.parent.mkdir(parents=True, exist_ok=True)
        self._load_state()

    # ------------------- public API -------------------

    def check_open(self, *, strategy: str, size: Decimal, token_id: str) -> tuple[bool, str | None]:
        with self._lock:
            if self._halts:
                first = next(iter(self._halts))
                return False, f"halted:{first}"
            dd_today = self._daily_realized.get(_today_utc_key(), Decimal(0))
            limit = -(self.cfg.total_capital * Decimal(str(self.cfg.daily_dd_stop_pct)) / Decimal(100))
            if dd_today < limit:
                # Trip a sticky drawdown halt so we don't keep recomputing.
                self._halt_unlocked("drawdown", reason_extra=f"realized={dd_today} limit={limit}")
                return False, "halted:drawdown"
        # Cluster check hits the network; do it outside the lock.
        n_correlated = self._count_correlated(token_id)
        if n_correlated >= self.cfg.cluster_max:
            return False, f"cluster_cap:{n_correlated}>={self.cfg.cluster_max}"
        return True, None

    def record_open(self, *, position_id: str, strategy: str, size: Decimal, token_id: str) -> None:
        with self._lock:
            self._open[position_id] = (strategy, size, token_id)

    def record_close(self, *, position_id: str, pnl: float | None) -> None:
        with self._lock:
            self._open.pop(position_id, None)
            if pnl is None:
                return
            key = _today_utc_key()
            self._daily_realized[key] = self._daily_realized.get(key, Decimal(0)) + Decimal(str(pnl))
            self._save_state_unlocked()

    def halt(self, reason: str) -> None:
        with self._lock:
            self._halt_unlocked(reason)

    def clear(self, reason: str) -> bool:
        with self._lock:
            removed = self._halts.pop(reason, None) is not None
            if removed:
                self._save_state_unlocked()
                log.warning("risk halt cleared: %s", reason)
            return removed

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "halts": dict(self._halts),
                "daily_realized": {k: str(v) for k, v in self._daily_realized.items()},
                "open_count": len(self._open),
                "heartbeat_misses": dict(self._heartbeat_misses),
                "config": {
                    "daily_dd_stop_pct": self.cfg.daily_dd_stop_pct,
                    "cluster_max": self.cfg.cluster_max,
                    "cluster_threshold": self.cfg.cluster_threshold,
                    "heartbeat_interval_s": self.cfg.heartbeat_interval_s,
                    "heartbeat_max_miss": self.cfg.heartbeat_max_miss,
                    "total_capital": str(self.cfg.total_capital),
                },
            }

    def start_watchdog(self) -> None:
        if self._hb_thread is not None and self._hb_thread.is_alive():
            return
        self._stop_evt.clear()
        self._hb_thread = threading.Thread(target=self._watchdog_loop, name="risk-heartbeat", daemon=True)
        self._hb_thread.start()

    def stop_watchdog(self) -> None:
        self._stop_evt.set()
        if self._hb_thread is not None:
            self._hb_thread.join(timeout=2.0)

    # ------------------- internals -------------------

    def _halt_unlocked(self, reason: str, *, reason_extra: str = "") -> None:
        if reason in self._halts:
            return
        self._halts[reason] = time.time()
        self._save_state_unlocked()
        log.error("risk HALT tripped: %s %s", reason, reason_extra)

    def _count_correlated(self, token_id: str) -> int:
        if not token_id:
            return 0
        try:
            r = self._signal_client.get(
                "/api/signal/topology/correlated",
                params={"token_id": token_id, "threshold": self.cfg.cluster_threshold},
            )
            r.raise_for_status()
            correlated_set = set(r.json().get("correlated", []) or [])
        except (httpx.HTTPError, ValueError) as e:
            # Topology unavailable → fail-open: let the position through.
            # Drawdown + heartbeat halts still gate; this just means cluster
            # discipline is dropped when the signal-gateway is down.
            log.warning("topology lookup failed for %s: %s — fail-open", token_id, e)
            return 0
        with self._lock:
            return sum(1 for _, _, tid in self._open.values() if tid in correlated_set)

    def _watchdog_loop(self) -> None:
        while not self._stop_evt.is_set():
            for name, url in self.cfg.services:
                if not url:
                    continue
                try:
                    r = httpx.get(url, timeout=3.0)
                    ok = r.status_code < 500
                except httpx.HTTPError:
                    ok = False
                with self._lock:
                    if ok:
                        if self._heartbeat_misses[name] > 0:
                            self._heartbeat_misses[name] = 0
                            self._halts.pop(f"heartbeat:{name}", None)
                            self._save_state_unlocked()
                            log.info("heartbeat recovered: %s", name)
                    else:
                        self._heartbeat_misses[name] += 1
                        if self._heartbeat_misses[name] >= self.cfg.heartbeat_max_miss:
                            self._halt_unlocked(f"heartbeat:{name}",
                                                reason_extra=f"misses={self._heartbeat_misses[name]}")
            self._stop_evt.wait(self.cfg.heartbeat_interval_s)

    def _save_state_unlocked(self) -> None:
        payload = {
            "halts": self._halts,
            "daily_realized": {k: str(v) for k, v in self._daily_realized.items()},
        }
        tmp = self.cfg.state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(self.cfg.state_path)

    def _load_state(self) -> None:
        if not self.cfg.state_path.exists():
            return
        try:
            data = json.loads(self.cfg.state_path.read_text())
        except (OSError, json.JSONDecodeError) as e:
            log.warning("risk state unreadable, starting fresh: %s", e)
            return
        self._halts = {k: float(v) for k, v in (data.get("halts") or {}).items()}
        self._daily_realized = {
            k: Decimal(str(v)) for k, v in (data.get("daily_realized") or {}).items()
        }
        if self._halts:
            log.warning("risk state restored with active halts: %s", list(self._halts))
