"""Autonomous loop.

Stateful iteration:
    scan markets → run swarm on each → rank by |edge_pp| → pick top N that
    clear `MIN_EDGE_PP` and aren't already open → POST /api/execution/open.

State-of-the-world tracker is intentionally in-memory — the router has
the canonical record on-chain + in PositionStore, so restarting the loop
just re-fills `self._seen` from `/api/execution/positions`.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass
from typing import Any

import httpx

log = logging.getLogger("meridian.orchestrator")


@dataclass
class LoopConfig:
    signal_url: str = "http://127.0.0.1:5002"
    execution_url: str = "http://127.0.0.1:5004"
    interval_s: float = 60.0
    max_positions_per_cycle: int = 1
    min_edge_pp: float = 3.0
    min_confidence: float = 0.55
    usdc_per_position: float = 5.0
    scan_limit: int = 10
    scan_min_liquidity_usd: float = 5000.0
    dry_run: bool = False  # log would-be trades without POSTing /open

    @classmethod
    def from_env(cls) -> "LoopConfig":
        def _f(key: str, default: float) -> float:
            v = os.environ.get(key)
            return float(v) if v is not None else default

        def _i(key: str, default: int) -> int:
            v = os.environ.get(key)
            return int(v) if v is not None else default

        def _b(key: str, default: bool) -> bool:
            v = os.environ.get(key)
            if v is None:
                return default
            return v.strip().lower() in {"1", "true", "yes", "on"}

        return cls(
            signal_url=os.environ.get("SIGNAL_GATEWAY_URL", cls.signal_url),
            execution_url=os.environ.get("EXECUTION_ROUTER_URL", cls.execution_url),
            interval_s=_f("ORCHESTRATOR_INTERVAL_S", cls.interval_s),
            max_positions_per_cycle=_i("ORCHESTRATOR_MAX_POSITIONS", cls.max_positions_per_cycle),
            min_edge_pp=_f("ORCHESTRATOR_MIN_EDGE_PP", cls.min_edge_pp),
            min_confidence=_f("ORCHESTRATOR_MIN_CONFIDENCE", cls.min_confidence),
            usdc_per_position=_f("ORCHESTRATOR_USDC_PER_POSITION", cls.usdc_per_position),
            scan_limit=_i("ORCHESTRATOR_SCAN_LIMIT", cls.scan_limit),
            scan_min_liquidity_usd=_f("ORCHESTRATOR_MIN_LIQUIDITY_USD", cls.scan_min_liquidity_usd),
            dry_run=_b("ORCHESTRATOR_DRY_RUN", cls.dry_run),
        )


class Orchestrator:
    def __init__(self, cfg: LoopConfig) -> None:
        self.cfg = cfg
        self._signal = httpx.Client(base_url=cfg.signal_url, timeout=60.0)
        self._exec = httpx.Client(base_url=cfg.execution_url, timeout=60.0)
        # market_id → position_id for positions opened this process
        self._opened: dict[str, str] = {}

    def hydrate_from_router(self) -> None:
        """Pre-fill `_opened` from the router's PositionStore so restarts don't double-trade."""
        try:
            r = self._exec.get("/api/execution/positions")
            r.raise_for_status()
            for rec in r.json().get("positions", []):
                self._opened[rec["market_id"]] = rec["position_id"]
            log.info("hydrated %d existing positions from router", len(self._opened))
        except httpx.HTTPError as e:
            log.warning("hydrate failed (router down?): %s", e)

    def tick(self) -> dict[str, Any]:
        """One iteration. Returns a summary for logging/dashboard."""
        summary: dict[str, Any] = {
            "scanned": 0,
            "evaluated": 0,
            "candidates": 0,
            "opened": [],
            "skipped": [],
        }
        try:
            scanned = self._scan()
        except httpx.HTTPError as e:
            log.error("scan failed: %s", e)
            return summary
        summary["scanned"] = len(scanned)

        # Skip markets we've already traded this process.
        fresh = [m for m in scanned if m["market_id"] not in self._opened]
        ranked: list[dict[str, Any]] = []

        for market in fresh:
            try:
                run = self._run_signal(market["market_id"])
            except httpx.HTTPError as e:
                log.warning("run failed for %s: %s", market["market_id"], e)
                continue
            summary["evaluated"] += 1

            edge = run.get("edge") or {}
            edge_pp = float(edge.get("edge_pp") or 0.0)
            confidence = float(run.get("confidence") or 0.0)

            if abs(edge_pp) < self.cfg.min_edge_pp or confidence < self.cfg.min_confidence:
                summary["skipped"].append({
                    "market_id": market["market_id"],
                    "reason": "below_thresholds",
                    "edge_pp": edge_pp,
                    "confidence": confidence,
                })
                continue

            token_id = self._token_id_for_outcome(market, edge.get("outcome"))
            if token_id is None:
                summary["skipped"].append({"market_id": market["market_id"], "reason": "no_token_id"})
                continue

            # Positive edge → BUY the outcome; negative edge → swarm disagrees,
            # so SELL (if we had a position) — for first pass we only open BUYs.
            if edge_pp <= 0:
                summary["skipped"].append({"market_id": market["market_id"], "reason": "negative_edge"})
                continue

            ranked.append({
                "market": market,
                "run": run,
                "edge_pp": edge_pp,
                "confidence": confidence,
                "token_id": token_id,
            })

        ranked.sort(key=lambda c: (c["edge_pp"], c["confidence"]), reverse=True)
        summary["candidates"] = len(ranked)

        for cand in ranked[: self.cfg.max_positions_per_cycle]:
            opened = self._open_position(cand)
            if opened:
                summary["opened"].append(opened)

        return summary

    def run_forever(self) -> None:
        self.hydrate_from_router()
        while True:
            t0 = time.perf_counter()
            try:
                summary = self.tick()
                log.info(
                    "tick summary scanned=%d evaluated=%d candidates=%d opened=%d skipped=%d",
                    summary["scanned"],
                    summary["evaluated"],
                    summary["candidates"],
                    len(summary["opened"]),
                    len(summary["skipped"]),
                )
            except Exception as e:  # noqa: BLE001 — keep the daemon alive
                log.exception("tick crashed: %s", e)

            elapsed = time.perf_counter() - t0
            sleep_for = max(1.0, self.cfg.interval_s - elapsed)
            time.sleep(sleep_for)

    # ------------------- wire helpers -------------------

    def _scan(self) -> list[dict[str, Any]]:
        r = self._signal.post(
            "/api/signal/markets/scan",
            json={"limit": self.cfg.scan_limit, "min_liquidity_usd": self.cfg.scan_min_liquidity_usd},
        )
        r.raise_for_status()
        return r.json().get("markets", [])

    def _run_signal(self, market_id: str) -> dict[str, Any]:
        r = self._signal.post("/api/signal/run", json={"market_id": market_id})
        r.raise_for_status()
        return r.json()

    @staticmethod
    def _token_id_for_outcome(market: dict[str, Any], outcome: str | None) -> str | None:
        if outcome is None:
            return None
        outcomes = market.get("outcomes") or []
        token_ids = market.get("token_ids") or market.get("clobTokenIds") or []
        if not outcomes or not token_ids:
            return None
        try:
            idx = outcomes.index(outcome)
        except ValueError:
            return None
        return token_ids[idx] if idx < len(token_ids) else None

    def _open_position(self, candidate: dict[str, Any]) -> dict[str, Any] | None:
        market = candidate["market"]
        position_id = str(uuid.uuid4())
        payload = {
            "position_id": position_id,
            "market_id": market["market_id"],
            "token_id": candidate["token_id"],
            "side": "BUY",
            "usdc_amount": self.cfg.usdc_per_position,
        }
        if self.cfg.dry_run:
            log.info("[dry_run] would open %s on %s edge=%.2fpp", position_id, market["market_id"], candidate["edge_pp"])
            self._opened[market["market_id"]] = position_id
            return {**payload, "dry_run": True}

        try:
            r = self._exec.post("/api/execution/open", json=payload)
        except httpx.HTTPError as e:
            log.error("open failed for %s: %s", market["market_id"], e)
            return None
        if r.status_code >= 400:
            log.error("open rejected %s: %s", r.status_code, r.text)
            return None
        self._opened[market["market_id"]] = position_id
        body = r.json()
        log.info(
            "opened position=%s market=%s edge=%.2fpp clob=%s",
            position_id, market["market_id"], candidate["edge_pp"], body.get("clob_status"),
        )
        return body
