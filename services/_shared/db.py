"""Best-effort write-through to the Neon Postgres projection.

Python services keep their canonical in-memory + JSONL state. This module
mirrors every state change to the same DB the Next.js operator-terminal
reads from, so the lean console renders persisted data on boot/refresh
without proxying through the Python services.

Design rules:
- Sync (psycopg3 default) — these writes happen inside request handlers
  that are already synchronous. Async would mean fanning out to a thread.
- Connection pooled per process via a module-level ConnectionPool.
- BEST-EFFORT: every write is wrapped in try/except. DB unavailable means
  log a warning and move on; never break the request flow.
- Idempotent: positions + treasury transfers are upserts (PRIMARY KEY).
  Audit + swarm runs are appends (BIGSERIAL).
- No DDL here — schema is owned by @repo/database/index.js ensureTables().
  We assume the Next.js app has booted at least once before Python writes,
  which is true in dev (operator opens the page) and in prod (Next.js
  deploys first). If it hasn't, writes silently fail and JSONL still works.
"""
from __future__ import annotations

import json
import logging
import os
import threading
from typing import Any, Optional

log = logging.getLogger(__name__)

_POOL = None
_POOL_LOCK = threading.Lock()
_DISABLED = False


def _resolve_dsn() -> Optional[str]:
    # Try the most-specific first, fall back through next-forge / Neon defaults.
    for key in (
        "DATABASE_URL",
        "POSTGRES_URL",
        "POSTGRES_PRISMA_URL",
        "POSTGRES_URL_NON_POOLING",
    ):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return None


def _pool():
    """Lazy-init a psycopg3 ConnectionPool. Returns None if unavailable."""
    global _POOL, _DISABLED
    if _DISABLED:
        return None
    if _POOL is not None:
        return _POOL
    with _POOL_LOCK:
        if _POOL is not None:
            return _POOL
        dsn = _resolve_dsn()
        if not dsn:
            log.info("db_writer: no DATABASE_URL set — write-through disabled")
            _DISABLED = True
            return None
        try:
            from psycopg_pool import ConnectionPool
            _POOL = ConnectionPool(conninfo=dsn, min_size=0, max_size=4, open=True, timeout=5)
            log.info("db_writer: pool initialised")
        except Exception as e:  # noqa: BLE001
            log.warning("db_writer: pool init failed (%s) — disabling write-through", e)
            _DISABLED = True
            return None
    return _POOL


def _exec(sql: str, params: tuple) -> bool:
    pool = _pool()
    if pool is None:
        return False
    try:
        with pool.connection() as conn:
            with conn.cursor() as cur:
                cur.execute(sql, params)
        return True
    except Exception as e:  # noqa: BLE001
        log.warning("db_writer: query failed: %s", e)
        return False


def write_position(record: Any) -> bool:
    """Upsert a position row. Accepts either a dict or a PositionRecord-like
    object (anything with the same field names)."""
    r = _to_dict(record)
    if not r.get("position_id"):
        return False
    sql = """
    INSERT INTO miroshark_position
      (position_id, tenant_id, market_id, token_id, question, side, outcome,
       usdc_amount, status, strategy, burner_address, fund_tx,
       bridge_send_burn_tx, bridge_send_mint_tx, clob_order_id,
       gateway_deposit_tx, bridge_recv_burn_tx, bridge_recv_mint_tx,
       resolve_tx, settle_tx, payout_usdc, opened_by, error, extra,
       created_at, updated_at)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,
            COALESCE(to_timestamp(%s), NOW()), NOW())
    ON CONFLICT (position_id) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       market_id = EXCLUDED.market_id,
       token_id = EXCLUDED.token_id,
       question = EXCLUDED.question,
       side = EXCLUDED.side,
       outcome = EXCLUDED.outcome,
       usdc_amount = EXCLUDED.usdc_amount,
       status = EXCLUDED.status,
       strategy = EXCLUDED.strategy,
       burner_address = EXCLUDED.burner_address,
       fund_tx = EXCLUDED.fund_tx,
       bridge_send_burn_tx = EXCLUDED.bridge_send_burn_tx,
       bridge_send_mint_tx = EXCLUDED.bridge_send_mint_tx,
       clob_order_id = EXCLUDED.clob_order_id,
       gateway_deposit_tx = EXCLUDED.gateway_deposit_tx,
       bridge_recv_burn_tx = EXCLUDED.bridge_recv_burn_tx,
       bridge_recv_mint_tx = EXCLUDED.bridge_recv_mint_tx,
       resolve_tx = EXCLUDED.resolve_tx,
       settle_tx = EXCLUDED.settle_tx,
       payout_usdc = EXCLUDED.payout_usdc,
       opened_by = EXCLUDED.opened_by,
       error = EXCLUDED.error,
       extra = EXCLUDED.extra,
       updated_at = NOW();
    """
    return _exec(sql, (
        r.get("position_id"), r.get("tenant_id") or "default",
        r.get("market_id"), r.get("token_id"),
        r.get("question"), r.get("side"), r.get("outcome"),
        _num(r.get("usdc_amount")), r.get("status"), r.get("strategy"),
        r.get("burner_address"), r.get("fund_tx"),
        r.get("bridge_send_burn_tx"), r.get("bridge_send_mint_tx"),
        r.get("clob_order_id"), r.get("gateway_deposit_tx"),
        r.get("bridge_recv_burn_tx"), r.get("bridge_recv_mint_tx"),
        r.get("resolve_tx"), r.get("settle_tx"),
        _num(r.get("payout_usdc")) if r.get("payout_usdc") is not None else None,
        r.get("opened_by"), r.get("error"),
        json.dumps(r.get("extra") or {}),
        _num(r.get("created_at")) if r.get("created_at") else None,
    ))


