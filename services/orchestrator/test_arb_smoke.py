"""Smoke test: cross-venue ArbStrategy + Reconciler wiring.

Run:
    cd meridian-core/services
    uv run python -m orchestrator.test_arb_smoke

Exit 0 = arb pipeline wired; non-zero = a contract broke. Does NOT hit
signal-gateway or execution-router; uses an in-process fake httpx client
that records calls and returns canned JSON.
"""
from __future__ import annotations

import sys
from decimal import Decimal
from typing import Any

from .reconciler import Reconciler, ReconcilerConfig
from .strategies import load_strategies
from .strategies.arb import ArbStrategy


def _check(cond: bool, msg: str) -> None:
    if not cond:
        print(f"FAIL: {msg}", file=sys.stderr)
        sys.exit(1)
    print(f"  ok  {msg}")


# ----- Fakes -----

class _FakeResp:
    def __init__(self, payload: dict, status: int = 200) -> None:
        self._payload = payload
        self.status_code = status
        self.text = ""

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self) -> dict:
        return self._payload


class _FakeClient:
    """Minimal httpx-like double — supports .get and .post."""

    def __init__(self) -> None:
        self.get_responses: dict[str, _FakeResp] = {}
        self.post_responses: dict[str, _FakeResp] = {}
        self.gets: list[tuple[str, dict[str, Any] | None]] = []
        self.posts: list[tuple[str, dict[str, Any]]] = []

    def get(self, path: str, params: dict | None = None) -> _FakeResp:
        self.gets.append((path, params))
        return self.get_responses.get(path, _FakeResp({}, 200))

    def post(self, path: str, json: dict) -> _FakeResp:  # noqa: A002
        self.posts.append((path, json))
        return self.post_responses.get(path, _FakeResp({}, 200))


# ----- Tests -----

def test_load_strategies_registers_arb() -> None:
    strategies = load_strategies(
        ["arb"],
        signal_client=_FakeClient(),
        min_arb_edge_pp=2.0,
        min_arb_score=0.30,
        usdc_per_position=5.0,
        scan_limit=20,
    )
    _check(len(strategies) == 1, "load_strategies returns one strategy for ['arb']")
    _check(strategies[0].name == "arb", "loaded strategy is the arb one")
    _check(isinstance(strategies[0], ArbStrategy), "instance is ArbStrategy")


def test_arb_evaluate_emits_signal_when_polymarket_cheaper() -> None:
    s = ArbStrategy(signal_client=_FakeClient(), min_arb_edge_pp=2.0, min_arb_score=0.30)
    pair = {
        "poly_market_id": "0xpoly",
        "poly_yes_token_id": "tok-yes",
        "poly_yes_price": 0.40,
        "poly_question": "Will Trump win 2028?",
        "kalshi_ticker": "PRES-2028-DJT",
        "kalshi_title": "Trump wins 2028 election",
        "kalshi_yes_mid": 0.50,
        "score": 0.55,
        "implied_edge_pp": -10.0,        # poly cheaper by 10pp
    }
    sig = s.evaluate(pair)
    _check(sig is not None, "arb evaluate emits Signal when poly is cheap leg")
    assert sig is not None
    _check(sig.strategy == "arb", "signal strategy = arb")
    _check(sig.venue == "polymarket", "venue = polymarket (we trade the cheap leg)")
    _check(sig.side == "BUY", "side = BUY YES on Polymarket")
    _check(sig.token_id == "tok-yes", "token_id passes through")
    _check(abs(sig.edge_pp - 10.0) < 1e-9, "edge_pp = |implied_edge_pp|")
    _check(sig.metadata["hedge_leg"]["venue"] == "kalshi", "hedge metadata pinned to kalshi")
    _check(sig.metadata["hedge_leg"]["paper"] is True, "hedge leg marked paper=True")
    _check(sig.metadata["hedge_leg"]["ticker"] == "PRES-2028-DJT", "hedge ticker preserved")


