"""Orchestrator CLI.

Usage:
    uv run python -m orchestrator                # daemon loop, interval from env
    uv run python -m orchestrator once           # single tick, print summary, exit
    uv run python -m orchestrator dry            # daemon, never hit /open
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from dotenv import load_dotenv

from .loop import LoopConfig, Orchestrator


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    env_path = Path(__file__).resolve().parents[2] / ".env"
    if env_path.exists():
        load_dotenv(env_path, override=True)

    cfg = LoopConfig.from_env()
    mode = sys.argv[1] if len(sys.argv) > 1 else "loop"

    if mode == "once":
        orch = Orchestrator(cfg)
        orch.hydrate_from_router()
        summary = orch.tick()
        print(json.dumps(summary, indent=2, default=str))
        return
    if mode == "dry":
        cfg.dry_run = True

    Orchestrator(cfg).run_forever()


if __name__ == "__main__":
    main()
