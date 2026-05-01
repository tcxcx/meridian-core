#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

keepalive() {
  while true; do
    sleep 3600
  done
}

run_or_reuse() {
  local name="$1"
  local port="$2"
  local color="$3"
  shift 3
  local command="$*"

  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    printf '[%s] reusing existing listener on :%s\n' "$name" "$port"
    printf '[%s] keepalive placeholder active\n' "$name"
    keepalive
    return
  fi

  printf '[%s] starting on :%s\n' "$name" "$port"
  exec bash -lc "$command"
}

if [[ "${1:-}" == "run-one" ]]; then
  shift
  run_or_reuse "$@"
  exit 0
fi

exec concurrently \
  --kill-others-on-fail \
  -n "backend,signal,cogito,execution,app,web,api" \
  -c "green,magenta,red,blue,cyan,yellow,white" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one backend 5001 green 'cd \"$ROOT_DIR/backend\" && FLASK_HOST=127.0.0.1 uv run python run.py'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one signal 5002 magenta 'cd \"$ROOT_DIR/services\" && uv run --env-file ../.env python -m meridian_signal.api'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one cogito 5003 red 'cd \"$ROOT_DIR/services/cogito\" && bun run start'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one execution 5004 blue 'cd \"$ROOT_DIR/services\" && uv run --env-file ../.env python -m execution_router.api'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one app 3301 cyan 'cd \"$ROOT_DIR\" && bun run --cwd apps/app dev -- --port 3301'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one web 3302 yellow 'cd \"$ROOT_DIR\" && bun run --cwd apps/web dev -- --port 3302'" \
  "bash \"$ROOT_DIR/scripts/dev-complete.sh\" run-one api 3303 white 'cd \"$ROOT_DIR\" && bun run --cwd apps/api dev -- --port 3303'"
