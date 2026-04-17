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

from . import _dns_fallback, polymarket, seed, swarm

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
    t0 = time.perf_counter()
    out = swarm.run_swarm_lite(seed_doc=seed_doc, outcomes=market.outcomes)
    elapsed = time.perf_counter() - t0

    # Edge: pick the outcome where swarm probability deviates most from market price.
    edges: list[tuple[str, float, float, float]] = []  # (outcome, swarm_p, market_p, edge_pp)
    for outcome, market_p in zip(market.outcomes, market.outcome_prices):
        swarm_p = out.swarm_prediction.get(outcome, 0.0)
        edges.append((outcome, swarm_p, market_p, (swarm_p - market_p) * 100.0))
    edges.sort(key=lambda x: abs(x[3]), reverse=True)
    best = edges[0] if edges else None

    return jsonify({
        "run_id": str(uuid.uuid4()),
        "market_id": market.market_id,
        "slug": market.slug,
        "question": market.question,
        "outcomes": market.outcomes,
        "market_prices": market.outcome_prices,
        "swarm_prediction": out.swarm_prediction,
        "confidence": out.confidence,
        "reasoning": out.reasoning,
        "key_factors": out.key_factors,
        "contributing_agents": out.contributing_agents,
        "edge": {
            "outcome": best[0],
            "swarm_probability": best[1],
            "market_probability": best[2],
            "edge_pp": best[3],            # percentage points
        } if best else None,
        "phase": out.phase,
        "model": out.model,
        "elapsed_s": round(elapsed, 2),
        # Hashes (Phase 3 will populate from 0G):
        "seed_hash_0g": None,
        "simulation_hash_0g": None,
    })


def create_app() -> Flask:
    # Load env from meridian-core/.env (one level up from services/)
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    app = Flask(__name__)
    CORS(app, resources={r"/api/*": {"origins": "*"}})

    @app.get("/health")
    def health():
        return {"service": "MERIDIAN signal-gateway", "status": "ok", "phase": "1"}

    app.register_blueprint(signal_bp)
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
