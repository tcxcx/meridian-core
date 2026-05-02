"""MERIDIAN execution-router HTTP surface.

Routes (Phase 5b — Circle Gateway crosschain settlement):
    GET  /health                                    → liveness + wiring summary
    POST /api/execution/open                        → fund hook, bridge to trading chain, place CLOB order
    POST /api/execution/resolve                     → deposit + bridge proceeds back, mark + settle on-chain
    GET  /api/execution/positions/<position_id>     → snapshot from PositionStore
    GET  /api/execution/positions                   → list all positions

Settlement chain: Arbitrum Sepolia (Fhenix CoFHE hook + fhUSDC, domain 3).
Trading chain:    Polygon PoS Amoy (Polymarket CLOB, domain 7).
Bridge:           Circle Gateway via cogito `/bridge` + `/bridge/deposit`.
                  Treasury pre-deposits once into Arb Sepolia GatewayWallet
                  (one-time setup); per-position the burner deposits its
                  payout into Polygon Amoy GatewayWallet on /resolve before
                  bridging back. Circle's Forwarder mints on the destination
                  chain so cogito never holds destination-chain gas.

The router is intentionally synchronous in this iteration. Each request
walks the full state machine (funding → bridged → open or funding → failed)
so the dashboard can see one network round-trip per click. We can move to a
queue once we have multiple concurrent positions in flight.
"""
from __future__ import annotations

import json
import logging
import os
import queue
from datetime import datetime
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from flask import Blueprint, Flask, Response, jsonify, redirect, request, send_from_directory, stream_with_context
from flask_cors import CORS

import time as _time

from . import attestation as attestation_mod
from . import audit as audit_mod
from . import bridge_client as bridge_mod
from . import burner as burner_mod
from . import capital as capital_mod
from . import clob_client, encryptor, hook_client
from . import keeperhub as keeperhub_mod
from . import polygon_funding as polygon_funding_mod
from . import tenants as tenants_mod
from .daily_pack import DailyPackBuilder
from .encryptor import SealedInput
from .store import PositionRecord, PositionStore
from .terminal_ticker import TerminalTicker

log = logging.getLogger("meridian.execution.api")


