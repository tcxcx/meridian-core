"""Flask blueprint + standalone app for /api/signal/*.

Routes (Phase 1):
    GET  /health                          → liveness
    POST /api/signal/markets/scan         → discover Polymarket markets
    POST /api/signal/run { market_id }    → run swarm-lite, return signal

Routes (later phases):
    GET  /api/signal/run/{run_id}         → poll long-running runs (Phase 2+)
    POST /api/signal/execute              → kick off execution-router (Phase 4)
"""
from __future__ import annotations

import logging
import os
import time
import uuid
from pathlib import Path

from dotenv import load_dotenv
from flask import Blueprint, Flask, jsonify, request
from flask_cors import CORS

from . import _dns_fallback, cryo, entropy, matcher, polymarket, seed, swarm, topology, zg_client

_dns_fallback.install()

log = logging.getLogger("meridian.signal")

signal_bp = Blueprint("meridian_signal", __name__, url_prefix="/api/signal")


@signal_bp.post("/markets/scan")
def scan_markets():
    body = request.get_json(silent=True) or {}
    limit = int(body.get("limit", 10))
    min_liq = float(body.get("min_liquidity_usd", 5000.0))
    markets = polymarket.discover_markets(limit=limit, min_liquidity_usd=min_liq)
    return jsonify({
        "count": len(markets),
        "markets": [
            {
                "market_id": m.market_id,
                "slug": m.slug,
                "question": m.question,
                "end_date": m.end_date_iso,
                "liquidity_usd": m.liquidity_usd,
                "volume_usd": m.volume_usd,
                "outcomes": m.outcomes,
                "outcome_prices": m.outcome_prices,
                "token_ids": m.token_ids,
            }
            for m in markets
        ],
    })


@signal_bp.post("/run")
def run_signal():
    body = request.get_json(silent=True) or {}
    market_id = body.get("market_id")
    if not market_id:
        return jsonify({"error": "market_id required"}), 400

    market = polymarket.get_market(market_id)
    if market is None:
        return jsonify({"error": f"market not found: {market_id}"}), 404

    seed_doc = seed.build_seed_document(market)
    run_id = str(uuid.uuid4())

    # Phase 3: pin seed_doc to 0G Storage (best-effort — null on failure).
    cogito = zg_client.get_client()
    seed_pin = None
    if zg_client.is_enabled():
        try:
            seed_pin = cogito.upload(
                kind="seed",
                payload={"market_id": market.market_id, "slug": market.slug, "seed_doc": seed_doc},
                meta={"run_id": run_id},
            )
        except zg_client.CogitoError as e:
            log.warning("seed pin failed: %s", e)

    t0 = time.perf_counter()
    out = swarm.run(seed_doc=seed_doc, outcomes=market.outcomes, market_id=market.market_id)
    elapsed = time.perf_counter() - t0

    # Edge: pick the outcome where swarm probability deviates most from market price.
    edges: list[tuple[str, float, float, float]] = []  # (outcome, swarm_p, market_p, edge_pp)
    for outcome, market_p in zip(market.outcomes, market.outcome_prices):
        swarm_p = out.swarm_prediction.get(outcome, 0.0)
        edges.append((outcome, swarm_p, market_p, (swarm_p - market_p) * 100.0))
    edges.sort(key=lambda x: abs(x[3]), reverse=True)
    best = edges[0] if edges else None

    # E-01: read entropy on the leading-edge outcome. Tier biases confidence.
    entropy_reading = None
    confidence_adj = float(out.confidence)
    if best is not None and market.token_ids:
        try:
            idx = market.outcomes.index(best[0])
        except ValueError:
            idx = 0
        if idx < len(market.token_ids):
            try:
                entropy_reading = entropy.read(market.token_ids[idx])
                confidence_adj = round(min(1.0, max(0.0, confidence_adj * entropy.confidence_bias(entropy_reading.tier))), 4)
            except Exception as e:  # noqa: BLE001 — never fail the run on signal-side error
                log.warning("entropy read failed for %s: %s", market.market_id, e)

    # Phase 3: pin the simulation envelope to 0G Storage.
    sim_pin = None
    if zg_client.is_enabled():
        try:
            sim_pin = cogito.upload(
                kind="simulation",
                payload={
                    "run_id": run_id,
                    "market": {
                        "market_id": market.market_id,
                        "slug": market.slug,
                        "question": market.question,
                        "outcomes": market.outcomes,
                        "market_prices": market.outcome_prices,
                    },
                    "swarm_prediction": out.swarm_prediction,
                    "confidence": out.confidence,
                    "reasoning": out.reasoning,
                    "key_factors": out.key_factors,
                    "contributing_agents": out.contributing_agents,
                    "phase": out.phase,
                    "model": out.model,
                    "elapsed_s": round(elapsed, 2),
                    "seed_hash_0g": seed_pin.root_hash if seed_pin else None,
                    "attestation_envelope": out.attestation_envelope,
                },
                meta={"run_id": run_id, "seed_hash_0g": seed_pin.root_hash if seed_pin else None},
            )
        except zg_client.CogitoError as e:
            log.warning("simulation pin failed: %s", e)

    return jsonify({
        "run_id": run_id,
        "market_id": market.market_id,
        "slug": market.slug,
        "question": market.question,
        "outcomes": market.outcomes,
        "market_prices": market.outcome_prices,
        "swarm_prediction": out.swarm_prediction,
        "confidence": out.confidence,
        "confidence_adjusted": confidence_adj,
        "reasoning": out.reasoning,
        "key_factors": out.key_factors,
        "contributing_agents": out.contributing_agents,
        "edge": {
            "outcome": best[0],
            "swarm_probability": best[1],
            "market_probability": best[2],
            "edge_pp": best[3],            # percentage points
        } if best else None,
        "signals": {
            "entropy": entropy_reading.to_dict() if entropy_reading else None,
        },
        "phase": out.phase,
        "model": out.model,
        "elapsed_s": round(elapsed, 2),
        "seed_hash_0g": seed_pin.root_hash if seed_pin else None,
        "seed_tx_0g": seed_pin.tx_hash if seed_pin else None,
        "simulation_hash_0g": sim_pin.root_hash if sim_pin else None,
        "simulation_tx_0g": sim_pin.tx_hash if sim_pin else None,
        "attestation_envelope": out.attestation_envelope,
    })


