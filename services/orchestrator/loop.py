"""Autonomous loop — Strategy/Allocator runtime.

Per tick, for each loaded strategy:
    markets = strategy.scan()
    for m in markets: candidates += [strategy.evaluate(m)]
Then rank all candidates across strategies by |edge_pp|*confidence,
ask the Allocator how much each strategy may spend, and dispatch the
top N that clear caps to /api/execution/open.

The Allocator is the only thing that knows total exposure across
strategies; risk caps and drawdown halts (Bucket 3) layer on top.

Hydration on boot: pulls /api/execution/positions and re-fills both
the (strategy,market_id) dedupe map and the Allocator. Until Bucket 6
adds a `strategy` column to PositionStore, hydrated positions default
to the "directional" strategy for back-compat with Phase 5 records.
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from dataclasses import dataclass, field
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx

from .allocator import Allocator, AllocatorConfig
from .risk import RiskConfig, RiskEngine
from .strategies import Signal, Strategy, load_strategies

log = logging.getLogger("meridian.orchestrator")


@dataclass
class LoopConfig:
    signal_url: str = "http://127.0.0.1:5002"
    execution_url: str = "http://127.0.0.1:5004"
    interval_s: float = 60.0
    max_positions_per_cycle: int = 1
    dry_run: bool = False

    # Strategy configuration
    strategies: list[str] = field(default_factory=lambda: ["directional"])
    # Per-strategy weights (name → weight). Allocator normalises.
    strategy_weights: dict[str, Decimal] = field(default_factory=dict)
    # Per-strategy caps (name → max simultaneous notional USDC).
    strategy_caps: dict[str, Decimal] = field(default_factory=dict)

    # Allocator globals
    total_capital: Decimal = Decimal("100")
    per_position_max: Decimal = Decimal("25")
    global_max_open_positions: int = 10

    # Directional-strategy params (passed via load_strategies kwargs)
    min_edge_pp: float = 3.0
    min_confidence: float = 0.55
    usdc_per_position: float = 5.0
    scan_limit: int = 10
    scan_min_liquidity_usd: float = 5_000.0

    @classmethod
    def from_env(cls) -> "LoopConfig":
        def _f(key: str, default: float) -> float:
            v = os.environ.get(key)
            return float(v) if v is not None else default

        def _d(key: str, default: Decimal) -> Decimal:
            v = os.environ.get(key)
            return Decimal(v) if v is not None else default

        def _i(key: str, default: int) -> int:
            v = os.environ.get(key)
            return int(v) if v is not None else default

        def _b(key: str, default: bool) -> bool:
            v = os.environ.get(key)
            if v is None:
                return default
            return v.strip().lower() in {"1", "true", "yes", "on"}

        strategies_csv = os.environ.get("ORCHESTRATOR_STRATEGIES", "directional")
        strategies = [s.strip() for s in strategies_csv.split(",") if s.strip()]

        weights: dict[str, Decimal] = {}
        caps: dict[str, Decimal] = {}
        for s in strategies:
            wkey = f"ORCHESTRATOR_STRATEGY_{s.upper()}_WEIGHT"
            ckey = f"ORCHESTRATOR_STRATEGY_{s.upper()}_CAP"
            if os.environ.get(wkey) is not None:
                weights[s] = Decimal(os.environ[wkey])
            else:
                # Default: equal weight across configured strategies.
                weights[s] = Decimal(1)
            if os.environ.get(ckey) is not None:
                caps[s] = Decimal(os.environ[ckey])

        return cls(
            signal_url=os.environ.get("SIGNAL_GATEWAY_URL", cls.signal_url),
            execution_url=os.environ.get("EXECUTION_ROUTER_URL", cls.execution_url),
            interval_s=_f("ORCHESTRATOR_INTERVAL_S", cls.interval_s),
            max_positions_per_cycle=_i("ORCHESTRATOR_MAX_POSITIONS", cls.max_positions_per_cycle),
            dry_run=_b("ORCHESTRATOR_DRY_RUN", cls.dry_run),
            strategies=strategies,
            strategy_weights=weights,
            strategy_caps=caps,
            total_capital=_d("ORCHESTRATOR_TOTAL_CAPITAL", cls.total_capital),
            per_position_max=_d("ORCHESTRATOR_PER_POSITION_MAX", cls.per_position_max),
            global_max_open_positions=_i("ORCHESTRATOR_GLOBAL_MAX_POSITIONS", cls.global_max_open_positions),
            min_edge_pp=_f("ORCHESTRATOR_MIN_EDGE_PP", cls.min_edge_pp),
            min_confidence=_f("ORCHESTRATOR_MIN_CONFIDENCE", cls.min_confidence),
            usdc_per_position=_f("ORCHESTRATOR_USDC_PER_POSITION", cls.usdc_per_position),
            scan_limit=_i("ORCHESTRATOR_SCAN_LIMIT", cls.scan_limit),
            scan_min_liquidity_usd=_f("ORCHESTRATOR_MIN_LIQUIDITY_USD", cls.scan_min_liquidity_usd),
        )


class Orchestrator:
    def __init__(self, cfg: LoopConfig) -> None:
        self.cfg = cfg
        self._signal = httpx.Client(base_url=cfg.signal_url, timeout=60.0)
        self._exec = httpx.Client(base_url=cfg.execution_url, timeout=60.0)

        # Allocator owns capital accounting across strategies.
        self.allocator = Allocator(AllocatorConfig(
            total_capital=cfg.total_capital,
            per_strategy_weights=dict(cfg.strategy_weights),
            per_strategy_caps=dict(cfg.strategy_caps),
            global_max_open_positions=cfg.global_max_open_positions,
            per_position_max=cfg.per_position_max,
        ))

        # Risk Engine owns sticky halts (drawdown, heartbeat, manual kill,
        # cluster cap). Layered on top of Allocator capital math.
        state_dir = Path(__file__).parent / "var"
        self.risk = RiskEngine(RiskConfig.from_env(
            state_dir=state_dir,
            total_capital=cfg.total_capital,
        ))

        # Load strategies. Each strategy gets the deps it accepts.
        self.strategies: list[Strategy] = load_strategies(
            cfg.strategies,
            signal_client=self._signal,
            min_edge_pp=cfg.min_edge_pp,
            min_confidence=cfg.min_confidence,
            usdc_per_position=cfg.usdc_per_position,
            scan_limit=cfg.scan_limit,
            scan_min_liquidity_usd=cfg.scan_min_liquidity_usd,
        )

        # Dedupe: (strategy, market_id) → position_id. Stops a strategy from
        # re-trading the same market this process. Two strategies CAN both
        # touch the same market (e.g. directional + arb on Trump-2028).
        self._opened: dict[tuple[str, str], str] = {}

    def hydrate_from_router(self) -> None:
        """Pre-fill `_opened` + Allocator from the router's PositionStore."""
        try:
            r = self._exec.get("/api/execution/positions")
            r.raise_for_status()
            records = r.json().get("positions", [])
        except httpx.HTTPError as e:
            log.warning("hydrate failed (router down?): %s", e)
            return

        hydrated: list[tuple[str, str, float]] = []
        for rec in records:
            # Pre-Bucket-6 records have no `strategy` field; default directional.
            strat = rec.get("strategy") or "directional"
            mid = rec.get("market_id")
            pid = rec.get("position_id")
            if mid and pid:
                self._opened[(strat, mid)] = pid
            hydrated.append((pid, strat, float(rec.get("usdc_amount") or 0)))
        self.allocator.hydrate(hydrated)
        log.info("hydrated %d positions across %d (strategy,market) pairs",
                 len(hydrated), len(self._opened))

    def tick(self) -> dict[str, Any]:
        """One iteration. Returns a summary for logging/dashboard."""
        summary: dict[str, Any] = {
            "scanned": 0,
            "evaluated": 0,
            "candidates": 0,
            "opened": [],
            "skipped": [],
            "allocator": self.allocator.snapshot(),
        }

        # Phase 1 — scan + evaluate, pooling Signals across strategies.
        all_signals: list[Signal] = []
        for strat in self.strategies:
            try:
                markets = strat.scan()
            except Exception as e:  # noqa: BLE001 — keep loop alive on plugin errors
                log.exception("strategy %s scan crashed: %s", strat.name, e)
                continue
            summary["scanned"] += len(markets)

            for m in markets:
                # Don't re-evaluate markets this strategy already opened.
                mid = m.get("market_id")
                if mid and (strat.name, mid) in self._opened:
                    continue
                try:
                    sig = strat.evaluate(m)
                except Exception as e:  # noqa: BLE001
                    log.exception("strategy %s evaluate crashed for %s: %s", strat.name, mid, e)
                    continue
                summary["evaluated"] += 1
                if sig is None:
                    continue
                all_signals.append(sig)

        all_signals.sort(key=Signal.rank_key, reverse=True)
        summary["candidates"] = len(all_signals)

        # Phase 2 — dispatch with allocator gating.
        opened_this_tick = 0
        strategy_lookup = {s.name: s for s in self.strategies}
        for sig in all_signals:
            if opened_this_tick >= self.cfg.max_positions_per_cycle:
                break
            strat = strategy_lookup.get(sig.strategy)
            if strat is None:
                summary["skipped"].append({"market_id": sig.market_id, "reason": f"no_strategy:{sig.strategy}"})
                continue
            budget = self.allocator.budget_for(sig.strategy)
            size = strat.size(sig, budget)
            ok, reason = self.risk.check_open(strategy=sig.strategy, size=size, token_id=sig.token_id)
            if not ok:
                summary["skipped"].append({
                    "market_id": sig.market_id,
                    "strategy": sig.strategy,
                    "reason": f"risk:{reason}",
                    "size": str(size),
                })
                continue
            ok, reason = self.allocator.can_open(sig.strategy, size)
            if not ok:
                summary["skipped"].append({
                    "market_id": sig.market_id,
                    "strategy": sig.strategy,
                    "reason": reason,
                    "size": str(size),
                    "budget": str(budget),
                })
                continue
            opened = self._open_position(strat, sig, size)
            if opened:
                opened_this_tick += 1
                summary["opened"].append(opened)

        summary["allocator"] = self.allocator.snapshot()
        return summary

    def run_forever(self) -> None:
        self.hydrate_from_router()
        self.risk.start_watchdog()
        try:
            while True:
                t0 = time.perf_counter()
                try:
                    summary = self.tick()
                    log.info(
                        "tick scanned=%d evaluated=%d candidates=%d opened=%d skipped=%d",
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
        finally:
            self.risk.stop_watchdog()

    # ------------------- dispatch -------------------

    def _open_position(self, strategy: Strategy, signal: Signal, size: Decimal) -> dict[str, Any] | None:
        position_id = str(uuid.uuid4())
        payload = {
            "position_id": position_id,
            "market_id": signal.market_id,
            "token_id": signal.token_id,
            "side": signal.side,
            "usdc_amount": float(size),
            # Sent for forward-compat; today's execution-router ignores
            # unknown fields. Bucket 6 will persist it as a column.
            "strategy": signal.strategy,
            "venue": signal.venue,
        }

        if self.cfg.dry_run:
            log.info("[dry_run] would open strat=%s pos=%s market=%s edge=%.2fpp size=%s",
                     signal.strategy, position_id, signal.market_id, signal.edge_pp, size)
            self._opened[(signal.strategy, signal.market_id)] = position_id
            self.allocator.record_open(signal.strategy, position_id, size)
            self.risk.record_open(position_id=position_id, strategy=signal.strategy,
                                  size=size, token_id=signal.token_id)
            try:
                strategy.on_open(signal, position_id, size)
            except Exception as e:  # noqa: BLE001
                log.warning("on_open hook crashed: %s", e)
            return {**payload, "dry_run": True}

        try:
            r = self._exec.post("/api/execution/open", json=payload)
        except httpx.HTTPError as e:
            log.error("open failed for %s: %s", signal.market_id, e)
            return None
        if r.status_code >= 400:
            log.error("open rejected %s: %s", r.status_code, r.text)
            return None

        self._opened[(signal.strategy, signal.market_id)] = position_id
        self.allocator.record_open(signal.strategy, position_id, size)
        self.risk.record_open(position_id=position_id, strategy=signal.strategy,
                              size=size, token_id=signal.token_id)
        try:
            strategy.on_open(signal, position_id, size)
        except Exception as e:  # noqa: BLE001
            log.warning("on_open hook crashed: %s", e)

        body = r.json()
        log.info(
            "opened strat=%s pos=%s market=%s edge=%.2fpp size=%s clob=%s",
            signal.strategy, position_id, signal.market_id,
            signal.edge_pp, size, body.get("clob_status"),
        )
        return body
