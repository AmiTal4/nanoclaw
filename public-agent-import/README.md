# Public Agent — Restrictions & Setup

This package documents all software restrictions applied to the NanoClaw v2 **public** agent group and how to reproduce them.

---

## Restrictions Applied

### 1. Disabled Tools (`disabled_tools`)

The following Claude Code tools are removed from the model's `allowedTools` list entirely — the model never sees them and cannot call them:

| Tool | Category |
|---|---|
| `Bash` | Shell execution |
| `Read` | File access |
| `Glob` | File access |
| `Grep` | File access |
| `Write` | File writing |
| `Edit` | File writing |
| `NotebookEdit` | File writing |
| `TodoWrite` | File writing |
| `Task` | Task orchestration |
| `TaskOutput` | Task orchestration |
| `TaskStop` | Task orchestration |
| `ToolSearch` | Tool discovery |

**Tools remaining available:** `WebSearch`, `WebFetch`, `TeamCreate`, `TeamDelete`, `SendMessage`, `Skill`

**Where enforced:** `container/agent-runner/src/providers/claude.ts` — `allowedTools` filter in `ClaudeProvider.query()`.

---

### 2. Block Local WebFetch (`block_local_web_fetch`)

`WebFetch` calls are blocked at the pre-tool-use hook level when the target URL's hostname is a local or private network address. This prevents the public agent from reaching NanoClaw's host services, OneCLI, the Docker bridge network, etc.

**Blocked hostnames / ranges:**

| Pattern | Covers |
|---|---|
| `localhost` | Container loopback name |
| `127.x.x.x` | IPv4 loopback range |
| `::1` / `[::1]` | IPv6 loopback |
| `host.docker.internal` | Docker host alias |
| `0.0.0.0` | Wildcard address |
| `10.x.x.x` | Private class A |
| `172.16–31.x.x` | Private class B (incl. Docker bridge `172.17.x.x`) |
| `192.168.x.x` | Private class C |
| `169.254.x.x` | Link-local / AWS metadata |

**Where enforced:** Pre-tool-use hook in `container/agent-runner/src/providers/claude.ts` — `createPreToolUseHook(blockLocalWebFetch)`.

---

### 3. CLI Scope (`cli_scope = 'group'`)

The agent's access to `ncl` (the NanoClaw admin CLI) is scoped to its own agent group only. It cannot:
- Query or modify other agent groups
- Change its own `cli_scope`
- Access global admin operations

**Where enforced:** `src/cli/dispatch.ts` — scope check on every `cli_request`.

---

### 4. Command Gate (global, not per-group)

These are host-level restrictions that apply to **all** agents, including public:

| Class | Commands | Behaviour |
|---|---|---|
| Filtered (silently dropped) | `/help`, `/login`, `/logout`, `/doctor`, `/config`, `/remote-control` | Never reach the container |
| Admin-only | `/clear`, `/compact`, `/context`, `/cost`, `/files`, `/upload-trace` | Allowed only for owner/admin roles |

**Where enforced:** `src/command-gate.ts`

---

## How to Apply to a New Agent Group

### Prerequisites

1. NanoClaw v2 installed and `data/v2.db` exists.
2. The `block_local_web_fetch` code changes are present:
   - `src/db/migrations/018-container-config-block-local-web.ts`
   - `src/types.ts` — `ContainerConfigRow.block_local_web_fetch`
   - `src/container-config.ts` — `ContainerConfig.blockLocalWebFetch`
   - `src/backfill-container-configs.ts` — default `0`
   - `container/agent-runner/src/config.ts` — `RunnerConfig.blockLocalWebFetch`
   - `container/agent-runner/src/providers/types.ts` — `ProviderOptions.blockLocalWebFetch`
   - `container/agent-runner/src/providers/claude.ts` — `isLocalUrl()` + `createPreToolUseHook()`
   - `container/agent-runner/src/index.ts` — passes `blockLocalWebFetch` to provider
3. Run `pnpm run build` to compile the host TypeScript.
4. Run the migration (once, on first boot after code changes):
   ```bash
   pnpm exec tsx -e "
   import Database from 'better-sqlite3';
   import { runMigrations } from './src/db/migrations/index.ts';
   const db = new Database('./data/v2.db');
   runMigrations(db);
   db.close();
   "
   ```

### Apply Restrictions

```bash
./apply.sh <agent_group_id>
```

Or manually:

```bash
# Replace <AGENT_GROUP_ID> with the target group's ID
DB="data/v2.db"
AGENT_GROUP_ID="<AGENT_GROUP_ID>"

# 1. Disable file/shell/task/search tools
pnpm exec tsx scripts/q.ts "$DB" \
  "UPDATE container_configs SET disabled_tools = '[\"Bash\",\"Read\",\"Write\",\"Edit\",\"Glob\",\"Grep\",\"Task\",\"TaskOutput\",\"TaskStop\",\"TodoWrite\",\"ToolSearch\",\"NotebookEdit\"]' WHERE agent_group_id = '$AGENT_GROUP_ID'"

# 2. Block WebFetch to local/private addresses
pnpm exec tsx scripts/q.ts "$DB" \
  "UPDATE container_configs SET block_local_web_fetch = 1 WHERE agent_group_id = '$AGENT_GROUP_ID'"

# 3. Restart the container so changes take effect
ncl groups restart --id "$AGENT_GROUP_ID"
```

### Set the Agent Prompt

Copy `agent-prompt.md` into the group's `CLAUDE.local.md`:

```bash
cp agent-prompt.md groups/<folder>/CLAUDE.local.md
```

The `<folder>` for the current public agent group is `public`. For a new group, find the folder via:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT folder FROM agent_groups WHERE id = '$AGENT_GROUP_ID'"
```

---

## Verification

After applying:

```bash
# Confirm DB values
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT agent_group_id, cli_scope, disabled_tools, block_local_web_fetch FROM container_configs WHERE agent_group_id = '$AGENT_GROUP_ID'"

# Expected output:
# <id>|group|["Bash","Read","Write","Edit","Glob","Grep","Task","TaskOutput","TaskStop","TodoWrite","ToolSearch","NotebookEdit"]|1
```
