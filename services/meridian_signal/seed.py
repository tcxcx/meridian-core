"""Build the seed document fed to the swarm for a given Polymarket market."""
from __future__ import annotations

from .polymarket import MarketSummary


def build_seed_document(market: MarketSummary) -> str:
    """Format a Polymarket market into a swarm seed document.

    Phase 1 keeps it deterministic and source-only (market metadata).
    Phase 5 (or earlier) will append pulled news context (Tavily/NewsAPI).
    """
    lines: list[str] = []
    lines.append(f"# Prediction Market: {market.question}")
    lines.append("")
    if market.end_date_iso:
        lines.append(f"**Resolution deadline:** {market.end_date_iso}")
    lines.append(f"**Liquidity:** ${market.liquidity_usd:,.0f}")
    lines.append(f"**24h volume:** ${market.volume_usd:,.0f}")
    lines.append("")
    lines.append("## Outcomes (with current market-implied probability)")
    for outcome, price in zip(market.outcomes, market.outcome_prices):
        pct = price * 100.0 if 0.0 <= price <= 1.0 else price
        lines.append(f"- **{outcome}**: {pct:.1f}%")
    lines.append("")
    if market.description:
        lines.append("## Resolution criteria & context")
        lines.append(market.description.strip())
    return "\n".join(lines)