@signal_bp.get("/entropy")
def entropy_route():
    token_id = request.args.get("token_id")
    if not token_id:
        return jsonify({"error": "token_id required"}), 400
    try:
        reading = entropy.read(token_id)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e)}), 502
    return jsonify(reading.to_dict())


@signal_bp.get("/cryo")
def cryo_route():
    limit = int(request.args.get("limit", 10))
    min_liq = float(request.args.get("min_liquidity_usd", 5_000.0))
    rows = cryo.scan(limit=limit, min_liquidity_usd=min_liq)
    counts = {0: 0, 1: 0, 2: 0}
    for r in rows:
        counts[r.tier] = counts.get(r.tier, 0) + 1
    latched = sum(1 for r in rows if r.latched)
    return jsonify({
        "count": len(rows),
        "tier_counts": {f"tier_{k}": v for k, v in counts.items()},
        "latched": latched,
        "rows": [r.to_dict() for r in rows],
        "stats": cryo.stats(),
    })


@signal_bp.get("/topology")
def topology_route():
    """T-03 · cross-market coordination edges + clusters.

    Each call refreshes the rolling mid-price history per token, then
    recomputes pairwise Pearson correlation on log returns. With <
    MIN_HISTORY samples per token we return cold-start (edges=[]) and
    just thicken history.
    """
    limit = int(request.args.get("limit", 10))
    min_liq = float(request.args.get("min_liquidity_usd", 5_000.0))
    try:
        out = topology.scan(limit=limit, min_liquidity_usd=min_liq)
    except Exception as e:  # noqa: BLE001 — never fail the dashboard on signal-side glitches
        return jsonify({"error": str(e)}), 502
    return jsonify(out)


@signal_bp.get("/topology/correlated")
def topology_correlated_route():
    token_id = request.args.get("token_id")
    if not token_id:
        return jsonify({"error": "token_id required"}), 400
    threshold = float(request.args.get("threshold", topology.R_LATCH))
    return jsonify({
        "token_id": token_id,
        "threshold": threshold,
        "correlated": topology.correlated_with(token_id, threshold=threshold),
    })


@signal_bp.get("/arb/pairs")
def arb_pairs_route():
    """Bucket 2 — discover Polymarket↔Kalshi pairs with implied YES-price gap.

    Cheap to call repeatedly; the matcher caches in-process for ~30s.
    """
    poly_limit = int(request.args.get("poly_limit", 20))
    poly_min_liq = float(request.args.get("poly_min_liquidity_usd", 5_000.0))
    kalshi_limit = int(request.args.get("kalshi_limit", 50))
    kalshi_min_vol = float(request.args.get("kalshi_min_volume_24h", 1_000.0))
    min_score = float(request.args.get("min_score", matcher.DEFAULT_MIN_SCORE))
    pairs = matcher.discover_pairs(
        poly_limit=poly_limit,
        poly_min_liquidity_usd=poly_min_liq,
        kalshi_limit=kalshi_limit,
        kalshi_min_volume_24h=kalshi_min_vol,
        min_score=min_score,
    )
    return jsonify({
        "count": len(pairs),
        "pairs": [p.to_dict() for p in pairs],
    })


@signal_bp.get("/runs/<root_hash>")
def fetch_run(root_hash: str):
    """Pull back a previously-pinned simulation payload from 0G by merkle root.

    Demo bar (per BUILD_PLAN Phase 3): show a run → capture hash → re-read
    the run from 0G → prove reproducibility.
    """
    try:
        envelope = zg_client.get_client().download(root_hash)
    except zg_client.CogitoError as e:
        return jsonify({"error": str(e)}), 502
    return jsonify(envelope)


def create_app() -> Flask:
    # Load env from meridian-core/.env (one level up from services/)
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    app = Flask(__name__)
    # Dashboard at execution-router :5004 polls signal-gateway across origins.
    # Allow all routes (including /health) for testnet/hackathon scope.
    CORS(app, origins="*")

    @app.get("/health")
    def health():
        zg_status = zg_client.get_client().health()
        return {
            "service": "MERIDIAN signal-gateway",
            "status": "ok",
            "phase": "3",
            "zg_anchor": zg_status,
        }

    app.register_blueprint(signal_bp)
    from .sse import sse_bp  # lazy: pulls in swarm_runner only when registered
    app.register_blueprint(sse_bp)
    return app


def main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app()
    port = int(os.environ.get("SIGNAL_GATEWAY_PORT", "5002"))
    app.run(host="0.0.0.0", port=port, debug=False)


if __name__ == "__main__":
    main()
