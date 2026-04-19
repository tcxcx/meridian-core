"""MERIDIAN autonomous orchestrator.

Polls signal-gateway for scored markets, picks the highest-edge signal,
and hands it to the execution-router. This is the Phase-5 "autonomy"
surface — the thing that, left running, makes MERIDIAN actually trade.
"""
