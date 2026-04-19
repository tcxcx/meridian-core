"""Seed one fully-walked synthetic position so the dashboard's ACT 3
timeline has demo content without requiring funded testnet wallets.

Walks the same state machine `/api/execution/open` + `/api/execution/resolve`
do, but uses the dry-run sidecar fallbacks (DryRunBridgeClient,
DryRunEncryptor, synthetic CLOB order id) so it runs offline.

Run from the repo root:

    cd services
    uv run python -m execution_router.scripts.seed_demo_position

After seeding, restart the execution-router so its in-memory cache
hydrates the new row from `var/positions.db`.
"""
from __future__ import annotations

import logging
import os
import secrets
import time
import uuid

from .. import audit as audit_mod
from .. import bridge_client as bridge_mod
from .. import burner as burner_mod
from ..clob_client import _synthetic_order_id
from ..store import PositionRecord, PositionStore

log = logging.getLogger("seed_demo_position")


def _to_uint128(usdc: float) -> int:
    return int(round(usdc * 10**6))


def _seed_burner_if_missing() -> None:
    if os.environ.get("BURNER_SEED"):
        return
    os.environ["BURNER_SEED"] = "0x" + secrets.token_hex(32)
    log.warning("BURNER_SEED not set; using ephemeral seed for this seeder run only")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

    _seed_burner_if_missing()
    factory = burner_mod.from_env()
    if factory is None:
        raise SystemExit("BURNER_SEED unavailable; cannot derive burner")

    store = PositionStore()
    audit = audit_mod.from_env()
    bridge = bridge_mod.DryRunBridgeClient()

    position_id = str(uuid.uuid4())
    market_id = "0x4d4849b09d4ad7c4ce18ddae6e6c4d4849b09d4ad7c4ce18ddae6e6c4d4849b"
    token_id = "21742633143463906290569050155826241533067272736897614950488156847949938836455"
    side = "BUY"
    usdc_amount = 5.0
    burner = factory.derive(position_id)
    settlement_chain = "arbitrum_sepolia"
    trading_chain = "polygon_amoy"

    log.info("seeding position_id=%s burner=%s", position_id, burner.address)

    record = PositionRecord(
        position_id=position_id,
        market_id=market_id,
        token_id=token_id,
        side=side,
        usdc_amount=usdc_amount,
        burner_address=burner.address,
        status="funding",
    )
    store.upsert(record)
    audit.log("open.received", position_id=position_id, payload={
        "market_id": market_id, "token_id": token_id,
        "side": side, "usdc_amount": usdc_amount,
        "burner_address": burner.address,
    })
    time.sleep(0.05)

    fund_tx = "0x" + secrets.token_hex(32)
    record.fund_tx = fund_tx
    store.upsert(record)
    audit.log("fund_burner.ok", position_id=position_id, payload={
        "tx": fund_tx,
        "execution_id": None,
        "amount_uint128": _to_uint128(usdc_amount),
        "note": "demo seed (DryRunEncryptor)",
    })
    time.sleep(0.05)

    send = bridge.bridge(
        signer="treasury",
        from_chain=settlement_chain,
        to_chain=trading_chain,
        amount_usdc=usdc_amount,
        recipient=burner.address,
    )
    record.bridge_send_burn_tx = send.burn_tx
    record.bridge_send_mint_tx = send.mint_tx
    store.upsert(record)
    audit.log("bridge_send.ok", position_id=position_id, payload={
        "from": settlement_chain, "to": trading_chain,
        "amount": usdc_amount,
        "transfer_id": send.transfer_id,
        "burn_tx": send.burn_tx, "mint_tx": send.mint_tx,
        "dry_run": True,
    })
    time.sleep(0.05)

    clob_order_id = _synthetic_order_id(burner.address, token_id, side, usdc_amount)
    record.clob_order_id = clob_order_id
    record.status = "open"
    store.upsert(record)
    audit.log("clob_submit.ok", position_id=position_id, payload={
        "order_id": clob_order_id, "status": "dry_run",
        "token_id": token_id, "side": side, "amount": usdc_amount,
    })
    audit.log("open.ok", position_id=position_id, payload={
        "clob_order_id": clob_order_id, "clob_status": "dry_run",
    })
    time.sleep(0.05)

    payout_usdc = 9.7
    record.status = "resolving"
    record.payout_usdc = payout_usdc
    store.upsert(record)
    audit.log("resolve.received", position_id=position_id, payload={"payout_usdc": payout_usdc})
    time.sleep(0.05)

    deposit = bridge.deposit(chain=trading_chain, amount_usdc=payout_usdc, signer="burner",
                             burner_private_key=burner.private_key)
    record.gateway_deposit_approve_tx = deposit.approve_tx
    record.gateway_deposit_tx = deposit.deposit_tx
    store.upsert(record)
    audit.log("gateway_deposit.ok", position_id=position_id, payload={
        "chain": trading_chain, "amount": payout_usdc,
        "approve_tx": deposit.approve_tx, "deposit_tx": deposit.deposit_tx,
        "dry_run": True,
    })
    time.sleep(0.05)

    recv = bridge.bridge(
        signer="burner",
        burner_private_key=burner.private_key,
        from_chain=trading_chain,
        to_chain=settlement_chain,
        amount_usdc=payout_usdc,
        recipient="0xTREASURY_DEMO_SEED",
    )
    record.bridge_recv_burn_tx = recv.burn_tx
    record.bridge_recv_mint_tx = recv.mint_tx
    store.upsert(record)
    audit.log("bridge_recv.ok", position_id=position_id, payload={
        "from": trading_chain, "to": settlement_chain,
        "amount": payout_usdc,
        "transfer_id": recv.transfer_id,
        "burn_tx": recv.burn_tx, "mint_tx": recv.mint_tx,
        "dry_run": True,
    })
    time.sleep(0.05)

    resolve_tx = "0x" + secrets.token_hex(32)
    settle_tx = "0x" + secrets.token_hex(32)
    record.resolve_tx = resolve_tx
    record.settle_tx = settle_tx
    record.status = "settled"
    store.upsert(record)
    audit.log("mark_resolved.ok", position_id=position_id, payload={
        "tx": resolve_tx,
        "execution_id": None,
        "payout_uint128": _to_uint128(payout_usdc),
    })
    audit.log("settle.ok", position_id=position_id, payload={
        "tx": settle_tx,
        "execution_id": None,
    })
    audit.log("settled.ok", position_id=position_id, payload={
        "resolve_tx": resolve_tx, "settle_tx": settle_tx,
        "payout_usdc": payout_usdc,
    })

    print(f"\nseeded position_id={position_id} status=settled payout={payout_usdc}")
    print("restart the execution-router so its in-memory cache hydrates the row.")


if __name__ == "__main__":
    main()
