#!/usr/bin/env bash
# redeploy-pinata-agent.sh — apply MiroShark overlay to a freshly-deployed
# Pinata "MoonPay Prediction Market Trader" agent.
#
# Use this when:
#   - the previous agent's trial expired and got deleted
#   - you redeploy from the template for any reason
#   - you forked our overlay into a published Pinata template and want to
#     bootstrap a new instance
#
# Usage:
#   ./redeploy-pinata-agent.sh <AGENT_ID> <GIT_TOKEN>
# or via env:
#   AGENT_ID=xxx PINATA_GIT_TOKEN=yyy ./redeploy-pinata-agent.sh
#
# What it does:
#   1. Clones the fresh agent's git workspace to .context/pinata-agent-<id>/
#   2. Copies every file from apps/app/scripts/pinata-agent-overlay/ over
#      the clone (preserves agent-state files, replaces our 7 source files)
#   3. Commits with a clear message
#   4. Pushes to the agent's git remote
#   5. Prints the secrets the operator must set in the Pinata dashboard
#
# What it does NOT do:
#   - Deploy the template (you do that in the Pinata dashboard or CLI)
#   - Set the secrets (you do that — they're sensitive, not in this repo)
#   - Wake the agent (it picks up the push on next heartbeat)
#
# Idempotent: if you run it twice with the same AGENT_ID, the second run is
# a no-op (overlay files already there, nothing to commit).

set -euo pipefail

AGENT_ID="${1:-${AGENT_ID:-}}"
GIT_TOKEN="${2:-${PINATA_GIT_TOKEN:-}}"

if [ -z "$AGENT_ID" ] || [ -z "$GIT_TOKEN" ]; then
  cat <<EOF >&2
usage: $0 <AGENT_ID> <GIT_TOKEN>
  or:  AGENT_ID=xxx PINATA_GIT_TOKEN=yyy $0

  AGENT_ID  : Pinata agent id (e.g. xt1sgi73). Find at the top-left of the
              agent dashboard, or via 'pinata agents list'.
  GIT_TOKEN : Per-agent git access token. Find under 'Git Access' in the
              agent's dashboard, or generate via 'pinata agents git-token'.

EOF
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OVERLAY="$REPO_ROOT/apps/app/scripts/pinata-agent-overlay"
CLONE_DIR="$REPO_ROOT/.context/pinata-agent-$AGENT_ID"

if [ ! -d "$OVERLAY" ]; then
  echo "ERROR: overlay missing at $OVERLAY" >&2
  exit 2
fi

mkdir -p "$REPO_ROOT/.context"

if [ -d "$CLONE_DIR/.git" ]; then
  echo "[skip clone] $CLONE_DIR already exists; pulling latest"
  git -C "$CLONE_DIR" fetch origin >/dev/null 2>&1 || true
  git -C "$CLONE_DIR" pull --rebase origin main >/dev/null 2>&1 || true
else
  echo "[clone] agents.pinata.cloud/v0/agents/$AGENT_ID/git -> $CLONE_DIR"
  git clone "https://pinata:${GIT_TOKEN}@agents.pinata.cloud/v0/agents/${AGENT_ID}/git" "$CLONE_DIR" 2>&1 \
    | grep -vE "^Cloning into" || true
fi

# Apply overlay. Preserve agent-state files (HEARTBEAT.md, IDENTITY.md if the
# agent has personalized them, MEMORY.md, memory/, book.md, etc).
echo "[overlay] copying $OVERLAY/ -> $CLONE_DIR/"
mkdir -p "$CLONE_DIR/workspace/skills"
cp "$OVERLAY/manifest.json"                  "$CLONE_DIR/manifest.json"
cp "$OVERLAY/workspace/MIROSHARK.md"         "$CLONE_DIR/workspace/MIROSHARK.md"
cp "$OVERLAY/workspace/skills/miroshark.md"  "$CLONE_DIR/workspace/skills/miroshark.md"
cp "$OVERLAY/workspace/AGENTS.md"            "$CLONE_DIR/workspace/AGENTS.md"
cp "$OVERLAY/workspace/SOUL.md"              "$CLONE_DIR/workspace/SOUL.md"
cp "$OVERLAY/workspace/TOOLS.md"             "$CLONE_DIR/workspace/TOOLS.md"
cp "$OVERLAY/workspace/USER.md"              "$CLONE_DIR/workspace/USER.md"

cd "$CLONE_DIR"

if git diff --quiet && git diff --staged --quiet && [ -z "$(git ls-files --others --exclude-standard)" ]; then
  echo "[noop] overlay already applied — nothing to commit"
else
  git add -A
  git -c user.email=tomas.cordero.esp@gmail.com -c user.name="Tomas (MiroShark)" commit -m "feat: integrate MiroShark execution rail (overlay)

Applied via apps/app/scripts/redeploy-pinata-agent.sh from
apps/app/scripts/pinata-agent-overlay/ in the MiroShark repo.
See workspace/MIROSHARK.md for the full briefing."
  echo "[push] -> origin/main"
  git push origin HEAD 2>&1 | grep -vE "^remote:|^To " || true
fi

cat <<EOF

──────────────────────────────────────────────────────────────────────────────
✓ Agent $AGENT_ID overlaid with MiroShark integration.

NEXT — set these secrets in the Pinata agent dashboard
(Settings → Secrets → Add):

  MIROSHARK_SIGNAL_URL    → ngrok URL for signal-gateway (:5002)
  MIROSHARK_EXECUTION_URL → ngrok URL for execution-router (:5004)
  MIROSHARK_COGITO_URL    → ngrok URL for cogito (:5003)
  MIROSHARK_API_TOKEN     → matches MIROSHARK_AGENT_TOKEN in your .env
                            (generate: openssl rand -hex 32)
  MIROSHARK_TENANT_ID     → "default"

The agent picks up the new instructions on its next heartbeat
(typically within a minute). To force an immediate reload, send any
message to @miro_shark_bot or open the chat in the operator UI.

NEXT — update MiroShark side
  bun run --cwd apps/app scripts/seed-pinata-state.mjs
to point the operator-terminal pill + chat panel at this fresh agent.
──────────────────────────────────────────────────────────────────────────────
EOF
