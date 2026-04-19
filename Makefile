# MERIDIAN dev orchestration.
#
# Targets boot the four hackathon services in the right order:
#   cogito      (Bun, :5003)   — TS/WASM sidecar (0G + Bridge Kit + cofhejs)
#   signal      (Flask, :5002) — Polymarket scanner + swarm gateway
#   execution   (Flask, :5004) — burner + bridge + CLOB + dashboard
#   orchestrator                — autonomous loop (depends on the three above)
#
# `make demo` boots the three sidecars in the background, runs one orchestrator
# tick, then leaves them up so you can poke the dashboard at :5004/.
# `make stop` cleans up.

SHELL := /bin/bash

ROOT       := $(shell pwd)
PIDDIR     := $(ROOT)/.run
LOGDIR     := $(ROOT)/.log
ENV_FILE   := $(ROOT)/.env

.PHONY: help install install-services install-cogito install-contracts \
        cogito signal execution orchestrator-once orchestrator-loop orchestrator-dry \
        demo stop status \
        contracts-test typecheck \
        smoke-keeperhub \
        clean

help:
	@echo "MERIDIAN make targets:"
	@echo "  install            uv sync + bun install + forge install"
	@echo "  demo               boot cogito + signal + execution, run one orchestrator tick"
	@echo "  cogito             run cogito sidecar (foreground)"
	@echo "  signal             run signal-gateway (foreground)"
	@echo "  execution          run execution-router + dashboard (foreground)"
	@echo "  orchestrator-once  single orchestrator tick"
	@echo "  orchestrator-loop  daemon orchestrator loop"
	@echo "  orchestrator-dry   daemon orchestrator loop (no /open calls)"
	@echo "  contracts-test     forge test --via-ir"
	@echo "  typecheck          tsc --noEmit (cogito only)"
	@echo "  stop               kill anything started by 'make demo'"
	@echo "  status             print pids + ports"
	@echo "  clean              remove .run/ .log/ caches"

# ── install ───────────────────────────────────────────────────────────────────

install: install-services install-cogito install-contracts

install-services:
	cd services && uv sync

install-cogito:
	cd services/cogito && bun install

install-contracts:
	cd contracts && forge install

# ── individual services (foreground) ──────────────────────────────────────────

cogito:
	cd services/cogito && bun --env-file=$(ENV_FILE) run src/index.ts

signal:
	cd services && uv run --env-file $(ENV_FILE) python -m meridian_signal.api

execution:
	cd services && uv run --env-file $(ENV_FILE) python -m execution_router.api

orchestrator-once:
	cd services && uv run --env-file $(ENV_FILE) python -m orchestrator once

orchestrator-loop:
	cd services && uv run --env-file $(ENV_FILE) python -m orchestrator

orchestrator-dry:
	cd services && uv run --env-file $(ENV_FILE) python -m orchestrator dry

# ── one-shot demo ─────────────────────────────────────────────────────────────

$(PIDDIR):
	@mkdir -p $(PIDDIR)

$(LOGDIR):
	@mkdir -p $(LOGDIR)

demo: $(PIDDIR) $(LOGDIR)
	@if [ ! -f $(ENV_FILE) ]; then echo "ERROR: $(ENV_FILE) missing — copy .env.example first"; exit 1; fi
	@echo "▶ booting cogito (logs: $(LOGDIR)/cogito.log) …"
	@cd services/cogito && bun --env-file=$(ENV_FILE) run src/index.ts > $(LOGDIR)/cogito.log 2>&1 & echo $$! > $(PIDDIR)/cogito.pid
	@echo "▶ booting signal-gateway (logs: $(LOGDIR)/signal.log) …"
	@cd services && uv run --env-file $(ENV_FILE) python -m meridian_signal.api > $(LOGDIR)/signal.log 2>&1 & echo $$! > $(PIDDIR)/signal.pid
	@echo "▶ booting execution-router (logs: $(LOGDIR)/execution.log) …"
	@cd services && uv run --env-file $(ENV_FILE) python -m execution_router.api > $(LOGDIR)/execution.log 2>&1 & echo $$! > $(PIDDIR)/execution.pid
	@echo "⏳ waiting 6s for sidecars to bind ports …"
	@sleep 6
	@echo "▶ orchestrator: one tick"
	@cd services && uv run --env-file $(ENV_FILE) python -m orchestrator once || true
	@echo
	@echo "✔ demo running. Dashboard: http://127.0.0.1:5004/"
	@echo "  cogito:    http://127.0.0.1:5003/health"
	@echo "  signal:    http://127.0.0.1:5002/health"
	@echo "  execution: http://127.0.0.1:5004/health"
	@echo "  Stop with: make stop"

stop:
	@if [ -d $(PIDDIR) ]; then \
	  for f in $(PIDDIR)/*.pid; do \
	    [ -f $$f ] || continue; \
	    pid=$$(cat $$f); \
	    if kill -0 $$pid 2>/dev/null; then \
	      echo "▷ killing $$(basename $$f .pid) (pid $$pid)"; \
	      kill $$pid; \
	    fi; \
	    rm -f $$f; \
	  done; \
	fi
	@echo "✔ stopped"

status:
	@echo "── pids ──"
	@for f in $(PIDDIR)/*.pid; do \
	  [ -f $$f ] || continue; \
	  pid=$$(cat $$f); \
	  state=$$(kill -0 $$pid 2>/dev/null && echo running || echo dead); \
	  echo "  $$(basename $$f .pid): $$pid ($$state)"; \
	done
	@echo "── ports ──"
	@lsof -iTCP:5002,5003,5004 -sTCP:LISTEN -nP 2>/dev/null | tail -n +2 || echo "  (none listening)"

# ── verification ──────────────────────────────────────────────────────────────

contracts-test:
	cd contracts && forge test --via-ir -vv

typecheck:
	cd services/cogito && bun run typecheck

# Submits Multicall3.aggregate3([]) on Arbitrum Sepolia via KeeperHub.
# Requires KEEPERHUB_API_KEY in .env (KEEPERHUB_NETWORK defaults to 421614).
# Writes proof tx hash to docs/proof/keeperhub.md.
smoke-keeperhub:
	cd services && uv run --env-file $(ENV_FILE) python -m execution_router.scripts.smoke_keeperhub

# ── housekeeping ──────────────────────────────────────────────────────────────

clean: stop
	rm -rf $(PIDDIR) $(LOGDIR)
	cd services/cogito && rm -rf node_modules .cache
	cd contracts && forge clean