def test_arb_evaluate_skips_when_polymarket_richer() -> None:
    s = ArbStrategy(signal_client=_FakeClient(), min_arb_edge_pp=2.0, min_arb_score=0.30)
    pair = {
        "poly_market_id": "0xpoly",
        "poly_yes_token_id": "tok-yes",
        "poly_yes_price": 0.60,
        "kalshi_ticker": "PRES-2028-DJT",
        "kalshi_yes_mid": 0.50,
        "score": 0.55,
        "implied_edge_pp": 10.0,         # poly is the rich leg → cannot short
    }
    _check(s.evaluate(pair) is None, "arb skips when poly is the rich leg (no short on Polymarket)")


def test_arb_evaluate_skips_when_below_thresholds() -> None:
    s = ArbStrategy(signal_client=_FakeClient(), min_arb_edge_pp=2.0, min_arb_score=0.30)
    too_small_edge = {
        "poly_market_id": "0xp", "poly_yes_token_id": "t",
        "poly_yes_price": 0.49, "kalshi_yes_mid": 0.50,
        "kalshi_ticker": "K", "score": 0.55, "implied_edge_pp": -1.0,
    }
    _check(s.evaluate(too_small_edge) is None, "skips when |edge_pp| < min_arb_edge_pp")
    too_low_score = {
        "poly_market_id": "0xp", "poly_yes_token_id": "t",
        "poly_yes_price": 0.40, "kalshi_yes_mid": 0.50,
        "kalshi_ticker": "K", "score": 0.10, "implied_edge_pp": -10.0,
    }
    _check(s.evaluate(too_low_score) is None, "skips when score < min_arb_score (false-pair guard)")


def test_arb_size_respects_budget() -> None:
    s = ArbStrategy(signal_client=_FakeClient(), usdc_per_position=5.0)
    sig = type("Sig", (), {})()
    _check(s.size(sig, Decimal("10")) == Decimal("5"), "size returns usdc_per_position when budget >= want")
    _check(s.size(sig, Decimal("3")) == Decimal("3"), "size capped to budget when budget < want")
    _check(s.size(sig, Decimal("0")) == Decimal("0"), "size = 0 when budget = 0")


def test_arb_scan_calls_pairs_endpoint() -> None:
    fake_signal = _FakeClient()
    fake_signal.get_responses["/api/signal/arb/pairs"] = _FakeResp({
        "count": 1,
        "pairs": [{"poly_market_id": "0xp", "kalshi_ticker": "K", "implied_edge_pp": -3.0,
                   "score": 0.5, "poly_yes_token_id": "t", "poly_yes_price": 0.4,
                   "kalshi_yes_mid": 0.5}],
    })
    s = ArbStrategy(signal_client=fake_signal)
    out = s.scan()
    _check(len(out) == 1, "scan returns parsed pairs from /api/signal/arb/pairs")
    _check(fake_signal.gets[0][0] == "/api/signal/arb/pairs", "scan hits /api/signal/arb/pairs")


def test_reconciler_records_and_marks() -> None:
    sig = _FakeClient()
    exe = _FakeClient()
    rec = Reconciler(ReconcilerConfig(interval_s=0.0, cooldown_s=0.0), sig, exe)
    rec.record_open(
        position_id="p1",
        poly_market_id="0xp",
        poly_token_id="tok",
        hedge={"ticker": "K", "mark_price": 0.50, "open_poly_yes": 0.40},
    )
    snap = rec.snapshot()
    _check(snap["open_arb_positions"] == 1, "1 open arb position after record_open")
    _check(snap["legs"][0]["open_spread_pp"] == -10.0, "open_spread = (poly - kalshi)*100 = -10pp")


