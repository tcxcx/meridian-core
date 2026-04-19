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
from pathlib import Path

from dotenv import load_dotenv
from flask import Blueprint, Flask, Response, jsonify, request, send_from_directory, stream_with_context
from flask_cors import CORS

import time as _time

from . import attestation as attestation_mod
from . import audit as audit_mod
from . import bridge_client as bridge_mod
from . import burner as burner_mod
from . import clob_client, encryptor, hook_client
from . import keeperhub as keeperhub_mod
from .encryptor import SealedInput
from .store import PositionRecord, PositionStore

log = logging.getLogger("meridian.execution.api")


def _to_uint128_amount(usdc_amount: float, decimals: int = 6) -> int:
    return int(round(usdc_amount * (10**decimals)))


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
        return send_from_directory(str(static_dir), "dashboard.html")

    store = PositionStore()
    audit = audit_mod.from_env()
    factory = burner_mod.from_env()
    enc = encryptor.from_env()
    keeperhub = keeperhub_mod.from_env()
    hook = hook_client.from_env(encryptor=enc, keeperhub=keeperhub)
    bridge = bridge_mod.from_env()
    pinner = attestation_mod.from_env()  # Bucket 4: per-position 0G attestation

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

    bp = Blueprint("meridian_execution", __name__, url_prefix="/api/execution")

    @app.get("/health")
    def health():
        return {
            "service": "MERIDIAN execution-router",
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
                "attestation": pinner is not None,
            },
            "chains": {
                "settlement": settlement_chain,
                "trading": trading_chain,
            },
            "positions": len(store.list()),
        }

    @bp.post("/open")
    def open_position():
        body = request.get_json(silent=True) or {}
        position_id = body.get("position_id")
        market_id = body.get("market_id")
        token_id = body.get("token_id")
        side = (body.get("side") or "BUY").upper()
        usdc_amount = body.get("usdc_amount")
        strategy = body.get("strategy") or "directional"
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

        # Per-strategy sub-account (Bucket 4): same position_id under
        # different strategies derives to different burners.
        burner = factory.derive(position_id, strategy_id=strategy)
        amount_uint128 = _to_uint128_amount(float(usdc_amount))

        record = PositionRecord(
            position_id=position_id,
            market_id=market_id,
            token_id=token_id,
            side="BUY" if side == "BUY" else "SELL",
            usdc_amount=float(usdc_amount),
            burner_address=burner.address,
            strategy=strategy,
        )
        store.upsert(record)
        _audit("open.received", position_id=position_id, payload={
            "market_id": market_id, "token_id": token_id,
            "side": side, "usdc_amount": float(usdc_amount),
            "burner_address": burner.address,
            "strategy": strategy,
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
            record.error = f"bridge send: {e}"
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

    @bp.post("/resolve")
    def resolve_position():
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
            factory.derive(position_id, strategy_id=record.strategy)
            if factory is not None else None
        )
        if burner_obj is not None and float(payout_usdc) > 0:
            try:
                dep_result = bridge.deposit(
                    chain=trading_chain,
                    amount_usdc=float(payout_usdc),
                    signer="burner",
                    burner_private_key=burner_obj.private_key,
                )
                record.gateway_deposit_approve_tx = dep_result.approve_tx
                record.gateway_deposit_tx = dep_result.deposit_tx
                if not dep_result.ok:
                    record.status = "failed"
                    record.error = f"gateway deposit failed: {dep_result.state}"
                    store.upsert(record)
                    _audit("gateway_deposit.err", position_id=position_id, status="err",
                           payload={"state": dep_result.state})
                    return jsonify({"error": record.error, "position": record.to_json()}), 502
                _audit("gateway_deposit.ok", position_id=position_id, payload={
                    "chain": trading_chain, "amount": float(payout_usdc),
                    "approve_tx": dep_result.approve_tx, "deposit_tx": dep_result.deposit_tx,
                    "dry_run": dep_result.dry_run,
                })
            except Exception as e:  # noqa: BLE001
                record.status = "failed"
                record.error = f"gateway deposit: {e}"
                store.upsert(record)
                _audit("gateway_deposit.err", position_id=position_id, status="err",
                       payload={"error": str(e)})
                return jsonify({"error": record.error, "position": record.to_json()}), 502

            try:
                recv_result = bridge.bridge(
                    signer="burner",
                    burner_private_key=burner_obj.private_key,
                    from_chain=trading_chain,
                    to_chain=settlement_chain,
                    amount_usdc=float(payout_usdc),
                    recipient=treasury_address,
                    use_forwarder=True,
                )
                record.bridge_recv_burn_tx = recv_result.burn_tx
                record.bridge_recv_mint_tx = recv_result.mint_tx
                if not recv_result.ok:
                    record.status = "failed"
                    record.error = f"bridge recv failed: {recv_result.state}"
                    store.upsert(record)
                    _audit("bridge_recv.err", position_id=position_id, status="err", payload={
                        "state": recv_result.state, "transfer_id": recv_result.transfer_id,
                    })
                    return jsonify({"error": record.error, "position": record.to_json()}), 502
                _audit("bridge_recv.ok", position_id=position_id, payload={
                    "from": trading_chain, "to": settlement_chain,
                    "amount": float(payout_usdc),
                    "transfer_id": recv_result.transfer_id,
                    "burn_tx": recv_result.burn_tx, "mint_tx": recv_result.mint_tx,
                    "dry_run": recv_result.dry_run,
                })
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
                pin = pinner.pin(envelope, meta={"position_id": position_id, "strategy": record.strategy})
                _audit("attestation.pinned", position_id=position_id, payload={
                    "root_hash": pin.root_hash, "tx_hash": pin.tx_hash, "size_bytes": pin.size_bytes,
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
        return jsonify({"positions": [r.to_json() for r in store.list()]})

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
                r.status = "failed"
                r.error = "killed"
                store.upsert(r)
                _audit("kill.invoked", position_id=r.position_id, status="info",
                       payload={"prior_status": r.status})
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
