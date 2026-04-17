"""MERIDIAN signal-gateway + market-scanner sidecar.

Phase 1 of BUILD_PLAN: turn a Polymarket market_id into a structured swarm signal.
Phase 2 swaps the single-LLM swarm-lite for AXL multi-agent. Phase 3 routes inference
through 0G. The HTTP contract here is stable across phases.
"""

__version__ = "0.1.0"