def test_reconciler_closes_on_capture() -> None:
    sig = _FakeClient()
    exe = _FakeClient()
    rec = Reconciler(
        ReconcilerConfig(interval_s=0.0, cooldown_s=0.0, min_close_spread_pp=0.5),
        sig, exe,
    )
    rec.record_open(
        position_id="p1",
        poly_market_id="0xp",
        poly_token_id="tok",
        hedge={"ticker": "K", "mark_price": 0.50, "open_poly_yes": 0.40},
    )
    # Spread captured: poly rallied to 0.495, kalshi steady → spread ~-0.5pp.
    sig.get_responses["/api/signal/arb/pairs"] = _FakeResp({
        "pairs": [{
            "poly_market_id": "0xp", "kalshi_ticker": "K",
            "poly_yes_price": 0.495, "kalshi_yes_mid": 0.50,
        }],
    })
    out = rec.tick()
    _check(len(out["closed"]) == 1, "reconciler closes 1 position on capture")
    _check(out["closed"][0]["reason"] == "captured", "close reason = captured")
    # Verify it called /api/execution/resolve with the right body.
    _check(len(exe.posts) == 1, "reconciler POSTed exactly once to execution-router")
    path, body = exe.posts[0]
    _check(path == "/api/execution/resolve", "reconciler hits /api/execution/resolve")
    _check(body["position_id"] == "p1", "resolve body carries position_id")
    _check(body["won"] is True, "resolve body sets won=True (treats capture as printed PnL)")
    _check("arb_reconciler:captured" in body["reason"], "resolve reason tagged with reconciler+capture")


def test_reconciler_closes_on_inversion() -> None:
    sig = _FakeClient()
    exe = _FakeClient()
    rec = Reconciler(
        ReconcilerConfig(interval_s=0.0, cooldown_s=0.0, min_close_spread_pp=0.5),
        sig, exe,
    )
    rec.record_open(
        position_id="p1",
        poly_market_id="0xp",
        poly_token_id="tok",
        hedge={"ticker": "K", "mark_price": 0.50, "open_poly_yes": 0.40},  # open spread = -10pp
    )
    # Spread inverted: poly now ABOVE kalshi → +5pp.
    sig.get_responses["/api/signal/arb/pairs"] = _FakeResp({
        "pairs": [{
            "poly_market_id": "0xp", "kalshi_ticker": "K",
            "poly_yes_price": 0.55, "kalshi_yes_mid": 0.50,
        }],
    })
    out = rec.tick()
    _check(len(out["closed"]) == 1, "reconciler closes 1 position on inversion")
    _check(out["closed"][0]["reason"] == "inverted", "close reason = inverted")


def test_reconciler_cooldown_blocks_immediate_close() -> None:
    sig = _FakeClient()
    exe = _FakeClient()
    rec = Reconciler(
        ReconcilerConfig(interval_s=0.0, cooldown_s=120.0, min_close_spread_pp=0.5),
        sig, exe,
    )
    rec.record_open(
        position_id="p1",
        poly_market_id="0xp",
        poly_token_id="tok",
        hedge={"ticker": "K", "mark_price": 0.50, "open_poly_yes": 0.40},
    )
    sig.get_responses["/api/signal/arb/pairs"] = _FakeResp({
        "pairs": [{
            "poly_market_id": "0xp", "kalshi_ticker": "K",
            "poly_yes_price": 0.495, "kalshi_yes_mid": 0.50,
        }],
    })
    out = rec.tick()
    _check(len(out["closed"]) == 0, "cooldown blocks immediate close")
    _check(len(exe.posts) == 0, "no resolve POST issued during cooldown window")


def test_reconciler_interval_gate() -> None:
    sig = _FakeClient()
    exe = _FakeClient()
    rec = Reconciler(ReconcilerConfig(interval_s=300.0, cooldown_s=0.0), sig, exe)
    rec.record_open(
        position_id="p1", poly_market_id="0xp", poly_token_id="t",
        hedge={"ticker": "K", "mark_price": 0.5, "open_poly_yes": 0.4},
    )
    rec.tick(now=1000.0)
    out2 = rec.tick(now=1010.0)  # only 10s later → must be skipped
    _check(out2.get("skipped") == "interval", "reconciler self-throttles inside interval_s")


def main() -> int:
    print("arb smoke...")
    test_load_strategies_registers_arb()
    test_arb_evaluate_emits_signal_when_polymarket_cheaper()
    test_arb_evaluate_skips_when_polymarket_richer()
    test_arb_evaluate_skips_when_below_thresholds()
    test_arb_size_respects_budget()
    test_arb_scan_calls_pairs_endpoint()
    test_reconciler_records_and_marks()
    test_reconciler_closes_on_capture()
    test_reconciler_closes_on_inversion()
    test_reconciler_cooldown_blocks_immediate_close()
    test_reconciler_interval_gate()
    print("OK — arb strategy + reconciler wiring proven.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
