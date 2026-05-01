from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable

from .store import PositionRecord

TRADING_WALLET_TARGET_PCT = Decimal("0.10")
PER_POSITION_MIN_PCT = Decimal("0.01")
PER_POSITION_MAX_PCT = Decimal("0.05")


def _d(value: object, default: str = "0") -> Decimal:
    if value in (None, ""):
        return Decimal(default)
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return Decimal(default)


def _q6(value: Decimal) -> Decimal:
    return _d(value).quantize(Decimal("0.000001"), rounding=ROUND_HALF_UP)


def _f6(value: Decimal) -> float:
    return float(_q6(value))


def _truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _env_value(*names: str) -> str:
    for name in names:
        value = os.environ.get(name, "").strip()
        if value:
            return value
    return ""


def build_capital_snapshot(
    *,
    cfg,
    positions: Iterable[PositionRecord],
    cogito_health: dict | None,
    direct_polygon_balance_usdc: float | None = None,
    direct_polygon_native_balance: float | None = None,
    keeperhub_ready: bool,
    openclaw_enabled: bool,
    openclaw_session: bool,
) -> dict:
    rows = list(positions)
    gateway_balance = _d((cogito_health or {}).get("gateway", {}).get("treasuryBalance"))
    direct_polygon_balance = _q6(_d(direct_polygon_balance_usdc))
    direct_polygon_native = _q6(_d(direct_polygon_native_balance))

    open_positions = [row for row in rows if row.status not in {"settled", "failed", "exited"}]
    resolving_positions = [row for row in rows if row.status == "resolving"]
    staged_positions = [
        row for row in rows
        if row.gateway_deposit_tx and not row.bridge_recv_mint_tx
    ]
    settled_positions = [row for row in rows if row.status == "settled"]

    total_capital = _d(cfg.total_capital)
    trading_target = _q6(total_capital * TRADING_WALLET_TARGET_PCT)
    treasury_reserve_target = max(Decimal("0"), _q6(total_capital - trading_target))

    deployed_at_risk = _q6(sum(_d(row.usdc_amount) for row in open_positions))
    pending_credit_total = _q6(
        sum(_d(row.payout_usdc) for row in resolving_positions if row.payout_usdc is not None)
    )
    ops_staging_total = _q6(
        sum(_d(row.payout_usdc) for row in staged_positions if row.payout_usdc is not None)
    )
    realized_payout_total = _q6(
        sum(_d(row.payout_usdc) for row in settled_positions if row.payout_usdc is not None)
    )
    treasury_funding_mode = (
        "polygon-modular"
        if _env_value("MIROSHARK_TREASURY_WALLET_ADDRESS", "TREASURY_ADDRESS")
        else "polygon-direct"
        if _env_value("TREASURY_VIEM_ADDRESS")
        else "legacy-circle"
        if _env_value("CIRCLE_TREASURY_ADDRESS")
        else "unconfigured"
    )
    spendable_source = direct_polygon_balance if treasury_funding_mode in {"polygon-direct", "polygon-modular"} else gateway_balance
    grand_total = _q6(spendable_source + pending_credit_total + ops_staging_total)
    spendable_now = max(Decimal("0"), min(spendable_source, trading_target))
    trading_budget_basis = spendable_now if spendable_now > 0 else trading_target
    per_position_min = _q6(trading_budget_basis * PER_POSITION_MIN_PCT)
    per_position_max = _q6(trading_budget_basis * PER_POSITION_MAX_PCT)
    available_to_deploy = max(Decimal("0"), _q6(spendable_now - deployed_at_risk))
    replenish_tranche = _q6(total_capital * TRADING_WALLET_TARGET_PCT)
    replenish_needed = available_to_deploy < per_position_max
    profit_sweep_pending = pending_credit_total

    circle_api_ready = bool(os.environ.get("CIRCLE_API_KEY"))
    circle_entity_ready = bool(os.environ.get("CIRCLE_ENTITY_SECRET"))
    circle_wallet_set_ready = bool(os.environ.get("CIRCLE_WALLET_SET_ID"))
    circle_kit_ready = bool(os.environ.get("CIRCLE_KIT_KEY")) and bool(
        os.environ.get("TRADING_WALLET_PRIVATE_KEY")
        or os.environ.get("GATEWAY_SIGNER_PRIVATE_KEY")
        or os.environ.get("TREASURY_PRIVATE_KEY")
    )
    passkey_client_ready = bool(
        os.environ.get("NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_KEY")
        or os.environ.get("NEXT_PUBLIC_CIRCLE_CLIENT_KEY")
    ) and bool(
        os.environ.get("NEXT_PUBLIC_CIRCLE_MODULAR_CLIENT_URL")
        or os.environ.get("NEXT_PUBLIC_CIRCLE_CLIENT_URL")
    )
    treasury_address = (
        _env_value(
            "MIROSHARK_TREASURY_WALLET_ADDRESS",
            "TREASURY_ADDRESS",
            "TREASURY_VIEM_ADDRESS",
            "CIRCLE_TREASURY_ADDRESS",
        )
        or None
    )
    legacy_circle_treasury = _env_value("CIRCLE_TREASURY_ADDRESS") or None
    trading_wallet_address = (
        _env_value(
            "MIROSHARK_AGENT_WALLET_ADDRESS",
            "TRADING_WALLET_ADDRESS",
            "TREASURY_VIEM_ADDRESS",
        )
        or None
    )
    treasury_shared_with_trading = bool(
        treasury_address
        and trading_wallet_address
        and treasury_address.lower() == trading_wallet_address.lower()
    )
    treasury_funding_mode = treasury_funding_mode if treasury_funding_mode != "unconfigured" else (
        "legacy-circle" if legacy_circle_treasury else "unconfigured"
    )
    treasury_wallet_ready = bool(
        treasury_address and treasury_funding_mode != "legacy-circle"
    )
    multisig_ready = treasury_wallet_ready and passkey_client_ready
    openclaw_ready = openclaw_enabled or openclaw_session
    polymarket_ready = bool(os.environ.get("POLYMARKET_PRIVATE_KEY")) and (
        int(os.environ.get("POLYMARKET_CHAIN_ID", "137") or "137") == 80002
    )
    bridge_ready = bool((cogito_health or {}).get("bridge", {}).get("ready"))
    gateway_seeded = gateway_balance > 0
    hook_ready = bool(os.environ.get("MERIDIAN_HOOK_ADDRESS")) and bool(
        os.environ.get("ARB_SEPOLIA_RPC_URL")
        or os.environ.get("ARBITRUM_SEPOLIA_RPC_URL")
        or os.environ.get("BASE_SEPOLIA_RPC_URL")
        or os.environ.get("RPC_URL")
    )
    polygon_direct_ready = (
        treasury_funding_mode in {"polygon-direct", "polygon-modular"}
        and direct_polygon_balance > 0
        and direct_polygon_native > 0
    )

    def action_state(ready: bool) -> str:
        return "ready" if ready else "blocked"

    return {
        "source": "miroshark polygon-first treasury + sendero gateway + desk-v1 multisig",
        "primary_trading_chain": {
            "key": "polygon_amoy",
            "label": "Polygon Amoy",
            "domain": 7,
            "role": "Polymarket execution rail",
        },
        "treasury_funding_chain": {
            "key": "polygon",
            "label": "Polygon treasury rail",
            "role": "canonical treasury funding source for Miroshark",
        },
        "settlement_chain": {
            "key": "arbitrum_sepolia",
            "label": "Arbitrum Sepolia",
            "domain": 3,
            "role": "settlement + Fhenix / Uniswap hook rail",
        },
        "balances": {
            "grand_total": _f6(grand_total),
            "gateway_available": _f6(gateway_balance),
            "direct_polygon_available": _f6(direct_polygon_balance),
            "spendable_now": _f6(spendable_now),
            "pending_credit_total": _f6(pending_credit_total),
            "ops_staging_total": _f6(ops_staging_total),
            "deployed_at_risk": _f6(deployed_at_risk),
            "available_to_deploy": _f6(available_to_deploy),
            "realized_payout_total": _f6(realized_payout_total),
            "profit_sweep_pending": _f6(profit_sweep_pending),
        },
        "treasury": {
            "label": "Treasury Wallet",
            "role": "passkey-protected reserve and profit vault" if not treasury_shared_with_trading else "temporary Polygon treasury signer until modular treasury is provisioned",
            "address": treasury_address,
            "wallet_model": (
                "Circle modular wallet + weighted multisig"
                if treasury_funding_mode == "polygon-modular"
                else "Polygon treasury signer (temporary direct-funding mode)"
                if treasury_funding_mode == "polygon-direct"
                else "Legacy Circle treasury (migration pending)"
            ),
            "gateway_balance_usdc": _f6(gateway_balance),
            "direct_polygon_balance_usdc": _f6(direct_polygon_balance),
            "direct_polygon_native_balance": _f6(direct_polygon_native),
            "reserve_target_usdc": _f6(treasury_reserve_target),
            "passkey_ready": passkey_client_ready,
            "multisig_ready": multisig_ready,
            "circle_api_ready": circle_api_ready and circle_entity_ready,
            "wallet_set_ready": circle_wallet_set_ready,
            "funding_mode": treasury_funding_mode,
            "shared_with_trading": treasury_shared_with_trading,
            "legacy_circle_treasury_address": (
                legacy_circle_treasury
                if legacy_circle_treasury and legacy_circle_treasury != treasury_address
                else None
            ),
            "detail": (
                "Desk-v1 private-multisig pattern: human signer first, passkey signers "
                "second, weighted threshold custody for treasury releases."
                if treasury_funding_mode == "polygon-modular"
                else "Polygon-first donor path is active. Treasury funding resolves against the "
                "Miroshark signer until a dedicated modular treasury is provisioned."
                if treasury_funding_mode == "polygon-direct"
                else "Legacy Sendero Circle treasury is still configured, but it is no longer "
                "the preferred funding source for Miroshark."
            ),
        },
        "trading": {
            "label": "Trading Wallet",
            "role": "Gateway unified USDC budget for Polymarket deployment",
            "address": trading_wallet_address,
            "wallet_model": "Circle Gateway unified balance",
            "venue": "Polymarket",
            "chain": "Polygon Amoy",
            "target_balance_usdc": _f6(trading_target),
            "available_to_deploy_usdc": _f6(available_to_deploy),
            "at_risk_usdc": _f6(deployed_at_risk),
            "direct_polygon_balance_usdc": _f6(direct_polygon_balance),
            "direct_polygon_native_balance": _f6(direct_polygon_native),
            "replenish_tranche_usdc": _f6(replenish_tranche),
            "replenish_needed": replenish_needed,
            "execution_path": "KeeperHub nanopayments + OpenClaw operator loop",
            "detail": (
                "Sendero gateway-migration pattern: one unified USDC balance, materialize "
                "to Polygon only when the swarm decides to trade."
                if not treasury_shared_with_trading
                else "Trading currently shares the Polygon signer with treasury funding. "
                "Provision the modular treasury to split custody from execution."
            ),
        },
        "policy": {
            "treasury_provision_pct": float(TRADING_WALLET_TARGET_PCT),
            "per_position_min_pct": float(PER_POSITION_MIN_PCT),
            "per_position_max_pct": float(PER_POSITION_MAX_PCT),
            "per_position_min_usdc": _f6(per_position_min),
            "per_position_max_usdc": _f6(per_position_max),
            "polygon_direct_ready": polygon_direct_ready,
            "profit_distribution": (
                "OpenClaw resolves positions, KeeperHub executes money movement, "
                "profits sweep back into treasury."
            ),
            "keeperhub_required": keeperhub_ready,
            "openclaw_required": openclaw_ready,
        },
        "per_domain": [
            {
                "key": "polygon_amoy",
                "label": "Polygon Amoy",
                "domain": 7,
                "role": "primary trading rail",
                "balance_usdc": _f6(spendable_now),
                "detail": (
                    "Direct Polygon Amoy USDC deployable for Polymarket positions."
                    if polygon_direct_ready
                    else "Polygon USDC is present but native gas is missing for direct deployment."
                    if treasury_funding_mode in {"polygon-direct", "polygon-modular"} and direct_polygon_balance > 0
                    else "Gateway-funded deployment budget for Polymarket positions."
                ),
            },
            {
                "key": "polygon",
                "label": "Polygon treasury rail",
                "domain": None,
                "role": "canonical donor source",
                "balance_usdc": _f6(direct_polygon_balance if treasury_funding_mode in {"polygon-direct", "polygon-modular"} else Decimal("0")),
                "native_gas_balance": _f6(direct_polygon_native if treasury_funding_mode in {"polygon-direct", "polygon-modular"} else Decimal("0")),
                "detail": (
                    "Treasury funding should originate from the Polygon-side Miroshark treasury, "
                    "not the legacy Arc Circle wallet."
                ),
            },
            {
                "key": "arbitrum_sepolia",
                "label": "Arbitrum Sepolia",
                "domain": 3,
                "role": "treasury reserve",
                "balance_usdc": _f6(gateway_balance),
                "detail": "Circle Gateway treasury reserve and settlement source of truth.",
            },
        ],
        "actions": [
            {
                "key": "replenish",
                "label": "Replenish trading wallet",
                "state": action_state(bridge_ready and gateway_seeded),
                "detail": (
                    "Move a fresh 10% tranche from treasury into the Polygon deployment budget."
                    if bridge_ready and gateway_seeded
                    else "Circle Gateway is not seeded yet, so replenishment must wait for treasury funding on Arbitrum Sepolia."
                ),
            },
            {
                "key": "deploy",
                "label": "Deploy position",
                "state": action_state(
                    polymarket_ready
                    and keeperhub_ready
                    and available_to_deploy > 0
                    and (
                        polygon_direct_ready
                        or (bridge_ready and gateway_seeded)
                    )
                ),
                "detail": (
                    "Use 1–5% of the trading wallet for a new Polymarket position."
                    if polygon_direct_ready or (bridge_ready and gateway_seeded)
                    else "USDC is available, but Polygon Amoy native gas is missing and Circle Gateway is not yet seeded."
                ),
            },
            {
                "key": "nanopay",
                "label": "Nanopayment split",
                "state": action_state(keeperhub_ready and circle_api_ready and circle_entity_ready),
                "detail": "Use KeeperHub to execute agentic nanopayment legs against the unified USDC balance.",
            },
            {
                "key": "hedge",
                "label": "Swap / hedge",
                "state": action_state(circle_kit_ready or hook_ready),
                "detail": "Use Circle App Kit on the Polygon rail or the settlement hook rail to rebalance and hedge inventory.",
            },
            {
                "key": "sweep",
                "label": "Sweep profits to treasury",
                "state": action_state(bridge_ready and hook_ready),
                "detail": "Bridge realized payouts back into the treasury vault after resolution.",
            },
            {
                "key": "automation",
                "label": "24/7 OpenClaw loop",
                "state": action_state(openclaw_ready),
                "detail": "Let OpenClaw monitor, replenish, execute, and sweep with operator overrides.",
            },
        ],
    }
