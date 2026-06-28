#!/usr/bin/env bash
# Apply all public-agent restrictions to a NanoClaw v2 agent group.
#
# Usage:
#   ./apply.sh <agent_group_id>
#
# Example:
#   ./apply.sh 621a9ed3-0de5-4606-a3a0-e896625ce2e1
#
# Prerequisites:
#   - Run from the nanoclaw-v2 root directory
#   - pnpm dependencies installed
#   - data/v2.db must exist (nanoclaw has been initialised)
#   - The block_local_web_fetch code changes must be present (see README.md)

set -euo pipefail

AGENT_GROUP_ID="${1:-}"
if [[ -z "$AGENT_GROUP_ID" ]]; then
  echo "Usage: $0 <agent_group_id>" >&2
  exit 1
fi

DB="data/v2.db"

echo "Applying restrictions to agent group: $AGENT_GROUP_ID"

# ── 1. Disabled tools ──────────────────────────────────────────────────────
echo "  Setting disabled_tools..."
pnpm exec tsx scripts/q.ts "$DB" \
  "UPDATE container_configs
   SET disabled_tools = '[\"Bash\",\"Read\",\"Write\",\"Edit\",\"Glob\",\"Grep\",\"Task\",\"TaskOutput\",\"TaskStop\",\"TodoWrite\",\"ToolSearch\",\"NotebookEdit\"]'
   WHERE agent_group_id = '$AGENT_GROUP_ID'"

# ── 2. Block local web fetch ───────────────────────────────────────────────
echo "  Setting block_local_web_fetch..."
pnpm exec tsx scripts/q.ts "$DB" \
  "UPDATE container_configs
   SET block_local_web_fetch = 1
   WHERE agent_group_id = '$AGENT_GROUP_ID'"

# ── 3. Verify ─────────────────────────────────────────────────────────────
echo ""
echo "Result:"
pnpm exec tsx scripts/q.ts "$DB" \
  "SELECT agent_group_id, cli_scope, disabled_tools, block_local_web_fetch
   FROM container_configs
   WHERE agent_group_id = '$AGENT_GROUP_ID'"

echo ""
echo "Done. Restart the agent group container for changes to take effect:"
echo "  ncl groups restart --id $AGENT_GROUP_ID"
