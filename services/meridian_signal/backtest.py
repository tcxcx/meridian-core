"""Resolved-market evaluation harness for swarm forecasts.

This is intentionally not a historical market-replay or ROI backtest. It runs
the live swarm against recently resolved Polymarket markets and scores whether
the swarm's top pick matched the resolved winner.

To avoid leaking the answer into the model prompt, the swarm only sees market
metadata, outcomes, and resolution criteria. Closed-market terminal prices
(typically 0/1) are used strictly for labeling and offline scoring after the
prediction is made.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from statistics import mean

from . import polymarket, seed, swarm


@dataclass
class BacktestCase:
    market_id: str
    slug: str
    question: str
    resolved_outcome: str
    predicted_outcome: str
    correct: bool
    confidence: float
    brier: float
    swarm_prediction: dict[str, float]
    market_prices: dict[str, float]
    phase: str
    model: str


def _resolved_outcome(market: polymarket.MarketSummary, *, threshold: float = 0.99) -> str | None:
    if not market.closed or not market.outcomes or len(market.outcomes) != len(market.outcome_prices):
        return None
    winners = [
        outcome
        for outcome, price in zip(market.outcomes, market.outcome_prices)
        if float(price) >= threshold
    ]
    if len(winners) != 1:
        return None
    return winners[0]


def _brier_score(prediction: dict[str, float], winner: str, outcomes: list[str]) -> float:
    score = 0.0
    for outcome in outcomes:
        pred = float(prediction.get(outcome, 0.0))
        actual = 1.0 if outcome == winner else 0.0
        score += (pred - actual) ** 2
    return score / max(1, len(outcomes))


def run_backtest(
    *,
    limit: int = 5,
    min_liquidity_usd: float = 5_000.0,
    resolved_threshold: float = 0.99,
) -> dict:
    raw_markets = polymarket.discover_markets(
        limit=max(limit * 4, limit),
        min_liquidity_usd=min_liquidity_usd,
        closed=True,
        active=None,
        order="volume",
    )
    markets = []
    for market in raw_markets:
        winner = _resolved_outcome(market, threshold=resolved_threshold)
        if not winner:
            continue
        markets.append((market, winner))
        if len(markets) >= limit:
            break

    cases: list[BacktestCase] = []
    skipped = max(0, len(raw_markets) - len(markets))
    for market, winner in markets:
        seed_doc = seed.build_seed_document(market, include_market_prices=False)
        out = swarm.run(seed_doc=seed_doc, outcomes=market.outcomes, market_id=market.market_id)
        predicted_outcome = max(
            market.outcomes,
            key=lambda outcome: float(out.swarm_prediction.get(outcome, 0.0)),
        )
        cases.append(
            BacktestCase(
                market_id=market.market_id,
                slug=market.slug,
                question=market.question,
                resolved_outcome=winner,
                predicted_outcome=predicted_outcome,
                correct=predicted_outcome == winner,
                confidence=float(out.confidence),
                brier=_brier_score(out.swarm_prediction, winner, market.outcomes),
                swarm_prediction={k: float(v) for k, v in out.swarm_prediction.items()},
                market_prices={k: float(v) for k, v in zip(market.outcomes, market.outcome_prices)},
                phase=out.phase,
                model=out.model,
            )
        )

    tested = len(cases)
    correct = sum(1 for case in cases if case.correct)
    return {
        "tested": tested,
        "correct": correct,
        "accuracy": round(correct / tested, 4) if tested else 0.0,
        "avg_confidence": round(mean(case.confidence for case in cases), 4) if cases else 0.0,
        "avg_brier": round(mean(case.brier for case in cases), 6) if cases else 0.0,
        "skipped_unresolved_or_ambiguous": skipped,
        "method": "resolved-market classification eval",
        "uses_market_prices_as_input": False,
        "cases": [asdict(case) for case in cases],
    }
