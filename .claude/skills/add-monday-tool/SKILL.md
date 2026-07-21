---
name: add-monday-tool
description: Add monday.com as an MCP tool (boards, items, updates, workspaces) using OneCLI-managed OAuth. monday.com is a first-class OneCLI app — no custom OAuth client needed. Env-var-only credential stub (no mounted files), since the MCP server takes its token via a single env var.
---

# Add monday.com Tool (OneCLI-native)

> **NanoClaw 2.1.53+ install seam:** global Node CLIs live in `container/cli-tools.json`. Add `{ "name": "@mondaydotcomorg/monday-api-mcp", "version": "3.2.0" }` there and validate with `src/monday-dockerfile.test.ts`; do not add `MONDAY_MCP_VERSION` or a pnpm global-install block to the Dockerfile. The later legacy Dockerfile snippets are retained only as historical context.

This skill wires [`@mondaydotcomorg/monday-api-mcp`](https://github.com/mondaycom/mcp) — monday.com's official MCP server — into selected agent groups. Unlike the Google-family skills (`/add-gmail-tool`, `/add-gcal-tool`), this server takes its credential as a single bearer token via the `monday_token` env var, not a pair of JSON files. The container passes the literal string `onecli-managed`; the OneCLI gateway (every agent container already routes outbound HTTP through it via `HTTPS_PROXY`) intercepts calls to `api.monday.com` and swaps in the real OAuth token from its vault at request time.

**monday.com is already a built-in OneCLI app** — `onecli apps get --provider monday` returns `"connectionType": "oauth"`, `"configurable": true` out of the box. There is no BYOC (bring-your-own-client) step: OneCLI is the registered OAuth client with monday.com, so connecting never requires this machine to accept an inbound connection. The whole flow runs through the local gateway UI (`http://127.0.0.1:10254`) and OneCLI's own hosted callback — see the pre-flight step below.

Tools exposed (from `monday-api-mcp@3.2.0`, surfaced to the agent as `mcp__monday__<name>`, exact set depends on `--mode`; default `api` mode covers boards/items/updates): run `tools/list` against the MCP server to enumerate the full, version-specific set.

**Why this pattern:** v2's invariant is that containers never receive raw API keys — OneCLI is the sole credential path (see CHANGELOG v2.0.0). Same stub mechanism `/add-gmail-tool` and `/add-gcal-tool` use, simplified because this server has no file-based credential store to stub.

## Phase 1: Pre-flight

### Verify OneCLI has monday.com connected

```bash
onecli apps get --provider monday
```

Expected: `"connection": { "status": "connected" }`.

If not connected, tell the user:

> Open the OneCLI web UI at http://127.0.0.1:10254, go to Apps → monday.com, and click Connect. Sign in with the monday.com account (and workspace) the agent should act as, and grant whatever scopes the connect screen requests. This never requires exposing this machine to the internet — the gateway UI runs on `127.0.0.1`, and the OAuth redirect completes on OneCLI's own hosted callback, not on this host. If you're on a headless/remote box, tunnel the UI instead of trying to expose a port: `ssh -L 10254:127.0.0.1:10254 <host>`, then open `http://127.0.0.1:10254` locally.

### No stub credential files needed

This server reads its token from a single env var (`monday_token`), auto-loaded at process start — there's no `~/.monday-mcp/` directory, no JSON key files, and no mount-allowlist change required. The stub is just the literal value `onecli-managed` passed inline via the MCP server's `--env` in Phase 3. (This is OneCLI's documented "Pattern D" for env-var-only tools — see `https://onecli.sh/docs/guides/credential-stubs/general-app.md`.)

### Check agent secret-mode

For each target agent group, confirm OneCLI will inject the monday.com token:

```bash
onecli agents list
```

`secretMode: all` is sufficient. If `selective`, explicitly assign the monday.com secret using the safe merge pattern (`set-secrets` replaces the entire list — always read first):

```bash
MONDAY_IDS=$(onecli secrets list | jq -r '[.data[] | select(.name | test("(?i)monday")) | .id] | join(",")')
CURRENT=$(onecli agents secrets --id <agent-id> | jq -r '[.data[]] | join(",")')
MERGED=$(printf '%s' "$CURRENT,$MONDAY_IDS" | tr ',' '\n' | sort -u | paste -sd ',' -)
onecli agents set-secrets --id <agent-id> --secret-ids "$MERGED"
onecli agents secrets --id <agent-id>
```

## Phase 2: Apply Code Changes

### Check if already applied

```bash
grep -q 'MONDAY_MCP_VERSION' container/Dockerfile && \
echo "ALREADY APPLIED — skip to Phase 3"
```

### Copy the dependency-guard test into the container tree

`@mondaydotcomorg/monday-api-mcp` is a stdio CLI installed globally in the image, not an imported module, so `tsc` and the runtime tests never reference it — only the Dockerfile edit proves it's present. `cp` overwrites in place, so re-running this skill is safe.

```bash
cp .claude/skills/add-monday-tool/monday-dockerfile.test.ts src/monday-dockerfile.test.ts
```

### Add MCP server to Dockerfile

Edit `container/Dockerfile`. Find the pinned-version ARG block (alongside `GMAIL_MCP_VERSION` / `CALENDAR_MCP_VERSION`):

```dockerfile
ARG GMAIL_MCP_VERSION=1.1.11
ARG CALENDAR_MCP_VERSION=2.6.1
ARG GWORKSPACE_MCP_VERSION=1.0.2
```

Add a new line:

```dockerfile
ARG MONDAY_MCP_VERSION=3.2.0
```

Then find the shared pnpm global-install block that installs the other MCP servers and append the monday package to it:

```dockerfile
RUN --mount=type=cache,target=/root/.cache/pnpm \
    pnpm install -g \
        "@gongrzhe/server-gmail-autoauth-mcp@${GMAIL_MCP_VERSION}" \
        "@cocal/google-calendar-mcp@${CALENDAR_MCP_VERSION}" \
        "@alanse/mcp-server-google-workspace@${GWORKSPACE_MCP_VERSION}" \
        "@mondaydotcomorg/monday-api-mcp@${MONDAY_MCP_VERSION}" \
        "zod-to-json-schema@3.22.5"
```

**Pin, don't float.** `3.2.0` was chosen deliberately over the newest `3.3.0` at time of writing — `3.3.0` was published within the last 3 days and `minimumReleaseAge: 4320` in `pnpm-workspace.yaml` will refuse to resolve it anyway. Check `npm view @mondaydotcomorg/monday-api-mcp time --json` before bumping this ARG, and don't bypass the gate via `minimumReleaseAgeExclude` without explicit human sign-off (see CLAUDE.md, Supply Chain Security).

The installed binary is `mcp-server-monday-api` (from the package's `bin` field) — that's the `--command` value used in Phase 3, not the npm package name.

`container/agent-runner/src/providers/claude.ts` derives the allow-pattern dynamically from each group's `mcpServers` map (`Object.keys(this.mcpServers).map(mcpAllowPattern)`), so registering `monday` in Phase 3 automatically allows `mcp__monday__*` — no code change needed for that part.

### Rebuild the container image

```bash
./container/build.sh
```

### Validate

```bash
pnpm exec vitest run src/monday-dockerfile.test.ts
```

## Phase 3: Wire Per-Agent-Group

For each agent group that should have monday.com (ask the user which ones), register the MCP server in the **central DB** (`data/v2.db`). This flows through `materializeContainerJson` on every spawn, so editing `groups/<folder>/container.json` by hand does **not** stick — that file is regenerated from the DB.

### List groups, pick which ones get monday.com

```bash
ncl groups list
```

### Register the MCP server

For each chosen `<group-id>`:

```bash
ncl groups config add-mcp-server \
  --id <group-id> \
  --name monday \
  --command mcp-server-monday-api \
  --args '[]' \
  --env '{"monday_token":"onecli-managed"}'
```

Approval behaviour depends on where you run it: from inside an agent's container `ncl` write verbs are approval-gated (admin approves before it lands); from a host operator shell with full scope, it executes immediately. Either way, the response tells you which path it took.

No mount step — unlike Gmail/Calendar, there's no credential directory to mount, since the whole stub is the one inline env var above.

## Phase 4: Build and Restart

```bash
pnpm run build
```

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
systemctl --user restart $(systemd_unit)              # Linux
```

Kill any existing agent containers so they respawn with the new `mcpServers` config:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

### Check for a pinned per-group image (easy to miss)

If a group ever went through the self-mod `install_packages` flow (or `ncl groups config add-package`), it has its own image tag pinned in the DB that **permanently overrides `:latest`** — rebuilding `container/Dockerfile` and running `./container/build.sh` does nothing for that group until its per-group image is also rebuilt:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT agent_group_id, image_tag FROM container_configs WHERE image_tag IS NOT NULL;"
```

For each `<group-id>` listed, rebuild its per-group image (re-derives `FROM` the current `:latest`, so it picks up `monday-api-mcp` too):

```bash
ncl groups restart --id <group-id> --rebuild
```

Groups with no row in that query already run `:latest` directly and need nothing extra here — killing the container (previous step) is enough. Skipping this check is the most likely way this skill silently "does nothing": the MCP server config registers fine, `container/Dockerfile` builds fine, but the actual running container never gets the binary, and the agent's own tool-call failure tends to read like an auth problem (misleadingly), not a missing-binary problem.

## Phase 5: Verify

### Test from a wired agent

> Send: **"what boards do I have on monday.com?"** or **"show me items on board X assigned to me"**.
>
> First call takes 2–3s while the MCP server starts and OneCLI does the token exchange.
>
> If the agent reports something like "not authenticated" with monday.com already showing `connected` in `onecli apps get --provider monday`, don't assume it's a real credential problem — check first whether that group's container is actually running an image with `mcp-server-monday-api` installed (see the per-group image check above): `docker inspect <container-name> --format '{{.Config.Image}}'`, then `docker run --rm --entrypoint sh <that-image> -c 'command -v mcp-server-monday-api'`.

### Check logs if the tool isn't working

```bash
tail -100 logs/nanoclaw.log logs/nanoclaw.error.log | grep -iE 'monday|mcp'
```

Common signals:

- `command not found: mcp-server-monday-api` → image not rebuilt, or the Dockerfile edit used the npm package name instead of the `bin` name.
- `401`/`403` from `api.monday.com` → OneCLI isn't injecting. Check the agent's secret mode (`onecli agents secrets --id <agent-id>`) and that monday.com is connected (`onecli apps get --provider monday`).
- Agent says "I don't have monday.com tools" → the `monday` MCP server isn't registered in this group's `mcpServers` (re-run the `ncl groups config add-mcp-server` step in Phase 3 for that group and restart it), or the agent-runner image is stale (`./container/build.sh`, `--no-cache` if suspicious).

## Removal

See [REMOVE.md](REMOVE.md) — unregisters the MCP server, deletes the copied test, reverts the Dockerfile edit, and rebuilds.

## Credits & references

- **MCP server:** [`@mondaydotcomorg/monday-api-mcp`](https://github.com/mondaycom/mcp) — monday.com's official MCP server package.
- **OneCLI credential stubs:** env-var-only pattern ("Pattern D") documented at `https://onecli.sh/docs/guides/credential-stubs/general-app.md`.
- **Skill pattern:** direct sibling of [`/add-gmail-tool`](../add-gmail-tool/SKILL.md) and [`/add-gcal-tool`](../add-gcal-tool/SKILL.md); simplified because monday.com's OAuth is OneCLI-native (no BYOC) and its MCP server has no file-based credential store to stub.
