"""Cross-venue arb reconciler — closes Polymarket arb legs when the
Kalshi paper hedge mark says the spread captured (or inverted).

Bucket 2 of autonomous-fund-arb. The arb strategy opens the Polymarket
leg through the normal /api/execution/open path and stashes the Kalshi
paper-hedge mark in `signal.metadata["hedge_leg"]["mark_price"]`. The
reconciler:

    1. on each tick, polls /api/signal/arb/pairs again and updates the
       paper-hedge mark for every open arb position keyed on the
       (poly_market_id, kalshi_ticker) pair;
    2. for each open arb position, computes the live spread:
           live_spread_pp = (poly_yes_now - kalshi_yes_now) * 100
       and compares to the spread at open. If the spread captured
       (|live_spread| < min_close_spread_pp) or **inverted**
       (sign(live_spread) != sign(open_spread)), the reconciler calls
       /api/execution/resolve on the Polymarket leg with `won=True`
       (treat-as-resolved-favourably so settle pulls the burner balance
       back to treasury — same flow used for normal directional wins).

The reconciler is in-process state only — restarts will re-hydrate from
the router's PositionStore (records carry the strategy field, so we know
which positions are arbs). For the hackathon this is enough; persistence
is a Bucket 6 (multi-tenant) concern.

A cooldown prevents a flap from immediately closing a position that the
arb strategy just opened (avoid open→close→open ping-pong on the same
spread inside one minute).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

log = logging.getLogger("meridian.orchestrator.reconciler")


@dataclass
class ArbLeg:
    position_id: str
    poly_market_id: str
    poly_token_id: str
    kalshi_ticker: str
    open_poly_yes: float
    open_kalshi_yes: float
    open_spread_pp: float
    opened_ts: float
    last_poly_yes: float
    last_kalshi_yes: float
    last_spread_pp: float = 0.0
    closed: bool = False
    close_reason: str | None = None


@dataclass
class ReconcilerConfig:
    interval_s: float = 60.0
    cooldown_s: float = 90.0           # ignore a position younger than this
    min_close_spread_pp: float = 0.5   # capture if |live_spread| drops below this
    pairs_endpoint: str = "/api/signal/arb/pairs"
    resolve_endpoint: str = "/api/execution/resolve"


class Reconciler:
    """Lightweight in-memory paper-hedge reconciler.

    The orchestrator instantiates one Reconciler and registers each arb
    position as it opens (`record_open`). The orchestrator then calls
    `tick()` on the reconciler at most once per loop iteration; the
    reconciler enforces its own min-interval internally so calling it
    every loop tick is fine.
    """

    def __init__(
        self,
        cfg: ReconcilerConfig,
        signal_client: httpx.Client,
        execution_client: httpx.Client,
    ) -> None:
        self.cfg = cfg
        self._signal = signal_client
        self._exec = execution_client
        self._legs: dict[str, ArbLeg] = {}
        self._last_tick_ts: float = 0.0

    # ----- registration -----

    def record_open(
        self,
        *,
        position_id: str,
        poly_market_id: str,
        poly_token_id: str,
        hedge: dict[str, Any],
    ) -> None:
        """Called by the orchestrator after a successful arb-strategy open."""
        kalshi_ticker = str(hedge.get("ticker") or "")
        if not kalshi_ticker:
            log.warning("arb position %s missing kalshi_ticker; skipping reconciler registration",
                        position_id)
            return
        # `mark_price` is the Kalshi YES mid at open time. The pair payload also
        # carries the Polymarket YES price at open time.
        open_kalshi_yes = float(hedge.get("mark_price") or 0.0)
        open_poly_yes = float(hedge.get("open_poly_yes") or 0.0)
        open_spread_pp = (open_poly_yes - open_kalshi_yes) * 100.0
        self._legs[position_id] = ArbLeg(
            position_id=position_id,
            poly_market_id=poly_market_id,
            poly_token_id=poly_token_id,
            kalshi_ticker=kalshi_ticker,
            open_poly_yes=open_poly_yes,
            open_kalshi_yes=open_kalshi_yes,
            open_spread_pp=open_spread_pp,
            opened_ts=time.time(),
            last_poly_yes=open_poly_yes,
            last_kalshi_yes=open_kalshi_yes,
            last_spread_pp=open_spread_pp,
        )
        log.info("reconciler tracking arb pos=%s pair=(%s, %s) open_spread=%+.2fpp",
                 position_id, poly_market_id, kalshi_ticker, open_spread_pp)

    def record_close(self, position_id: str, reason: str = "external") -> None:
        leg = self._legs.get(position_id)
        if leg is not None:
            leg.closed = True
            leg.close_reason = reason

    # ----- runtime -----

    def snapshot(self) -> dict[str, Any]:
        return {
            "open_arb_positions": sum(1 for l in self._legs.values() if not l.closed),
            "total_tracked": len(self._legs),
            "last_tick_ts": self._last_tick_ts,
            "legs": [
                {
                    "position_id": l.position_id,
                    "kalshi_ticker": l.kalshi_ticker,
                    "open_spread_pp": round(l.open_spread_pp, 4),
                    "last_spread_pp": round(l.last_spread_pp, 4),
                    "closed": l.closed,
                    "close_reason": l.close_reason,
                }
                for l in self._legs.values()
            ],
        }

    def tick(self, *, now: float | None = None) -> dict[str, Any]:
        """Poll arb pairs, update marks, close legs that captured/inverted."""
        now = now if now is not None else time.time()
        if now - self._last_tick_ts < self.cfg.interval_s:
            return {"skipped": "interval", "open": self._open_count()}
        self._last_tick_ts = now

        open_legs = [l for l in self._legs.values() if not l.closed]
        if not open_legs:
            return {"skipped": "no_open_legs", "open": 0}

        try:
            r = self._signal.get(self.cfg.pairs_endpoint)
            r.raise_for_status()
            pairs = r.json().get("pairs", [])
        except httpx.HTTPError as e:
            log.warning("reconciler scan failed: %s", e)
            return {"error": str(e), "open": len(open_legs)}

        # Index pairs by (poly_market_id, kalshi_ticker) — that's how we
        # opened, that's how we re-mark.
        by_pair: dict[tuple[str, str], dict[str, Any]] = {
            (str(p.get("poly_market_id") or ""), str(p.get("kalshi_ticker") or "")): p
            for p in pairs
        }

        closed_now: list[dict[str, Any]] = []
        marked: list[str] = []
        for leg in open_legs:
            p = by_pair.get((leg.poly_market_id, leg.kalshi_ticker))
            if p is None:
                continue
            poly_yes = float(p.get("poly_yes_price") or 0.0)
            kalshi_yes = float(p.get("kalshi_yes_mid") or 0.0)
            spread_pp = (poly_yes - kalshi_yes) * 100.0
            leg.last_poly_yes = poly_yes
            leg.last_kalshi_yes = kalshi_yes
            leg.last_spread_pp = spread_pp
            marked.append(leg.position_id)

            # Cooldown: don't close a freshly-opened position.
            if (now - leg.opened_ts) < self.cfg.cooldown_s:
                continue

            inverted = (
                (leg.open_spread_pp < 0 and spread_pp > 0)
                or (leg.open_spread_pp > 0 and spread_pp < 0)
            )
            # Tiny epsilon: percentage-point arithmetic on float prices loses
            # exact equality (0.495 - 0.50)*100 = -0.5000000000000004.
            captured = abs(spread_pp) <= (self.cfg.min_close_spread_pp + 1e-9)
            if not (inverted or captured):
                continue

            reason = "inverted" if inverted else "captured"
            ok = self._close_position(leg, reason=reason)
            if ok:
                leg.closed = True
                leg.close_reason = reason
                closed_now.append({
                    "position_id": leg.position_id,
                    "reason": reason,
                    "open_spread_pp": round(leg.open_spread_pp, 4),
                    "close_spread_pp": round(spread_pp, 4),
                })

        return {
            "marked": len(marked),
            "closed": closed_now,
            "open": self._open_count(),
        }

    def _open_count(self) -> int:
        return sum(1 for l in self._legs.values() if not l.closed)

    def _close_position(self, leg: ArbLeg, *, reason: str) -> bool:
        """Submit the Polymarket leg for resolution (settle path)."""
        body = {
            "position_id": leg.position_id,
            # `won=True` means: assume the trade printed positive PnL — the
            # actual realised PnL is whatever the burner balance pulls back
            # via Circle Gateway. The router doesn't compute PnL today; the
            # daily attestation pack (Bucket 5) reconstructs it from chain.
            "won": True,
            "reason": f"arb_reconciler:{reason}",
        }
        try:
            r = self._exec.post(self.cfg.resolve_endpoint, json=body)
        except httpx.HTTPError as e:
            log.warning("reconciler resolve failed for %s: %s", leg.position_id, e)
            return False
        if r.status_code >= 400:
            log.warning("reconciler resolve rejected %s: %s %s",
                        leg.position_id, r.status_code, r.text[:200])
            return False
        log.info("reconciler closed arb pos=%s reason=%s spread %+.2fpp → %+.2fpp",
                 leg.position_id, reason, leg.open_spread_pp, leg.last_spread_pp)
        return True