def write_audit(*, event: str, position_id: Optional[str] = None,
                tenant_id: Optional[str] = None, status: str = "ok",
                payload: Optional[dict] = None, ts: Optional[float] = None) -> bool:
    sql = """
    INSERT INTO miroshark_audit_event
      (position_id, tenant_id, event, status, payload, ts)
    VALUES (%s, %s, %s, %s, %s::jsonb, COALESCE(to_timestamp(%s), NOW()));
    """
    return _exec(sql, (
        position_id, tenant_id or "default", event, status,
        json.dumps(payload or {}), _num(ts),
    ))


def write_swarm_run(*, market_id: str, tenant_id: Optional[str] = None,
                    question: Optional[str] = None, phase: Optional[str] = None,
                    edge: Optional[dict] = None, consensus: Optional[dict] = None,
                    confidence: Optional[float] = None, raw_confidence: Optional[float] = None,
                    agreement_score: Optional[float] = None,
                    signals: Optional[dict] = None, signals_diagnostic: Optional[dict] = None,
                    reasoning: Optional[str] = None, key_factors: Optional[list] = None,
                    minority_report: Optional[dict] = None, zg_root: Optional[str] = None) -> bool:
    sql = """
    INSERT INTO miroshark_swarm_run
      (market_id, tenant_id, question, phase, edge, consensus,
       confidence, raw_confidence, agreement_score,
       signals, signals_diagnostic, reasoning, key_factors,
       minority_report, zg_root, ts)
    VALUES (%s, %s, %s, %s, %s::jsonb, %s::jsonb,
            %s, %s, %s,
            %s::jsonb, %s::jsonb, %s, %s::jsonb,
            %s::jsonb, %s, NOW());
    """
    return _exec(sql, (
        market_id, tenant_id, question, phase,
        json.dumps(edge or {}), json.dumps(consensus or {}),
        _num(confidence), _num(raw_confidence), _num(agreement_score),
        json.dumps(signals or {}), json.dumps(signals_diagnostic or {}),
        reasoning, json.dumps(key_factors or []),
        json.dumps(minority_report) if minority_report else None,
        zg_root,
    ))


def write_treasury_transfer(record: Any) -> bool:
    r = _to_dict(record)
    if not r.get("transfer_id"):
        return False
    # Convert dataclass signers (TransferSigner objects) to dicts
    signers = r.get("signers") or []
    signers_dicts = [_to_dict(s) for s in signers]
    sql = """
    INSERT INTO miroshark_treasury_transfer
      (transfer_id, tenant_id, amount_usdc, chain, threshold, signers,
       initiator, status, tx_hash, error, notified, created_at, updated_at)
    VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s, %s, %s,
            COALESCE(to_timestamp(%s), NOW()), NOW())
    ON CONFLICT (transfer_id) DO UPDATE SET
      tenant_id = EXCLUDED.tenant_id,
      amount_usdc = EXCLUDED.amount_usdc,
      chain = EXCLUDED.chain,
      threshold = EXCLUDED.threshold,
      signers = EXCLUDED.signers,
      initiator = EXCLUDED.initiator,
      status = EXCLUDED.status,
      tx_hash = EXCLUDED.tx_hash,
      error = EXCLUDED.error,
      notified = EXCLUDED.notified,
      updated_at = NOW();
    """
    return _exec(sql, (
        r.get("transfer_id"), r.get("tenant_id") or "default",
        _num(r.get("amount_usdc")), r.get("chain"),
        int(r.get("threshold") or 1),
        json.dumps(signers_dicts),
        r.get("initiator"), r.get("status") or "pending",
        r.get("tx_hash"), r.get("error"), bool(r.get("notified")),
        _num(r.get("created_at")) if r.get("created_at") else None,
    ))


def _num(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _to_dict(record):
    """Accept dict-or-dataclass-or-object. Return a dict of attributes."""
    if record is None:
        return {}
    if isinstance(record, dict):
        return record
    # dataclass or simple object
    if hasattr(record, "__dict__"):
        return {k: v for k, v in record.__dict__.items() if not k.startswith("_")}
    return {}
