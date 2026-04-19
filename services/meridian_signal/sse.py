"""Server-sent events for live swarm runs.

Endpoint:
    GET /api/signal/runs/stream?market_id=<polymarket-id>
        text/event-stream — emits one SSE frame per agent belief, plus a
        final `result` frame with the aggregate consensus.

Compatible with native EventSource (no JS framework needed). The terminal
opens this connection from the right pane to render live swarm debate.

This intentionally lives outside `api.py` so the heavy `swarm_runner`
import only happens when SSE actually fires (lazy, keeps cold-start fast).
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import uuid

from flask import Blueprint, Response, request, stream_with_context

from . import polymarket, seed

log = logging.getLogger("meridian.signal.sse")

sse_bp = Blueprint("meridian_signal_sse", __name__, url_prefix="/api/signal")


def _sse_frame(event: str, data: dict) -> str:
    """Format a single text/event-stream frame."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@sse_bp.get("/runs/stream")
def stream_run():
    """Kick off a swarm run for `market_id` and stream agent turns live.

    Always uses SWARM_BACKEND=axl underneath — streaming only makes sense
    when there's a multi-agent debate to stream.
    """
    market_id = request.args.get("market_id", "").strip()
    if not market_id:
        return ({"error": "market_id required"}, 400)

    market = polymarket.get_market(market_id)
    if market is None:
        return ({"error": f"market not found: {market_id}"}, 404)

    seed_doc = seed.build_seed_document(market)
    run_id = str(uuid.uuid4())

    # Lazy import — keep cold paths cheap.
    from swarm_runner.orchestrator import stream_axl_swarm

    def _producer() -> "queue.Queue[dict | None]":
        """Drive the generator on a worker thread so the request stays alive."""
        q: queue.Queue[dict | None] = queue.Queue()

        def _drive() -> None:
            try:
                for evt in stream_axl_swarm(
                    seed_doc=seed_doc,
                    market_id=market.market_id,
                    outcomes=market.outcomes,
                ):
                    q.put(evt)
            except Exception as e:
                log.exception("swarm stream crashed: %s", e)
                q.put({"type": "error", "error": str(e), "ts": time.time()})
            finally:
                q.put(None)  # sentinel — generator complete

        threading.Thread(target=_drive, daemon=True, name=f"swarm-{run_id}").start()
        return q

    @stream_with_context
    def _gen():
        # Up-front handshake so curl shows the run is live before the first
        # belief lands (~30s on a 21-agent run).
        yield _sse_frame("run", {
            "run_id": run_id,
            "market_id": market.market_id,
            "slug": market.slug,
            "question": market.question,
            "outcomes": market.outcomes,
            "market_prices": market.outcome_prices,
            "ts": time.time(),
        })
        q = _producer()
        # Heartbeat every 15s so proxies / browsers don't time the connection
        # out while the swarm is still warming up.
        last = time.time()
        while True:
            try:
                evt = q.get(timeout=15)
            except queue.Empty:
                yield ":heartbeat\n\n"
                last = time.time()
                continue
            if evt is None:
                break
            evt_name = str(evt.get("type", "message"))
            yield _sse_frame(evt_name, evt)
            if evt_name == "result":
                # Generator emits result THEN sentinel — break early so the
                # final frame is flushed without waiting on the sentinel.
                continue

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",  # tell nginx not to buffer
        "Connection": "keep-alive",
    }
    return Response(_gen(), headers=headers)