def _env_truthy(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in {"1", "true", "yes", "on"}


def _fetch_json(url: str, *, timeout: float = 2.0) -> dict | None:
    try:
        req = Request(url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except (OSError, URLError, json.JSONDecodeError):
        return None


def _to_uint128_amount(usdc_amount: float, decimals: int = 6) -> int:
    return int(round(usdc_amount * (10**decimals)))


def _polygon_direct_balance(client) -> float | None:
    if client is None:
        return None
    try:
        return client.balance_usdc()
    except Exception as e:  # noqa: BLE001
        log.warning("polygon direct balance unavailable: %s", e)
        return None


def _polygon_direct_native_balance(client) -> float | None:
    if client is None:
        return None
    try:
        return client.native_balance()
    except Exception as e:  # noqa: BLE001
        log.warning("polygon direct native balance unavailable: %s", e)
        return None


def _sealed_from_payload(handle: dict) -> SealedInput:
    """Parse the orchestrator-side `encrypted_size_handle` (Bucket 4).

    cofhejs emits camelCase JSON; the on-chain struct field order is
    (uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature). We
    convert to the Python `SealedInput` so HookClient's existing ABI
    encoder picks it up unchanged.
    """
    ct_raw = handle["ctHash"]
    if isinstance(ct_raw, str):
        ct = int(ct_raw, 0)  # honours 0x-prefix or decimal string
    else:
        ct = int(ct_raw)
    sig_hex = handle.get("signature") or ""
    if sig_hex.startswith("0x"):
        sig_hex = sig_hex[2:]
    return SealedInput(
        ct_hash=ct,
        security_zone=int(handle.get("securityZone", 0)),
        utype=int(handle.get("utype", 8)),
        signature=bytes.fromhex(sig_hex) if sig_hex else b"",
    )


def _bridge_burner_proceeds_to_treasury(
    *,
    record: PositionRecord,
    bridge,
    trading_chain: str,
    settlement_chain: str,
    burner_private_key: str,
    treasury_address: str,
    payout_usdc: float,
    audit_fn,
    store: PositionStore,
    failure_status: str = "failed",
):
    dep_result = bridge.deposit(
        chain=trading_chain,
        amount_usdc=float(payout_usdc),
        signer="burner",
        burner_private_key=burner_private_key,
    )
    record.gateway_deposit_approve_tx = dep_result.approve_tx
    record.gateway_deposit_tx = dep_result.deposit_tx
    if not dep_result.ok:
        record.status = failure_status
        record.error = f"gateway deposit failed: {dep_result.state}"
        store.upsert(record)
        audit_fn("gateway_deposit.err", position_id=record.position_id, status="err",
                 payload={"state": dep_result.state})
        return False, jsonify({"error": record.error, "position": record.to_json()}), 502
    audit_fn("gateway_deposit.ok", position_id=record.position_id, payload={
        "chain": trading_chain, "amount": float(payout_usdc),
        "approve_tx": dep_result.approve_tx, "deposit_tx": dep_result.deposit_tx,
        "dry_run": dep_result.dry_run,
    })

    recv_result = bridge.bridge(
        signer="burner",
        burner_private_key=burner_private_key,
        from_chain=trading_chain,
        to_chain=settlement_chain,
        amount_usdc=float(payout_usdc),
        recipient=treasury_address,
        use_forwarder=True,
    )
    record.bridge_recv_burn_tx = recv_result.burn_tx
    record.bridge_recv_mint_tx = recv_result.mint_tx
    if not recv_result.ok:
        record.status = failure_status
        record.error = f"bridge recv failed: {recv_result.state}"
        store.upsert(record)
        audit_fn("bridge_recv.err", position_id=record.position_id, status="err", payload={
            "state": recv_result.state, "transfer_id": recv_result.transfer_id,
        })
        return False, jsonify({"error": record.error, "position": record.to_json()}), 502
    audit_fn("bridge_recv.ok", position_id=record.position_id, payload={
        "from": trading_chain, "to": settlement_chain,
        "amount": float(payout_usdc),
        "transfer_id": recv_result.transfer_id,
        "burn_tx": recv_result.burn_tx, "mint_tx": recv_result.mint_tx,
        "dry_run": recv_result.dry_run,
    })
    return True, None, None


def create_app() -> Flask:
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    static_dir = Path(__file__).parent / "static"
    app = Flask(__name__, static_folder=str(static_dir), static_url_path="/static")
    # Same-origin in normal use; widen for parity with signal-gateway.
    CORS(app, origins="*")

    @app.get("/")
    def root_dashboard():
        app_url = os.environ.get("MIROSHARK_APP_URL", "http://127.0.0.1:3301/")
        return redirect(app_url, code=302)

    store = PositionStore()
    audit = audit_mod.from_env()
    factory = burner_mod.from_env()
    enc = encryptor.from_env()
    keeperhub = keeperhub_mod.from_env()
    hook = hook_client.from_env(encryptor=enc, keeperhub=keeperhub)
    bridge = bridge_mod.from_env()
    polygon_funding = polygon_funding_mod.from_env()
    pinner = attestation_mod.from_env()  # Bucket 4: per-position 0G attestation
    daily_pack = DailyPackBuilder(store=store, audit=audit, attestation=pinner)  # Bucket 5
    tenants = tenants_mod.from_env()  # Bucket 6: multi-tenant isolation
    terminal_ticker = TerminalTicker(store=store, audit=audit)

    def _audit(event: str, *, position_id: str | None = None, status: str = "ok", payload: dict | None = None) -> None:
        # Audit writes must never break the request flow — swallow + warn.
        try:
            audit.log(event, position_id=position_id, status=status, payload=payload or {})
        except Exception as e:  # noqa: BLE001
            log.warning("audit.log(%s) failed: %s", event, e)

    # MERIDIAN's canonical cross-chain route. Settlement chain is Arbitrum
    # Sepolia (Fhenix CoFHE); trading chain is Polygon Amoy (Polymarket).
    settlement_chain = os.environ.get("BRIDGE_SETTLEMENT_CHAIN", bridge_mod.DEFAULT_FROM_CHAIN)
    trading_chain = os.environ.get("BRIDGE_TRADING_CHAIN", bridge_mod.DEFAULT_TO_CHAIN)
    polygon_first_funding = polygon_funding_mod.funding_mode() in {"polygon-direct", "polygon-modular"}

    def _demo_real_required() -> bool:
        # E3: pre-demo gate. Set DEMO_REQUIRE_REAL=1 (or true / yes) to
        # force /open and /resolve to 503 when any sponsor leg would
        # silently degrade to dry-run / synthetic. The flag protects the
        # judging-window demo from "looks like success" failures where the
        # CLOB or bridge silently produced fake tx hashes.
        return os.environ.get("DEMO_REQUIRE_REAL", "").strip().lower() in ("1", "true", "yes")

    def _check_demo_real_blockers() -> list[str]:
        """Return a list of human-readable reasons why real-mode would fail."""
        blockers: list[str] = []
        if isinstance(bridge, bridge_mod.DryRunBridgeClient):
            blockers.append("bridge: DryRunBridgeClient (set COGITO_BASE_URL + COGITO_TOKEN to enable real Circle Gateway)")
        enc_name = type(enc).__name__
        if enc_name == "DryRunEncryptor":
            blockers.append("encryptor: DryRunEncryptor (set COGITO_BASE_URL + COGITO_TOKEN to enable cofhejs FHE encryption)")
        if hook is None:
            blockers.append("hook: not configured (set MERIDIAN_HOOK_ADDRESS + TREASURY_PRIVATE_KEY)")
        if factory is None:
            blockers.append("burner_factory: BURNER_SEED not configured")
        return blockers

    bp = Blueprint("meridian_execution", __name__, url_prefix="/api/execution")

    @app.get("/health")
    def health():
        # E12: probe the audit DB cheaply so /health distinguishes
        # "audit module wired" from "audit DB readable right now."
        audit_healthy = False
        if audit is not None:
            try:
                audit.recent(limit=1)
                audit_healthy = True
            except Exception as e:  # noqa: BLE001
                log.warning("audit health probe failed: %s", e)
        return {
            "service": "Miroshark execution router",
            "status": "ok",
            "phase": "5b",
            "wiring": {
                "burner_factory": factory is not None,
                "encryptor": type(enc).__name__,
                "keeperhub": keeperhub is not None,
                "hook": hook is not None,
                "treasury": hook.treasury_address if hook else None,
                "bridge": type(bridge).__name__,
                "audit": audit is not None,
                "audit_healthy": audit_healthy,
                "attestation": pinner is not None,
                "tenants": tenants.ids(),
            },
            "chains": {
                "settlement": settlement_chain,
                "trading": trading_chain,
            },
            "demo_require_real": _demo_real_required(),
            "demo_real_blockers": _check_demo_real_blockers() if _demo_real_required() else [],
            "positions": len(store.list()),
        }

    @bp.post("/open")
    def open_position():
        if _demo_real_required():
            blockers = _check_demo_real_blockers()
            if blockers:
                _audit("demo_require_real.block", status="err",
                       payload={"endpoint": "/open", "blockers": blockers})
                return jsonify({
                    "error": "DEMO_REQUIRE_REAL=1 set but sponsor legs would degrade to dry-run",
                    "blockers": blockers,
                    "fix": "unset DEMO_REQUIRE_REAL or fix the listed blockers",
                }), 503
        body = request.get_json(silent=True) or {}
        position_id = body.get("position_id")
        market_id = body.get("market_id")
        token_id = body.get("token_id")
        side = (body.get("side") or "BUY").upper()
        usdc_amount = body.get("usdc_amount")
        strategy = body.get("strategy") or "directional"
        # Bucket 6: pick the requested tenant or fall back to "default" for
        # forks running a single fund. Validate against the registry so a
        # misconfigured caller can't open under an unknown tenant or trade a
        # strategy the tenant hasn't whitelisted.
        tenant_id = body.get("tenant_id") or tenants_mod.DEFAULT_TENANT_ID
        # Bucket 4: orchestrator may pre-encrypt the size at the boundary so
        # cleartext notional never crosses localhost. Shape matches Solidity
        # `InEuint128` (camelCase fields produced by cofhejs).
        sealed_handle = body.get("encrypted_size_handle")

        missing = [k for k, v in {
            "position_id": position_id,
            "market_id": market_id,
            "token_id": token_id,
            "usdc_amount": usdc_amount,
        }.items() if v in (None, "")]
        if missing:
            return jsonify({"error": f"missing required fields: {missing}"}), 400
        if factory is None:
            return jsonify({"error": "BURNER_SEED not configured"}), 500

        tenant_cfg = tenants.get(tenant_id)
        if tenant_cfg is None:
            return jsonify({
                "error": f"unknown tenant_id: {tenant_id!r}",
                "known_tenants": tenants.ids(),
            }), 400
        if not tenant_cfg.allows(strategy):
            return jsonify({
                "error": f"tenant {tenant_id!r} does not allow strategy {strategy!r}",
                "allowed_strategies": sorted(tenant_cfg.strategies),
            }), 403
        if float(usdc_amount) > float(tenant_cfg.per_position_max_usdc):
            return jsonify({
                "error": (
                    f"usdc_amount={usdc_amount} exceeds tenant {tenant_id!r} "
                    f"per_position_max={tenant_cfg.per_position_max_usdc}"
                ),
            }), 422

        # Per-tenant + per-strategy sub-account (Bucket 6): same
        # position_id under different (tenant, strategy) tuples derives to
        # different burners. The default tenant aliases the Bucket-4 layout
        # so existing positions keep re-deriving to the same EOA.
        burner = factory.derive(position_id, strategy_id=strategy, tenant_id=tenant_id)
        amount_uint128 = _to_uint128_amount(float(usdc_amount))

        record = PositionRecord(
            position_id=position_id,
            market_id=market_id,
            token_id=token_id,
            side="BUY" if side == "BUY" else "SELL",
            usdc_amount=float(usdc_amount),
            burner_address=burner.address,
            strategy=strategy,
            tenant_id=tenant_id,
        )
        store.upsert(record)
        _audit("open.received", position_id=position_id, payload={
            "market_id": market_id, "token_id": token_id,
            "side": side, "usdc_amount": float(usdc_amount),
            "burner_address": burner.address,
            "strategy": strategy,
            "tenant_id": tenant_id,
            "encrypted_size_provided": sealed_handle is not None,
        })

        # Step 1 — fund the burner with encrypted fhUSDC via the hook (Arb Sepolia).
        if hook is not None:
            try:
                if sealed_handle is not None:
                    sealed = _sealed_from_payload(sealed_handle)
                    fund_result = hook.fund_burner_with_sealed(position_id, burner.address, sealed)
                else:
                    fund_result = hook.fund_burner(position_id, burner.address, amount_uint128)
                record.fund_tx = fund_result.tx_hash
                if fund_result.execution_id:
                    record.keeperhub_executions.append(fund_result.execution_id)
                _audit("fund_burner.ok", position_id=position_id, payload={
                    "tx": fund_result.tx_hash,
                    "execution_id": fund_result.execution_id,
                    "amount_uint128": amount_uint128,
                })
            except Exception as e:  # noqa: BLE001
                record.status = "failed"
                record.error = f"fund_burner: {e}"
                store.upsert(record)
                _audit("fund_burner.err", position_id=position_id, status="err", payload={"error": str(e)})
                return jsonify({"error": record.error, "position": record.to_json()}), 502
        else:
            log.warning("hook unconfigured; skipping fund_burner (offline mode)")
            _audit("fund_burner.skip", position_id=position_id, status="info", payload={"reason": "hook unconfigured"})

        # Step 2 — Gateway: bridge USDC from treasury (Arb Sepolia) → burner (Polygon Amoy).
        # Treasury signs the EIP-712 BurnIntent against its pre-deposited unified
        # balance; Circle's Forwarder mints USDC to the burner EOA on Polygon Amoy
        # so cogito doesn't need to hold a Polygon key or pay destination gas.
        try:
            if polygon_first_funding and polygon_funding is not None and trading_chain == "polygon_amoy":
                send_result = polygon_funding.transfer_usdc(burner.address, float(usdc_amount))
                record.bridge_send_mint_tx = send_result.tx_hash
                _audit("polygon_fund.ok", position_id=position_id, payload={
                    "from": polygon_funding.address,
                    "to": burner.address,
                    "amount": float(usdc_amount),
                    "tx_hash": send_result.tx_hash,
                })
            else:
                send_result = bridge.bridge(
                    signer="treasury",
                    from_chain=settlement_chain,
                    to_chain=trading_chain,
                    amount_usdc=float(usdc_amount),
                    recipient=burner.address,
                    use_forwarder=True,
                )
                record.bridge_send_burn_tx = send_result.burn_tx
                record.bridge_send_mint_tx = send_result.mint_tx
                if not send_result.ok:
                    record.status = "failed"
                    record.error = f"bridge send failed: {send_result.state}"
                    store.upsert(record)
                    _audit("bridge_send.err", position_id=position_id, status="err", payload={
                        "state": send_result.state, "transfer_id": send_result.transfer_id,
                    })
                    return jsonify({"error": record.error, "position": record.to_json()}), 502
                _audit("bridge_send.ok", position_id=position_id, payload={
                    "from": settlement_chain, "to": trading_chain,
                    "amount": float(usdc_amount),
                    "transfer_id": send_result.transfer_id,
                    "burn_tx": send_result.burn_tx, "mint_tx": send_result.mint_tx,
                    "dry_run": send_result.dry_run,
                })
        except Exception as e:  # noqa: BLE001
            record.status = "failed"
            record.error = f"fund trading rail: {e}"
            store.upsert(record)
            _audit("bridge_send.err", position_id=position_id, status="err", payload={"error": str(e)})
            return jsonify({"error": record.error, "position": record.to_json()}), 502

        # Step 3 — submit the Polymarket order with the burner's private key.
        try:
            order = clob_client.submit_for_burner(
                burner_private_key=burner.private_key,
                token_id=token_id,
                side=side,
                amount=float(usdc_amount),
            )
            record.clob_order_id = order.order_id
            _audit("clob_submit.ok", position_id=position_id, payload={
                "order_id": order.order_id, "status": order.status,
                "token_id": token_id, "side": side, "amount": float(usdc_amount),
            })
        except Exception as e:  # noqa: BLE001
            record.status = "failed"
            record.error = f"clob: {e}"
            store.upsert(record)
            _audit("clob_submit.err", position_id=position_id, status="err", payload={"error": str(e)})
            return jsonify({"error": record.error, "position": record.to_json()}), 502

        record.status = "open"
        store.upsert(record)
        _audit("open.ok", position_id=position_id, payload={
            "clob_order_id": record.clob_order_id, "clob_status": order.status,
        })
        return jsonify({"position": record.to_json(), "clob_status": order.status})

    @bp.post("/close")
    def close_position():
        body = request.get_json(silent=True) or {}
        position_id = body.get("position_id")
        share_amount = body.get("share_amount")
        bridge_back = bool(body.get("bridge_back", True))
        reason = body.get("reason") or "manual_exit"
        if not position_id:
            return jsonify({"error": "position_id required"}), 400
        record = store.get(position_id)
        if record is None:
            return jsonify({"error": f"unknown position: {position_id}"}), 404
        retry_bridge_only = (
            record.status == "exited"
            and bridge_back
            and bool(record.exit_usdc and record.exit_usdc > 0)
            and not record.bridge_recv_burn_tx
        )
        if record.status != "open" and not retry_bridge_only:
            return jsonify({"error": f"position is not open: {record.status}", "position": record.to_json()}), 409
        if factory is None:
            return jsonify({"error": "BURNER_SEED not configured"}), 500
        burner = factory.derive(position_id, strategy_id=record.strategy, tenant_id=record.tenant_id)

        if retry_bridge_only:
            _audit("close_bridge.retry", position_id=position_id, payload={
                "bridge_back": bridge_back,
                "reason": reason,
                "exit_usdc": record.exit_usdc,
            })
        else:
            record.status = "closing"
            store.upsert(record)
            _audit("close.received", position_id=position_id, payload={
                "share_amount": share_amount,
                "bridge_back": bridge_back,
                "reason": reason,
            })

            try:
                exit_order, balances = clob_client.close_for_burner(
                    burner_private_key=burner.private_key,
                    token_id=record.token_id,
                    share_amount=float(share_amount) if share_amount is not None else None,
                )
                if exit_order.status != "submitted":
                    record.status = "open"
                    record.error = f"close did not submit to Polymarket: {exit_order.status}"
                    store.upsert(record)
                    _audit("clob_exit.dry_run", position_id=position_id, status="err", payload={
                        "order_id": exit_order.order_id,
                        "status": exit_order.status,
                    })
                    return jsonify({"error": record.error, "position": record.to_json()}), 409
                record.exit_order_id = exit_order.order_id
                record.exit_shares = balances.shares
                record.exit_usdc = balances.exit_usdc
                record.status = "exited"
                store.upsert(record)
                _audit("clob_exit.ok", position_id=position_id, payload={
                    "order_id": exit_order.order_id,
                    "status": exit_order.status,
                    "shares": balances.shares,
                    "usdc_before": balances.usdc_before,
                    "usdc_after": balances.usdc_after,
                    "exit_usdc": balances.exit_usdc,
                })
            except Exception as e:  # noqa: BLE001
                record.status = "open"
                record.error = f"close: {e}"
                store.upsert(record)
                _audit("clob_exit.err", position_id=position_id, status="err", payload={"error": str(e)})
                return jsonify({"error": record.error, "position": record.to_json()}), 502

        if bridge_back and record.exit_usdc and record.exit_usdc > 0:
            treasury_address = hook.treasury_address if hook is not None else None
            if not treasury_address:
                record.status = "exited"
                record.error = "close bridge-back requested but hook/treasury address is unavailable"
                store.upsert(record)
                return jsonify({"error": record.error, "position": record.to_json()}), 502
            try:
                ok, resp, code = _bridge_burner_proceeds_to_treasury(
                    record=record,
                    bridge=bridge,
                    trading_chain=trading_chain,
                    settlement_chain=settlement_chain,
                    burner_private_key=burner.private_key,
                    treasury_address=treasury_address,
                    payout_usdc=float(record.exit_usdc),
                    audit_fn=_audit,
                    store=store,
                    failure_status="exited",
                )
                if not ok:
                    return resp, code
            except Exception as e:  # noqa: BLE001
                record.status = "exited"
                record.error = f"close bridge-back: {e}"
                store.upsert(record)
                _audit("close_bridge.err", position_id=position_id, status="err", payload={"error": str(e)})
                return jsonify({"error": record.error, "position": record.to_json()}), 502

        record.status = "exited"
        record.error = None
        store.upsert(record)
        _audit("close.ok", position_id=position_id, payload={
            "exit_order_id": record.exit_order_id,
            "exit_shares": record.exit_shares,
            "exit_usdc": record.exit_usdc,
            "reason": reason,
            "bridge_back": bridge_back,
        })
        return jsonify({
            "position": record.to_json(),
            "exit": {
                "order_id": record.exit_order_id,
                "shares": record.exit_shares,
                "usdc": record.exit_usdc,
                "bridge_back": bridge_back,
            },
        })

    @bp.post("/resolve")
    def resolve_position():
        if _demo_real_required():
            blockers = _check_demo_real_blockers()
            if blockers:
                _audit("demo_require_real.block", status="err",
                       payload={"endpoint": "/resolve", "blockers": blockers})
                return jsonify({
                    "error": "DEMO_REQUIRE_REAL=1 set but sponsor legs would degrade to dry-run",
                    "blockers": blockers,
                    "fix": "unset DEMO_REQUIRE_REAL or fix the listed blockers",
                }), 503
        body = request.get_json(silent=True) or {}
        position_id = body.get("position_id")
        payout_usdc = body.get("payout_usdc")
        if not position_id or payout_usdc is None:
            return jsonify({"error": "position_id and payout_usdc required"}), 400

        record = store.get(position_id)
        if record is None:
            return jsonify({"error": f"unknown position: {position_id}"}), 404
        if hook is None:
            return jsonify({"error": "hook unconfigured"}), 500

        record.status = "resolving"
        record.payout_usdc = float(payout_usdc)
        store.upsert(record)
        _audit("resolve.received", position_id=position_id, payload={"payout_usdc": float(payout_usdc)})

        # Step 1 — Gateway: deposit + bridge proceeds from burner (Polygon Amoy) → treasury (Arb Sepolia).
        # Unlike treasury (which is pre-deposited once), the burner has no Gateway
        # unified balance until we put one there. So /resolve is two-phase:
        #   1a) approve + deposit payout into Polygon Amoy GatewayWallet,
        #   1b) burner signs BurnIntent; Forwarder mints USDC to treasury on Arb Sepolia.
        treasury_address = hook.treasury_address
        burner_obj = (
            factory.derive(position_id, strategy_id=record.strategy, tenant_id=record.tenant_id)
            if factory is not None else None
        )
        if burner_obj is not None and float(payout_usdc) > 0:
            try:
                ok, resp, code = _bridge_burner_proceeds_to_treasury(
                    record=record,
                    bridge=bridge,
                    trading_chain=trading_chain,
                    settlement_chain=settlement_chain,
                    burner_private_key=burner_obj.private_key,
                    treasury_address=treasury_address,
                    payout_usdc=float(payout_usdc),
                    audit_fn=_audit,
                    store=store,
                )
                if not ok:
                    return resp, code
            except Exception as e:  # noqa: BLE001
                record.status = "failed"
                record.error = f"bridge recv: {e}"
                store.upsert(record)
                _audit("bridge_recv.err", position_id=position_id, status="err", payload={"error": str(e)})
                return jsonify({"error": record.error, "position": record.to_json()}), 502

        try:
            payout_uint128 = _to_uint128_amount(float(payout_usdc))
            resolve_result = hook.mark_resolved(position_id, payout_uint128)
            record.resolve_tx = resolve_result.tx_hash
            if resolve_result.execution_id:
                record.keeperhub_executions.append(resolve_result.execution_id)
            _audit("mark_resolved.ok", position_id=position_id, payload={
                "tx": resolve_result.tx_hash,
                "execution_id": resolve_result.execution_id,
                "payout_uint128": payout_uint128,
            })

            settle_result = hook.settle(position_id)
            record.settle_tx = settle_result.tx_hash
            if settle_result.execution_id:
                record.keeperhub_executions.append(settle_result.execution_id)
            _audit("settle.ok", position_id=position_id, payload={
                "tx": settle_result.tx_hash,
                "execution_id": settle_result.execution_id,
            })
        except Exception as e:  # noqa: BLE001
            record.status = "failed"
            record.error = f"resolve: {e}"
            store.upsert(record)
            _audit("resolve.err", position_id=position_id, status="err", payload={"error": str(e)})
            return jsonify({"error": record.error, "position": record.to_json()}), 502

        record.status = "settled"
        store.upsert(record)
        _audit("settled.ok", position_id=position_id, payload={
            "resolve_tx": record.resolve_tx, "settle_tx": record.settle_tx,
            "payout_usdc": record.payout_usdc,
        })

        # Bucket 4: pin a per-position attestation envelope to 0G Storage.
        # Bucket 5 will fold these root_hashes into the daily attestation pack.
        # Best-effort — failure logs + audits but does not fail /resolve.
        if pinner is not None:
            envelope = {
                "schema": "meridian/position/v1",
                "position_id": position_id,
                "strategy": record.strategy,
                "tenant_id": record.tenant_id,
                "market_id": record.market_id,
                "token_id": record.token_id,
                "side": record.side,
                "burner_address": record.burner_address,
                "fund_tx": record.fund_tx,
                "resolve_tx": record.resolve_tx,
                "settle_tx": record.settle_tx,
                "bridge_send_burn_tx": record.bridge_send_burn_tx,
                "bridge_recv_burn_tx": record.bridge_recv_burn_tx,
                "payout_uint128": _to_uint128_amount(float(record.payout_usdc or 0)),
                "ts": _time.time(),
            }
            try:
                pin = pinner.pin(envelope, meta={
                    "position_id": position_id,
                    "strategy": record.strategy,
                    "tenant_id": record.tenant_id,
                })
                _audit("attestation.pinned", position_id=position_id, payload={
                    "root_hash": pin.root_hash, "tx_hash": pin.tx_hash, "size_bytes": pin.size_bytes,
                    "tenant_id": record.tenant_id,
                })
            except Exception as e:  # noqa: BLE001
                log.warning("attestation pin failed for %s: %s", position_id, e)
                _audit("attestation.pin_failed", position_id=position_id, status="warn",
                       payload={"error": str(e)})

        return jsonify({"position": record.to_json()})

    @bp.get("/positions/<position_id>")
    def get_position(position_id: str):
        record = store.get(position_id)
        if record is None:
            return jsonify({"error": "not found"}), 404
        return jsonify({"position": record.to_json()})

    @bp.get("/positions")
    def list_positions():
        # Bucket 6: optional tenant filter via query param. Unknown tenants
        # 404 so callers can distinguish "tenant has no positions" from
        # "tenant doesn't exist".
        tenant_filter = request.args.get("tenant_id")
        if tenant_filter is not None:
            if tenant_filter not in tenants:
                return jsonify({
                    "error": f"unknown tenant_id: {tenant_filter!r}",
                    "known_tenants": tenants.ids(),
                }), 404
            return jsonify({
                "tenant_id": tenant_filter,
                "positions": [
                    r.to_json() for r in store.list()
                    if getattr(r, "tenant_id", "default") == tenant_filter
                ],
            })
        return jsonify({"positions": [r.to_json() for r in store.list()]})

    @bp.get("/tenants")
    def list_tenants():
        # Bucket 6: snapshot of configured tenants + per-tenant open count
        # so the dashboard / verifier can render a tenant picker without a
        # second round-trip.
        open_by_tenant: dict[str, int] = {}
        for r in store.list():
            tid = getattr(r, "tenant_id", "default")
            open_by_tenant[tid] = open_by_tenant.get(tid, 0) + 1
        return jsonify({
            "tenants": [
                {**cfg.to_json(), "open_positions": open_by_tenant.get(cfg.tenant_id, 0)}
                for cfg in tenants.list()
            ],
        })

    @bp.get("/operator/status")
    def operator_status():
        try:
            from orchestrator.loop import LoopConfig

            cfg = LoopConfig.from_env()
            records = store.list()
            cogito_base = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL") or "http://127.0.0.1:5003"
            cogito_health = _fetch_json(f"{cogito_base.rstrip('/')}/health") or {}
            bridge_ready = bool(cogito_health.get("bridge", {}).get("ready")) if cogito_health else bridge is not None
            fhe_ready = bool(cogito_health.get("fhe", {}).get("ready")) if cogito_health else False
            fhe_live = bool(cogito_health.get("fhe", {}).get("live")) if cogito_health else False
            fhe_last_error = cogito_health.get("fhe", {}).get("lastError") if cogito_health else None
            zg_storage_ready = bool(cogito_health.get("storage", {}).get("ok")) if cogito_health else False
            zg_compute_ready = bool(cogito_health.get("compute", {}).get("ok")) if cogito_health else False
            gateway_balance = cogito_health.get("gateway", {}).get("treasuryBalance")
            gateway_balances = cogito_health.get("gateway", {}).get("balances") or []
            swarm_backend = os.environ.get("SWARM_BACKEND", "lite").strip().lower() or "lite"
            openclaw_enabled = _env_truthy("OPENCLAW_OPERATOR_ENABLED")
            openclaw_session = bool(os.environ.get("OPENCLAW_SESSION"))
            polymarket_chain_id = int(os.environ.get("POLYMARKET_CHAIN_ID", "137") or "137")
            hook_ready = hook is not None
            treasury_key_ready = bool(os.environ.get("TREASURY_PRIVATE_KEY"))
            polymarket_key_ready = bool(os.environ.get("POLYMARKET_PRIVATE_KEY"))
            burner_seed_ready = bool(os.environ.get("BURNER_SEED"))
            hook_address_ready = bool(os.environ.get("MERIDIAN_HOOK_ADDRESS"))
            arb_rpc_ready = bool(
                os.environ.get("ARB_SEPOLIA_RPC_URL")
                or os.environ.get("ARBITRUM_SEPOLIA_RPC_URL")
                or os.environ.get("BASE_SEPOLIA_RPC_URL")
                or os.environ.get("RPC_URL")
            )
            fhe_key_ready = bool(os.environ.get("FHE_PRIVATE_KEY") or os.environ.get("TREASURY_PRIVATE_KEY"))
            zg_key_ready = bool(os.environ.get("ZG_PRIVATE_KEY"))
            axl_ready = swarm_backend == "axl"
            direct_polygon_balance = _polygon_direct_balance(polygon_funding)
            direct_polygon_native_balance = _polygon_direct_native_balance(polygon_funding)

            gateway_seeded = gateway_balance not in (0, 0.0, "0", "0.0", None)
            polygon_direct_gas_ready = (
                direct_polygon_native_balance is not None and float(direct_polygon_native_balance) > 0
            )
            polygon_direct_usdc_ready = (
                direct_polygon_balance is not None and float(direct_polygon_balance) > 0
            )

            sponsors = [
                {
                    "key": "0g",
                    "label": "0G",
                    "ready": zg_storage_ready and zg_compute_ready,
                    "mode": "live" if zg_storage_ready and zg_compute_ready else "degraded",
                    "detail": "storage + compute anchoring for swarm runs",
                    "blocker": None if zg_storage_ready and zg_compute_ready else "set ZG_PRIVATE_KEY and fund Galileo ledger",
                },
                {
                    "key": "axl",
                    "label": "Gensyn AXL",
                    "ready": axl_ready,
                    "mode": swarm_backend,
                    "detail": "multi-agent mesh for swarm debate",
                    "blocker": None if axl_ready else "set SWARM_BACKEND=axl for cross-node swarm runs",
                },
                {
                    "key": "fhenix",
                    "label": "Fhenix CoFHE",
                    "ready": fhe_ready and fhe_live and hook_ready,
                    "mode": "live" if fhe_ready and fhe_live and hook_ready else "degraded",
                    "detail": "encrypted notional and payout handling",
                    "blocker": None if fhe_ready and fhe_live and hook_ready else (
                        f"cofhejs init/encrypt failing: {str(fhe_last_error)[:120]}"
                        if fhe_ready and hook_ready and fhe_last_error
                        else "configure FHE signer and deploy hook on Arbitrum Sepolia"
                    ),
                },
                {
                    "key": "uniswap",
                    "label": "Uniswap v4",
                    "ready": hook_ready and fhe_live,
                    "mode": "hook-live" if hook_ready and fhe_live else "hook-deployed" if hook_ready else "offline",
                    "detail": "PrivateSettlementHook settlement rail",
                    "blocker": None if hook_ready and fhe_live else (
                        "Fhenix encrypt leg is not live, so the settlement hook cannot fund positions end-to-end."
                        if hook_ready
                        else "set ARB_SEPOLIA_RPC_URL and MERIDIAN_HOOK_ADDRESS"
                    ),
                },
                {
                    "key": "circle",
                    "label": "Circle CCTP",
                    "ready": bridge_ready and treasury_key_ready and gateway_seeded,
                    "mode": "forwarder" if bridge_ready and treasury_key_ready and gateway_seeded else "degraded" if bridge_ready and treasury_key_ready else "offline",
                    "detail": "unified balance bridge between settlement and trading",
                    "blocker": (
                        None
                        if bridge_ready and treasury_key_ready and gateway_seeded
                        else "Gateway is not seeded, and the Polygon-first direct donor path is missing native gas."
                        if bridge_ready and treasury_key_ready and polygon_direct_usdc_ready and not polygon_direct_gas_ready
                        else "pre-seed Gateway balance so Circle forwarding can execute real cross-chain transfers"
                        if bridge_ready and treasury_key_ready
                        else "set TREASURY_PRIVATE_KEY and pre-seed Gateway balance"
                    ),
                },
                {
                    "key": "polymarket",
                    "label": "Polymarket",
                    "ready": polymarket_key_ready and polymarket_chain_id == 80002,
                    "mode": "live" if polymarket_key_ready and polymarket_chain_id == 80002 else "dry-run",
                    "detail": "real CLOB execution on Polygon Amoy",
                    "blocker": None if polymarket_key_ready and polymarket_chain_id == 80002 else "set POLYMARKET_PRIVATE_KEY and POLYMARKET_CHAIN_ID=80002",
                },
                {
                    "key": "openclaw",
                    "label": "OpenClaw",
                    "ready": openclaw_enabled or openclaw_session,
                    "mode": "attached" if openclaw_session else "enabled" if openclaw_enabled else "manual",
                    "detail": "24/7 human+AI operator automation lane",
                    "blocker": None if openclaw_enabled or openclaw_session else "set OPENCLAW_OPERATOR_ENABLED and wire an operator session",
                },
            ]

            next_blockers: list[str] = []
            if not burner_seed_ready:
                next_blockers.append("Set BURNER_SEED for deterministic per-position wallets.")
            if not polymarket_key_ready:
                next_blockers.append("Set POLYMARKET_PRIVATE_KEY for real Polymarket CLOB orders.")
            if polymarket_chain_id != 80002:
                next_blockers.append("Set POLYMARKET_CHAIN_ID=80002 for Polygon Amoy.")
            if not treasury_key_ready:
                next_blockers.append("Set TREASURY_PRIVATE_KEY for bridge burns and settlement calls.")
            if not hook_address_ready or not arb_rpc_ready:
                next_blockers.append("Set ARB_SEPOLIA_RPC_URL and MERIDIAN_HOOK_ADDRESS for the Uniswap/Fhenix settlement rail.")
            if bridge_ready and gateway_balance in (0, 0.0, "0", "0.0", None):
                next_blockers.append("Pre-seed the Circle Gateway treasury balance on Arbitrum Sepolia.")
            if polygon_direct_usdc_ready and not polygon_direct_gas_ready:
                next_blockers.append("Fund the Polygon Amoy treasury signer with native gas so the direct donor path can transfer USDC.")
            if fhe_ready and not fhe_live:
                next_blockers.append("Fix Fhenix/@cofhe/sdk initialization so /fhe/encrypt can mint a real InEuint128.")
            if not zg_key_ready:
                next_blockers.append("Set ZG_PRIVATE_KEY to enable 0G Storage and 0G Compute.")
            if not axl_ready:
                next_blockers.append("Set SWARM_BACKEND=axl so the swarm runs on the Gensyn mesh.")
            if not (openclaw_enabled or openclaw_session):
                next_blockers.append("Wire OpenClaw so the operator loop can run 24/7.")

            capital_plane = capital_mod.build_capital_snapshot(
                cfg=cfg,
                positions=records,
                cogito_health=cogito_health,
                direct_polygon_balance_usdc=direct_polygon_balance,
                direct_polygon_native_balance=direct_polygon_native_balance,
                keeperhub_ready=keeperhub is not None,
                openclaw_enabled=openclaw_enabled,
                openclaw_session=openclaw_session,
            )

            return jsonify({
                "service": "Miroshark operator",
                "status": "ok",
                "mode": "dry-run" if cfg.dry_run else "live",
                "interval_s": cfg.interval_s,
                "max_positions_per_cycle": cfg.max_positions_per_cycle,
                "strategies": cfg.strategies,
                "capital": {
                    "total_capital": float(cfg.total_capital),
                    "per_position_max": float(cfg.per_position_max),
                    "global_max_open_positions": cfg.global_max_open_positions,
                },
                "thresholds": {
                    "directional_min_edge_pp": cfg.min_edge_pp,
                    "directional_min_confidence": cfg.min_confidence,
                    "arb_min_edge_pp": cfg.min_arb_edge_pp,
                    "arb_min_score": cfg.min_arb_score,
                },
                "automation": {
                    "openclaw_enabled": openclaw_enabled,
                    "openclaw_session": openclaw_session,
                    "openclaw_operator": os.environ.get("OPENCLAW_OPERATOR_NAME") or None,
                    "kill_switch_enabled": bool(os.environ.get("EXECUTION_KILL_TOKEN")),
                },
                "sponsors": sponsors,
                "wallets": {
                    "burner_seed_ready": burner_seed_ready,
                    "treasury_key_ready": treasury_key_ready,
                    "polymarket_key_ready": polymarket_key_ready,
                    "fhe_key_ready": fhe_key_ready,
                    "zg_key_ready": zg_key_ready,
                    "hook_address_ready": hook_address_ready,
                    "settlement_rpc_ready": arb_rpc_ready,
                    "gateway_treasury_balance": gateway_balance,
                    "gateway_domain_balances": gateway_balances,
                    "direct_polygon_balance_usdc": direct_polygon_balance,
                    "direct_polygon_native_balance": direct_polygon_native_balance,
                },
                "capital_plane": capital_plane,
                "next_blockers": next_blockers,
            })
        except Exception as e:  # noqa: BLE001
            log.warning("operator status unavailable: %s", e)
            return jsonify({
                "service": "Miroshark operator",
                "status": "degraded",
                "error": str(e),
            }), 200

    @bp.get("/capital/status")
    def capital_status():
        try:
            from orchestrator.loop import LoopConfig

            cfg = LoopConfig.from_env()
            cogito_base = os.environ.get("COGITO_BASE_URL") or os.environ.get("COGITO_URL") or "http://127.0.0.1:5003"
            cogito_health = _fetch_json(f"{cogito_base.rstrip('/')}/health") or {}
            openclaw_enabled = _env_truthy("OPENCLAW_OPERATOR_ENABLED")
            openclaw_session = bool(os.environ.get("OPENCLAW_SESSION"))
            snapshot = capital_mod.build_capital_snapshot(
                cfg=cfg,
                positions=store.list(),
                cogito_health=cogito_health,
                direct_polygon_balance_usdc=_polygon_direct_balance(polygon_funding),
                direct_polygon_native_balance=_polygon_direct_native_balance(polygon_funding),
                keeperhub_ready=keeperhub is not None,
                openclaw_enabled=openclaw_enabled,
                openclaw_session=openclaw_session,
            )
            return jsonify({"status": "ok", "capital": snapshot})
        except Exception as e:  # noqa: BLE001
            log.warning("capital status unavailable: %s", e)
            return jsonify({"status": "degraded", "error": str(e)}), 200

    @bp.get("/terminal/ticker")
    def terminal_ticker_snapshot():
        force = request.args.get("force", "").strip().lower() in {"1", "true", "yes", "on"}
        try:
            return jsonify(terminal_ticker.snapshot(force=force))
        except Exception as e:  # noqa: BLE001
            log.warning("terminal ticker unavailable: %s", e)
            return jsonify({
                "headlines": [],
                "prices": [],
                "events": [],
                "tape": [],
                "updated_at": None,
                "error": str(e),
            }), 200

    @bp.get("/positions/stream")
    def positions_stream():
        # Subscribe BEFORE snapshotting so any concurrent upsert that races the
        # initial snapshot also lands in the queue (consumer dedupes by position_id).
        sub = store.subscribe()
        snapshot = [r.to_json() for r in store.list()]

        @stream_with_context
        def gen():
            try:
                yield f"event: snapshot\ndata: {json.dumps({'positions': snapshot})}\n\n"
                while True:
                    # 15s keepalive timeout — proxies (nginx, cloudflare) often
                    # drop idle SSE connections at 30-60s without one.
                    try:
                        msg = sub.get(timeout=15.0)
                    except queue.Empty:
                        yield ": keepalive\n\n"
                        continue
                    yield f"event: position\ndata: {json.dumps(msg)}\n\n"
            except GeneratorExit:
                # Client disconnected — clean shutdown of the subscription.
                pass
            finally:
                store.unsubscribe(sub)

        return Response(
            gen(),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "X-Accel-Buffering": "no",
                "Connection": "keep-alive",
            },
        )

    @bp.post("/kill")
    def kill_switch():
        """Manual operator kill — closes all open positions, halts further work.

        Bucket 3 of autonomous-fund-arb. Token-gated; if EXECUTION_KILL_TOKEN
        is unset the endpoint returns 503 (kill switch disabled). Marks each
        open position as `failed` with `error="killed"` and writes an audit
        entry per position. Does NOT call the bridge or hook — those would
        require operator-funded gas; killing is an off-chain accounting halt.
        """
        token_env = os.environ.get("EXECUTION_KILL_TOKEN")
        if not token_env:
            return jsonify({"error": "kill switch disabled — set EXECUTION_KILL_TOKEN to enable"}), 503
        provided = request.headers.get("X-Kill-Token")
        if provided != token_env:
            return Response(status=403)
        closed = 0
        errors: list[dict] = []
        for r in store.list():
            if r.status in ("settled", "failed"):
                continue
            try:
                prior_status = r.status
                r.status = "failed"
                r.error = "killed"
                store.upsert(r)
                _audit("kill.invoked", position_id=r.position_id, status="info",
                       payload={"prior_status": prior_status})
                closed += 1
            except Exception as e:  # noqa: BLE001
                errors.append({"position_id": r.position_id, "error": str(e)})
        return jsonify({"closed": closed, "errors": errors})

    @bp.get("/audit")
    def list_audit():
        try:
            limit = int(request.args.get("limit", 200))
        except ValueError:
            limit = 200
        position_id = request.args.get("position_id") or None
        try:
            events = audit.recent(limit=limit, position_id=position_id)
        except Exception as e:  # noqa: BLE001
            log.warning("audit.recent failed: %s", e)
            events = []
        return jsonify({"events": events})

    @bp.get("/audit/<position_id>")
    def audit_for_position(position_id: str):
        try:
            events = audit.recent(limit=1000, position_id=position_id)
        except Exception as e:  # noqa: BLE001
            log.warning("audit.recent(%s) failed: %s", position_id, e)
            events = []
        return jsonify({"position_id": position_id, "events": events})

    # ── Bucket 5: daily verifiable PnL attestation pack + public verifier ──
    #
    # `/api/execution/daily-pack/<date>/build` (POST) — generate the pack
    # for date, write to var/daily_packs/<date>.json, pin to 0G if cogito
    # is wired. Returns the pack envelope plus the pinning result so the
    # caller (cron, ops dashboard, demo) can record the root_hash.
    #
    # `/api/execution/daily-pack/<date>` (GET) — return the cached pack
    # envelope plus the most recent `daily_pack.pinned` audit entry for
    # that date so the verifier page can show {root_hash, tx_hash} without
    # rebuilding. If the pack hasn't been built yet, returns 404.
    #
    # `/verifier/<date>` and `/verifier` — static HTML page that fetches
    # the pack JSON and renders the proof table (per-position root_hashes,
    # chain explorer links, aggregate PnL).

    def _resolve_tenant_filter() -> tuple[str | None, tuple | None]:
        """Read ?tenant_id=… and validate. Returns (tenant_id, error_response)."""
        raw = request.args.get("tenant_id")
        if raw is None:
            return None, None
        if raw not in tenants:
            return None, (jsonify({
                "error": f"unknown tenant_id: {raw!r}",
                "known_tenants": tenants.ids(),
            }), 404)
        return raw, None

    @bp.post("/daily-pack/<date>/build")
    def daily_pack_build(date: str):
        tenant_filter, err = _resolve_tenant_filter()
        if err is not None:
            return err
        try:
            result = daily_pack.build_and_pin(date, tenant_id=tenant_filter)
        except ValueError as e:
            return jsonify({"error": f"bad date: {e}"}), 400
        except Exception as e:  # noqa: BLE001
            log.warning("daily_pack build %s failed: %s", date, e)
            return jsonify({"error": str(e)}), 500
        envelope_tenant = result.pack.get("tenant_id") or "default"
        pinned_payload: dict | None = None
        if result.pinned is not None:
            pinned_payload = {
                "root_hash": result.pinned.root_hash,
                "tx_hash": result.pinned.tx_hash,
                "size_bytes": result.pinned.size_bytes,
            }
            _audit("daily_pack.pinned", payload={
                "date": date,
                "tenant_id": envelope_tenant,
                "root_hash": result.pinned.root_hash,
                "tx_hash": result.pinned.tx_hash,
                "size_bytes": result.pinned.size_bytes,
                "n_positions": result.pack["aggregate"]["n_positions"],
            })
        else:
            _audit("daily_pack.built", status="info", payload={
                "date": date,
                "tenant_id": envelope_tenant,
                "n_positions": result.pack["aggregate"]["n_positions"],
                "pinned": False,
            })
        return jsonify({
            "pack": result.pack,
            "pinned": pinned_payload,
            "written_path": str(result.written_path) if result.written_path else None,
        })

    @bp.get("/daily-pack/<date>")
    def daily_pack_get(date: str):
        try:
            _ = (datetime.strptime(date, "%Y-%m-%d"))  # noqa: F841
        except ValueError:
            return jsonify({"error": "date must be YYYY-MM-DD"}), 400
        tenant_filter, err = _resolve_tenant_filter()
        if err is not None:
            return err
        cached = daily_pack.load_local(date, tenant_id=tenant_filter)
        if cached is None:
            hint = f"POST /daily-pack/{date}/build"
            if tenant_filter is not None:
                hint += f"?tenant_id={tenant_filter}"
            return jsonify({"error": f"no pack for {date}; {hint} first"}), 404
        pinned = daily_pack.latest_pin_for(date, tenant_id=tenant_filter)
        return jsonify({
            "pack": cached,
            "pinned": pinned,
            "explorer": {
                "arb_sepolia_tx": "https://sepolia.arbiscan.io/tx/",
                "polygon_amoy_tx": "https://amoy.polygonscan.com/tx/",
                "polymarket_market": "https://polymarket.com/market/",
                "cogito_download": (os.environ.get("COGITO_PUBLIC_BASE_URL")
                                    or os.environ.get("COGITO_BASE_URL")
                                    or "") + "/download/",
            },
        })

    @app.get("/verifier")
    def verifier_today():
        return send_from_directory(str(static_dir), "verifier.html")

    @app.get("/verifier/<date>")
    def verifier_date(date: str):  # noqa: ARG001 — date is read by JS from URL
        return send_from_directory(str(static_dir), "verifier.html")

    @app.get("/verifier/<tenant>/<date>")
    def verifier_tenant_date(tenant: str, date: str):  # noqa: ARG001
        # Tenant-scoped verifier URL — JS reads both segments from window.location.
        return send_from_directory(str(static_dir), "verifier.html")

    app.register_blueprint(bp)
    return app


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app()
    port = int(os.environ.get("EXECUTION_ROUTER_PORT", "5004"))
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
