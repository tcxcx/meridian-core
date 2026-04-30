# MIROSHARK dev orchestration.
#
# Targets boot the integrated stack in the right order:
#   app         (Next.js, :3000) — unified Miroshark operator terminal
#   cogito      (Bun, :5003)   — TS/WASM sidecar (0G + Bridge Kit + cofhejs)
#   signal      (Flask, :5002) — Polymarket scanner + swarm gateway
#   execution   (Flask, :5004) — burner + bridge + CLOB + API surface
#   orchestrator                — autonomous loop (depends on the three above)
#
# `make demo` boots the app and sidecars in the background, runs one orchestrator
# tick, then leaves them up so you can poke the operator terminal at :3000/.
# `make stop` cleans up.

SHELL := /bin/bash

ROOT       := $(shell pwd)
PIDDIR     := $(ROOT)/.run
LOGDIR     := $(ROOT)/.log
ENV_FILE   := $(ROOT)/.env

.PHONY: help install install-services install-cogito install-contracts \
        app cogito signal execution orchestrator-once orchestrator-loop orchestrator-dry \
        demo stop status \
        contracts-test typecheck \
        smoke-keeperhub preflight e2e-real \
        clean

help:
	@echo "MIROSHARK make targets:"
	@echo "  install            uv sync + bun install + forge install"
	@echo "  demo               boot app + cogito + signal + execution, run one orchestrator tick"
	@echo "  app                run the Next.js operator terminal (foreground)"
	@echo "  cogito             run cogito sidecar (foreground)"
	@echo "  signal             run signal-gateway (foreground)"
	@echo "  execution          run execution-router API (foreground)"
	@echo "  orchestrator-once  single orchestrator tick"
	@echo "  orchestrator-loop  daemon orchestrator loop"
	@echo "  orchestrator-dry   daemon orchestrator loop (no /open calls)"
	@echo "  contracts-test     forge test --via-ir"
	@echo "  typecheck          tsc --noEmit (cogito only)"
	@echo "  preflight          check which demo tier (T0-T6) the current .env unlocks"
	@echo "  e2e-real           preflight (require T4) → fire one real /open with \$$1 USDC"
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

app:
	npm run dev

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
	@echo "▶ booting app (logs: $(LOGDIR)/app.log) …"
	@npm run dev > $(LOGDIR)/app.log 2>&1 & echo $$! > $(PIDDIR)/app.pid
	@echo "▶ booting cogito (logs: $(LOGDIR)/cogito.log) …"
	@cd services/cogito && bun --env-file=$(ENV_FILE) run src/index.ts > $(LOGDIR)/cogito.log 2>&1 & echo $$! > $(PIDDIR)/cogito.pid
	@echo "▶ booting signal-gateway (logs: $(LOGDIR)/signal.log) …"
	@cd services && uv run --env-file $(ENV_FILE) python -m meridian_signal.api > $(LOGDIR)/signal.log 2>&1 & echo $$! > $(PIDDIR)/signal.pid
	@echo "▶ booting execution-router (logs: $(LOGDIR)/execution.log) …"
	@cd services && uv run --env-file $(ENV_FILE) python -m execution_router.api > $(LOGDIR)/execution.log 2>&1 & echo $$! > $(PIDDIR)/execution.pid
	@echo "⏳ waiting 8s for the integrated stack to bind ports …"
	@sleep 8
	@echo "▶ orchestrator: one tick"
	@cd services && uv run --env-file $(ENV_FILE) python -m orchestrator once || true
	@echo
	@echo "✔ demo running. Operator terminal: http://127.0.0.1:3000/"
	@echo "  app:       http://127.0.0.1:3000/"
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
	@lsof -iTCP:3000,5002,5003,5004 -sTCP:LISTEN -nP 2>/dev/null | tail -n +2 || echo "  (none listening)"

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

# ── readiness preflight ───────────────────────────────────────────────────────
#
# Probes every env var, every sidecar, every RPC, prints a green/red matrix
# grouped by tier (T0 dry-run → T6 full FHE). Exits 0 if everything green.
#
# Usage:
#   make preflight                 # report only
#   TIER=T3 make preflight         # exit 1 if any tier ≤ T3 incomplete
preflight:
	@if [ ! -f $(ENV_FILE) ]; then echo "ERROR: $(ENV_FILE) missing — copy .env.demo to .env first"; exit 1; fi
	cd services && uv run --env-file $(ENV_FILE) python -m execution_router.scripts.preflight \
	  $(if $(TIER),--target $(TIER),)

# ── one real e2e position ─────────────────────────────────────────────────────
#
# Requires T4 (preflight passes through Real Circle Gateway bridge), then fires
# a single $1 USDC position through the live state machine: signal → swarm →
# fundBurner → bridge → CLOB → audit. Survives partial failure: any exception
# is logged but the audit log + dashboard show exactly where it stopped.
#
# App and sidecars must already be running. Start them with `make demo` first.
e2e-real:
	@if [ ! -f $(ENV_FILE) ]; then echo "ERROR: $(ENV_FILE) missing"; exit 1; fi
	@echo "▶ preflight (require T4 ready) …"
	@cd services && uv run --env-file $(ENV_FILE) python -m execution_router.scripts.preflight --target T4 \
	  || (echo "✗ aborting e2e-real — fix the gaps above and re-run" && exit 1)
	@echo
	@echo "▶ firing one real /open with \$$1 USDC via orchestrator …"
	@cd services && ORCHESTRATOR_USDC_PER_POSITION=1.0 ORCHESTRATOR_MAX_POSITIONS=1 \
	  uv run --env-file $(ENV_FILE) python -m orchestrator once
	@echo
	@echo "✔ e2e-real complete. Inspect:"
	@echo "  Terminal:   http://127.0.0.1:3000/"
	@echo "  Positions:  curl -s http://127.0.0.1:5004/api/execution/positions | jq ."
	@echo "  Audit log:  curl -s 'http://127.0.0.1:5004/api/execution/audit?limit=20' | jq ."

# ── housekeeping ──────────────────────────────────────────────────────────────

clean: stop
	rm -rf $(PIDDIR) $(LOGDIR)
	cd services/cogito && rm -rf node_modules .cache
	cd contracts && forge clean
