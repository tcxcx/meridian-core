"""Build the seed document fed to the swarm for a given Polymarket market.

Phase 6 (post-polymarket-agents-audit): the seed_doc is the *only* context an
agent sees about the market. Pre-this-rewrite, agents got just question +
outcomes + description. Now we bake in every Polymarket-specific signal we
compute elsewhere: order-book health (entropy + spread + depth), cross-market
correlations (duplicate-bet risk + cluster awareness), and cryo anomalies
(frozen books = possible regime shift / manipulation). Agents can then reason
ABOUT these signals instead of forecasting blind.

Public API stays a single function — callers append optional kwargs as they
have data; nothing breaks if a signal can't be fetched.
"""
from __future__ import annotations

from typing import Sequence

from .polymarket import MarketSummary


def build_seed_document(
    market: MarketSummary,
    *,
    include_market_prices: bool = True,
    entropy_per_outcome: dict[str, dict] | None = None,
    correlations: Sequence[dict] | None = None,
    cryo_flag: dict | None = None,
) -> str:
    """Format a Polymarket market into a swarm seed document.

    `entropy_per_outcome` maps outcome label -> EntropyReading.to_dict() so
    each agent can reason about per-outcome liquidity health. Pass `None`
    when the order-book fetch failed; the function silently skips that section.

    `correlations` is the list returned by `topology.correlated_with(token_id)`
    for the leading outcome — markets with |Pearson r| ≥ R_LATCH (0.70) over
    rolling mid-prices. Used to flag duplicate-bet risk to the agent.

    `cryo_flag` is the `CryoRow.to_dict()` for this market when its entropy
    z-score is anomalous; `None` when the market behaves normally.
    """
    lines: list[str] = []
    lines.append(f"# Prediction Market: {market.question}")
    lines.append("")
    if market.end_date_iso:
        lines.append(f"**Resolution deadline:** {market.end_date_iso}")
    lines.append(f"**Liquidity:** ${market.liquidity_usd:,.0f}  ·  **24h volume:** ${market.volume_usd:,.0f}")
    lines.append("")

    # ── Outcomes + market-implied probabilities ────────────────────────────
    if include_market_prices and market.outcome_prices:
        lines.append("## Outcomes (market-implied probability)")
        for outcome, price in zip(market.outcomes, market.outcome_prices):
            pct = price * 100.0 if 0.0 <= price <= 1.0 else price
            lines.append(f"- **{outcome}**: {pct:.1f}%")
    else:
        lines.append("## Outcomes")
        for outcome in market.outcomes:
            lines.append(f"- **{outcome}**")
    lines.append("")

    # ── Order-book health per outcome (E-01 entropy + microstructure) ──────
    # Agents that can see depth + spread reason much better about whether a
    # mispricing is real (broad participation rejecting the price) versus
    # noise (one whale parked on a thin book). Tier 0 = active, Tier 1 =
    # frozen (treat with caution), Tier 2 = deep freeze (probably stale or
    # manipulated; lean toward zero edge regardless of price).
    if entropy_per_outcome:
        lines.append("## Order-book microstructure (E-01)")
        lines.append("Per outcome — spread, depth, entropy tier (0=active, 1=frozen, 2=deep-freeze):")
        for outcome in market.outcomes:
            r = entropy_per_outcome.get(outcome)
            if not r:
                lines.append(f"- **{outcome}**: order book unavailable")
                continue
            spread = r.get("spread_bps")
            spread_str = f"{spread:.0f} bps" if isinstance(spread, (int, float)) else "n/a"
            mid = r.get("mid")
            mid_str = f"${mid:.3f}" if isinstance(mid, (int, float)) else "n/a"
            depth_b = r.get("bid_depth") or 0.0
            depth_a = r.get("ask_depth") or 0.0
            tier = r.get("tier", "?")
            h = r.get("h_bits", 0.0)
            lines.append(
                f"- **{outcome}**: mid={mid_str} · spread={spread_str} · "
                f"bid-depth={depth_b:.0f} / ask-depth={depth_a:.0f} · "
                f"tier {tier} (H={h:.2f} bits)"
            )
        lines.append("")
        lines.append(
            "_Trading note:_ tier 2 markets are usually stale or whale-parked — "
            "discount any apparent edge by ≥50%. Spreads above 100bps mean "
            "execution slippage may eat the edge."
        )
        lines.append("")

    # ── Correlation risk (T-03 topology) ───────────────────────────────────
    # If this market is correlated with others (|r| ≥ 0.70), a position here
    # is partially a position there. Flag so agents account for bookbuilding
    # already in flight elsewhere in the fund.
    if correlations:
        lines.append("## Correlated markets (T-03)")
        lines.append(
            f"Markets whose mid-price tracks this one with |Pearson r| ≥ 0.70 over "
            f"the rolling window ({len(correlations)} matches):"
        )
        for c in correlations[:5]:
            slug = c.get("slug") or c.get("token_id", "?")
            r = c.get("r")
            r_str = f"{r:+.2f}" if isinstance(r, (int, float)) else "?"
            lines.append(f"- {slug}  r={r_str}")
        lines.append("")
        lines.append(
            "_Trading note:_ if the fund already holds a correlated position, "
            "treat this as a duplicate bet — size DOWN or pass."
        )
        lines.append("")

    # ── Cryo anomaly flag (C-02) ───────────────────────────────────────────
    # Cryo's z-score detects markets that are abnormally frozen vs their
    # historical entropy. Latched = something just changed (resolution news,
    # whale exit, oracle update, manipulation). Worth surfacing.
    if cryo_flag:
        z = cryo_flag.get("z_score")
        z_str = f"{z:+.2f}" if isinstance(z, (int, float)) else "?"
        lines.append("## Cryo anomaly (C-02)")
        lines.append(
            f"This market is currently latched: entropy z-score = {z_str} "
            f"(threshold = -1.5). The book froze unusually fast versus its "
            f"recent history."
        )
        lines.append(
            "_Trading note:_ a sudden freeze often precedes a price jump on "
            "resolution news. Either edge is real (someone knows something) "
            "or the book is being manipulated. Either way: small size, fast exit."
        )
        lines.append("")

    # ── Resolution criteria (the literal contract terms) ───────────────────
    if market.description:
        lines.append("## Resolution criteria")
        lines.append(market.description.strip())

    return "\n".join(lines)
